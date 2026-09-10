import { describe, expect, it, vi } from 'vitest';
import { onDialerAmd, onDialerStatus } from './dialer.js';
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
    todayIso: '2026-07-13',
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
