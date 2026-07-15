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
    },
    pickDid: vi.fn(unexpected('pickDid')) as unknown as EngineDeps['pickDid'],
    withinCallingHours: vi.fn(unexpected('withinCallingHours')) as unknown as EngineDeps['withinCallingHours'],
    nowUtc: new Date('2026-07-13T18:00:00Z'),
    rolloverFollowUp: vi.fn(unexpected('rolloverFollowUp')) as unknown as EngineDeps['rolloverFollowUp'],
    onScreenPop: vi.fn(unexpected('onScreenPop')),
    todayIso: '2026-07-13',
    ...over,
  };
}

describe('onDialerAmd', () => {
  it('AnsweredBy=machine_start hangs up the call and reports no_connect', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'machine_start' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'no_connect', deps);
  });

  it('AnsweredBy=fax hangs up the call and reports no_connect', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'fax' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'no_connect', deps);
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
  it.each(['no-answer', 'busy', 'failed', 'canceled'])(
    'CallStatus=%s reports no_connect',
    async (status) => {
      const deps = fakeDeps();
      const runHandleDialOutcome = vi.fn(async () => {});
      await onDialerStatus({ CallSid: 'CA1', CallStatus: status }, deps, runHandleDialOutcome);
      expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'no_connect', deps);
    },
  );

  it('falls back to DialCallStatus when CallStatus is absent', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', DialCallStatus: 'no-answer' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'no_connect', deps);
  });

  it('a non-terminal status (e.g. in-progress) is a no-op — AMD/connect owns that transition', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', CallStatus: 'in-progress' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).not.toHaveBeenCalled();
  });

  it('never touches telephony directly — status alone drives no_connect, no hangup needed', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', CallStatus: 'busy' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });
});
