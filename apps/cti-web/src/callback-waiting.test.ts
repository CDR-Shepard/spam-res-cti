import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  CALLER_HUNG_UP_TEXT,
  callerLabelOf,
  isTalking,
  missedCallbackToast,
  routeIncoming,
  runPauseAndAnswer,
  runSnapshotOf,
  takeCallbackRefusal,
  type IncomingContext,
  type PauseAndAnswerDeps,
  type RunSnapshot,
  type ToastSpec,
} from './callback-waiting';
import type { DialerSessionView } from './dialer-api';

const snap = (o: Partial<RunSnapshot> = {}): RunSnapshot => ({
  sessionId: 'sess-1', sessionStatus: 'active', itemStatus: null, prospectEndedAt: null, ...o,
});
const ctx = (o: Partial<IncomingContext> = {}): IncomingContext => ({
  placing: false, phase: 'idle', legLive: true, legSessionId: 'sess-1', waiting: false, snapshot: snap(), ...o,
});

describe('runSnapshotOf — the slice of the poll App keeps', () => {
  it('takes the run id and status, and the current item\'s status and hang-up stamp', () => {
    const view: DialerSessionView = {
      session: { id: 'sess-1', status: 'active' },
      counts: { total: 1, done: 0, connected: 1, noConnect: 0, skipped: 0, unreachable: 0, pending: 0 },
      currentItem: { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'connected', toNumber: '+16195550100', prospectEndedAt: null },
    };
    expect(runSnapshotOf(view)).toEqual({ sessionId: 'sess-1', sessionStatus: 'active', itemStatus: 'connected', prospectEndedAt: null });
  });
  it('between dials there is no item', () => {
    const view: DialerSessionView = {
      session: { id: 'sess-1', status: 'paused' },
      counts: { total: 1, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
      currentItem: null,
    };
    expect(runSnapshotOf(view)).toEqual({ sessionId: 'sess-1', sessionStatus: 'paused', itemStatus: null, prospectEndedAt: null });
  });
});

describe('isTalking — the same rule the server 409s on', () => {
  it('a connected prospect still on the line', () => {
    expect(isTalking(snap({ itemStatus: 'connected' }))).toBe(true);
  });
  it('not once the prospect hung up, not while a dial rings, not between dials, not with no snapshot', () => {
    expect(isTalking(snap({ itemStatus: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' }))).toBe(false);
    expect(isTalking(snap({ itemStatus: 'dialing' }))).toBe(false);
    expect(isTalking(snap())).toBe(false);
    expect(isTalking(null)).toBe(false);
  });
});

describe('routeIncoming — no dialer leg on the line: exactly today', () => {
  it('rings when the phone is idle or in preflight', () => {
    expect(routeIncoming(ctx({ legLive: false }))).toBe('ring');
    expect(routeIncoming(ctx({ legLive: false, phase: 'preflight' }))).toBe('ring');
  });
  it('rejects while a manual call rings, is up, is in wrap-up, or is being placed', () => {
    for (const phase of ['ringing', 'active', 'wrapup']) expect(routeIncoming(ctx({ legLive: false, phase }))).toBe('reject');
    expect(routeIncoming(ctx({ legLive: false, placing: true }))).toBe('reject');
  });
});

describe('routeIncoming — during a run (the leg is live)', () => {
  it('talking to a prospect → rejected, with the missed-callback toast', () => {
    expect(routeIncoming(ctx({ snapshot: snap({ itemStatus: 'connected' }) }))).toBe('reject-talking');
  });
  it('a dial ringing, between dials, paused, or a prospect who hung up → waits on the banner', () => {
    expect(routeIncoming(ctx({ snapshot: snap({ itemStatus: 'dialing' }) }))).toBe('wait');
    expect(routeIncoming(ctx({ snapshot: snap() }))).toBe('wait');
    expect(routeIncoming(ctx({ snapshot: snap({ sessionStatus: 'paused' }) }))).toBe('wait');
    expect(routeIncoming(ctx({ snapshot: snap({ itemStatus: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' }) }))).toBe('wait');
  });
  it('no snapshot yet, or one of ANOTHER run (the handoff seam) → waits: the server has the last word', () => {
    expect(routeIncoming(ctx({ snapshot: null }))).toBe('wait');
    expect(routeIncoming(ctx({ snapshot: snap({ sessionId: 'sess-2', itemStatus: 'connected' }) }))).toBe('wait');
  });
  it('one callback at a time: a second while one waits is rejected', () => {
    expect(routeIncoming(ctx({ waiting: true }))).toBe('reject');
  });
  it('the busy rule still comes first (a Device error left the phone mid-call)', () => {
    expect(routeIncoming(ctx({ phase: 'active' }))).toBe('reject');
  });
});

describe('callerLabelOf', () => {
  it('the matched Salesforce name, else the formatted number, else "Unknown caller"', () => {
    expect(callerLabelOf({ parameters: { From: '+16195551234' }, customParameters: new Map([['callerName', 'Jane Doe']]) })).toBe('Jane Doe');
    expect(callerLabelOf({ parameters: { From: '+16195551234' }, customParameters: new Map() })).toBe('+1 (619) 555-1234');
    expect(callerLabelOf({})).toBe('Unknown caller');
  });
});

describe('missedCallbackToast — where the rejected callback went', () => {
  it('voicemail with no forward set; "your cell" with one', () => {
    expect(missedCallbackToast('Jane Doe', null)).toEqual({ text: 'Missed callback from Jane Doe — you were on a call. It went to voicemail.', type: 'info' });
    expect(missedCallbackToast('Jane Doe', '+16195550199')).toEqual({ text: 'Missed callback from Jane Doe — you were on a call. It went to your cell.', type: 'info' });
  });
  it('says so when the run could not be paused', () => {
    expect(missedCallbackToast('+1 (619) 555-1234', null, 'not-paused').text).toBe("Missed callback from +1 (619) 555-1234 — Power Dial couldn't pause your run. It went to voicemail.");
  });
});

describe('takeCallbackRefusal — the 409 contract', () => {
  it('only 409 with reason "connected" means the rep is talking', () => {
    expect(takeCallbackRefusal(new ApiError(409, { error: 'x', reason: 'connected' }))).toBe('talking');
    expect(takeCallbackRefusal(new ApiError(409, { error: 'x' }))).toBe('failed');
    expect(takeCallbackRefusal(new ApiError(500, { error: 'x' }))).toBe('failed');
    expect(takeCallbackRefusal(new TypeError('Failed to fetch'))).toBe('failed');
  });
});

describe('runPauseAndAnswer — pause first, then leave the room, then answer', () => {
  function make(calls: string[], toasts: ToastSpec[], o: Partial<PauseAndAnswerDeps> = {}): PauseAndAnswerDeps {
    return {
      takeCallback: async () => { calls.push('takeCallback'); },
      stillRinging: () => { calls.push('stillRinging'); return true; },
      leaveRoom: () => { calls.push('leaveRoom'); },
      clear: () => { calls.push('clear'); },
      reject: () => { calls.push('reject'); },
      accept: () => { calls.push('accept'); },
      toast: (t) => { toasts.push(t); },
      missedToast: () => missedCallbackToast('Jane Doe', null),
      ...o,
    };
  }

  it('in this order and no other: server pause, still ringing?, leave the room, banner down, answer', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    expect(await runPauseAndAnswer(make(calls, toasts))).toBe('answered');
    expect(calls).toEqual(['takeCallback', 'stillRinging', 'leaveRoom', 'clear', 'accept']);
    expect(toasts).toEqual([]);
  });

  it('409 connected — a prospect answered in the race: reject with the missed toast; never leave the room, never answer', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    const d = make(calls, toasts, { takeCallback: async () => { throw new ApiError(409, { error: 'x', reason: 'connected' }); } });
    expect(await runPauseAndAnswer(d)).toBe('talking');
    expect(calls).toEqual(['reject']);
    expect(toasts).toEqual([{ text: 'Missed callback from Jane Doe — you were on a call. It went to voicemail.', type: 'info' }]);
  });

  it('any other failure: say why and touch nothing — the banner stays so the rep can retry or Ignore', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    const d = make(calls, toasts, { takeCallback: async () => { throw new ApiError(500, { error: 'database unavailable' }); } });
    expect(await runPauseAndAnswer(d)).toBe('failed');
    expect(calls).toEqual([]);
    expect(toasts).toEqual([{ text: "Couldn't pause the run to answer: database unavailable", type: 'error' }]);
  });

  it('a network failure names itself', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    const d = make(calls, toasts, { takeCallback: async () => { throw new TypeError('Failed to fetch'); } });
    expect(await runPauseAndAnswer(d)).toBe('failed');
    expect(toasts).toEqual([{ text: "Couldn't pause the run to answer: Failed to fetch", type: 'error' }]);
  });

  it('the caller hung up during the round trip: banner down and the toast — the rep stays in the room of the now-paused run', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    const d = make(calls, toasts, { stillRinging: () => { calls.push('stillRinging'); return false; } });
    expect(await runPauseAndAnswer(d)).toBe('caller-gone');
    expect(calls).toEqual(['takeCallback', 'stillRinging', 'clear']);
    expect(toasts).toEqual([{ text: CALLER_HUNG_UP_TEXT, type: 'info' }]);
  });
});
