import { describe, expect, it, vi } from 'vitest';
import { endConnectOnTerminalStatus, onDialerAmd, onDialerRecording, onDialerStatus } from './dialer.js';
import type { EngineDeps } from '../dialer/engine.js';

// Minimal fake EngineDeps: onDialerAmd/onDialerStatus only ever touch
// `deps.telephony.hangup` directly (the rest of `deps` is opaque — it's just
// forwarded, unread, into the injected `runHandleDialOutcome` fake below), so
// every other field is a throwing stub that fails the test loudly if the
// handler ever reaches into it.
function fakeDeps(over: Partial<EngineDeps> = {}): EngineDeps {
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected use of EngineDeps.${name} in the webhook handler`);
  };
  return {
    db: undefined as unknown as EngineDeps['db'],
    telephony: {
      originate: vi.fn(unexpected('telephony.originate')),
      bridgeToRep: vi.fn(unexpected('telephony.bridgeToRep')),
      hangup: vi.fn(async () => {}),
      // Only here to satisfy the DialerTelephony interface. These tests inject a
      // fake `runHandleDialOutcome`, so the real
      // handleDialOutcome -> advanceSession -> endConference chain never runs in
      // this file; that path is covered in dialer/engine.test.ts.
      endConference: vi.fn(async () => {}),
    },
    pickDid: vi.fn(unexpected('pickDid')) as unknown as EngineDeps['pickDid'],
    withinCallingHours: vi.fn(unexpected('withinCallingHours')) as unknown as EngineDeps['withinCallingHours'],
    nowUtc: new Date('2026-07-13T18:00:00Z'),
    enqueueRollover: vi.fn(async () => {}),
    onScreenPop: vi.fn(unexpected('onScreenPop')),
    onBridged: vi.fn(unexpected('onBridged')) as unknown as EngineDeps['onBridged'],
    todayIso: '2026-07-13',
    // Contact-cadence deps: the webhook handler forwards them unread, like the
    // rest, so they are throwing stubs too.
    contactHistory: vi.fn(unexpected('contactHistory')) as unknown as EngineDeps['contactHistory'],
    inFlightElsewhere: vi.fn(unexpected('inFlightElsewhere')) as unknown as EngineDeps['inFlightElsewhere'],
    isDailyCapped: vi.fn(unexpected('isDailyCapped')) as unknown as EngineDeps['isDailyCapped'],
    orgDayStart: new Date('2026-07-13T07:00:00Z'),
    ...over,
  };
}

describe('onDialerAmd', () => {
  it('AnsweredBy=machine_start stamps voicemail BEFORE hanging up, so the completed-status backstop finds the row settled', async () => {
    // `invocationCallOrder` alone only proves the two mocks were CALLED in
    // order — an implementation that dropped the `await` before
    // `runHandleDialOutcome` would still call hangup second even though the
    // stamp hadn't finished (settled) yet. Give the assertion teeth: the
    // outcome fake only flips `stamped` after a real tick, and the hangup fake
    // asserts `stamped` is already true when IT runs — that only holds if
    // `onDialerAmd` awaited the stamp to completion before hanging up.
    let stamped = false;
    const runHandleDialOutcome = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      stamped = true;
    });
    const deps = fakeDeps({
      telephony: {
        ...fakeDeps().telephony,
        hangup: vi.fn(async () => {
          expect(stamped).toBe(true);
        }),
      },
    });
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'machine_start' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'voicemail', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
  });

  it('AnsweredBy=machine_end_beep is voicemail too (every machine_* verdict)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'machine_end_beep' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'voicemail', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
  });

  it('AnsweredBy=fax stamps fax and hangs up', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'fax' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'fax', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
  });

  it('still hangs up a machine when stamping the outcome throws (the call must not play out its 30s hold)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => { throw new Error('db down'); });
    await expect(onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'machine_start' }, deps, runHandleDialOutcome)).rejects.toThrow('db down');
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
  });

  it('AnsweredBy=human does NOT hang up and reports connected', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'human' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'connected', deps);
  });

  it('AnsweredBy=unknown (or missing) does NOT hang up and reports connected (bias to human)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'connected', deps);
  });
});

describe('onDialerStatus', () => {
  it('CallStatus=no-answer reports no_answer (the only fallback-eligible miss)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', CallStatus: 'no-answer' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'no_answer', deps);
  });

  it.each([
    ['busy', 'busy'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
    ['completed', 'hangup'],
  ])('CallStatus=%s stamps %s (a plain miss — never falls back to the Phone)', async (status, reason) => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', CallStatus: status }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', reason, deps);
  });

  it('falls back to DialCallStatus when CallStatus is absent (no-answer → no_answer)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', DialCallStatus: 'no-answer' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'no_answer', deps);
  });

  it.each(['queued', 'ringing', 'in-progress', 'initiated', ''])(
    'a non-terminal status (%s) is a no-op — AMD/connect owns that transition',
    async (status) => {
      const deps = fakeDeps();
      const runHandleDialOutcome = vi.fn(async () => {});
      await onDialerStatus({ CallSid: 'CA1', CallStatus: status }, deps, runHandleDialOutcome);
      expect(runHandleDialOutcome).not.toHaveBeenCalled();
    },
  );

  it('never touches telephony directly — status alone drives the miss, no hangup needed', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', CallStatus: 'busy' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });
});

describe('endConnectOnTerminalStatus — the bridged-call hang-up stamp', () => {
  const SID = 'CA' + 'b'.repeat(32);
  const AT = new Date('2026-10-01T18:02:05Z');

  it('a terminal status stamps the connect row for that call sid — whatever the item says', async () => {
    const stamp = vi.fn(async () => []);
    await endConnectOnTerminalStatus({ CallSid: SID, CallStatus: 'completed' }, stamp, AT);
    expect(stamp).toHaveBeenCalledWith(SID, AT);
  });

  it('a non-terminal status or a malformed sid stamps nothing', async () => {
    const stamp = vi.fn(async () => []);
    await endConnectOnTerminalStatus({ CallSid: SID, CallStatus: 'in-progress' }, stamp, AT);
    await endConnectOnTerminalStatus({ CallSid: 'nope', CallStatus: 'completed' }, stamp, AT);
    expect(stamp).not.toHaveBeenCalled();
  });

  it('a failed stamp is logged, never thrown — Twilio still gets its 200', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      endConnectOnTerminalStatus({ CallSid: SID, CallStatus: 'completed' }, vi.fn(async () => { throw new Error('db down'); }), AT),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[dialer] connect end stamp failed', { err: 'db down' });
    error.mockRestore();
  });
});

describe('onDialerRecording — a finished power-dial recording', () => {
  const SID = 'CA' + 'c'.repeat(32);
  const CONNECT = '11111111-2222-4333-8444-555555555555';
  const MEDIA = 'https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123';
  const AT = new Date('2026-10-01T18:02:10Z');
  const done = { CallSid: SID, RecordingStatus: 'completed', RecordingUrl: MEDIA };

  it('stores the .mp3 media URL against our row id AND the call sid', async () => {
    const store = vi.fn(async () => [{ id: CONNECT }]);
    expect(await onDialerRecording(done, { connectId: CONNECT }, store, AT)).toBe('stored');
    expect(store).toHaveBeenCalledWith(CONNECT, SID, `${MEDIA}.mp3`, AT);
  });

  it('a row id whose call sid does not match is a mismatch — nothing is repointed', async () => {
    expect(await onDialerRecording(done, { connectId: CONNECT }, vi.fn(async () => []), AT)).toBe('mismatch');
  });

  it('ignores a bad row id, a bad call sid, a not-completed status (absent / in-progress), or a non-Twilio URL', async () => {
    const store = vi.fn(async () => [{ id: CONNECT }]);
    const cases: Array<[Record<string, string>, { connectId?: string }]> = [
      [done, {}],
      [done, { connectId: 'not-a-uuid' }],
      [{ ...done, CallSid: 'XX1' }, { connectId: CONNECT }],
      [{ ...done, RecordingStatus: 'absent' }, { connectId: CONNECT }],
      [{ ...done, RecordingStatus: 'in-progress' }, { connectId: CONNECT }],
      [{ ...done, RecordingUrl: 'https://evil.example/x' }, { connectId: CONNECT }],
      [{ CallSid: SID, RecordingStatus: 'completed' }, { connectId: CONNECT }],
    ];
    for (const [body, query] of cases) expect(await onDialerRecording(body, query, store, AT)).toBe('ignored');
    expect(store).not.toHaveBeenCalled();
  });
});
