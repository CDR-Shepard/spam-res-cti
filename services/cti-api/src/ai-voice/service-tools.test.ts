import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultToolEffects, handleToolCall, parseCallbackAt, type CallControl, type ToolCtx } from './service-tools.js';
import { CALL_SID, fakeStore, fakeTwilio, silentLog, type FakeStore, type FakeTwilio } from './testing.js';
import { TRANSFER_TIME_LIMIT_SECONDS } from './twilio.js';

const ID = '11111111-2222-4333-8444-555555555555';
const ORG = 'o1';
const TO = '+16195550100';
const NOW = new Date('2026-10-05T18:00:00Z');

let store: FakeStore;
let twilio: FakeTwilio;
let ctx: ToolCtx;
let closing: boolean;
let call: CallControl & { stopStream: ReturnType<typeof vi.fn>; waitForPlayback: ReturnType<typeof vi.fn> };

/** Let the background after-playback action run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  store = fakeStore();
  twilio = fakeTwilio();
  await store.insert({ id: ID, orgId: ORG, startedBy: 'u1', toE164: TO, status: 'in_progress', callSid: CALL_SID });
  ctx = { store, aiCallId: ID, orgId: ORG, toE164: TO, log: silentLog, now: () => NOW };
  closing = false;
  call = {
    callSid: CALL_SID,
    twilio,
    claimClose: () => (closing ? false : (closing = true)),
    waitForPlayback: vi.fn(async () => {}),
    stopStream: vi.fn(),
    transferTwiml: (reason: string) => `<Response><Dial>${reason}</Dial></Response>`,
  };
});

const run = (name: Parameters<typeof handleToolCall>[0], args: unknown) =>
  handleToolCall(name, args, { ctx, effects: defaultToolEffects, call });

describe('end_call', () => {
  it('records outcome and summary, then hangs up after the goodbye has played', async () => {
    const res = await run('end_call', { outcome: 'not_interested', summary: 'Not selling.' });
    expect(res.then).toBe('hangup');
    await settle();
    expect(call.waitForPlayback).toHaveBeenCalled();
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)).toMatchObject({ outcome: 'not_interested', summary: 'Not selling.' });
  });

  it('an unknown outcome still ends the call (as "other")', async () => {
    const res = await run('end_call', { outcome: 'banana' });
    expect(res.then).toBe('hangup');
    await settle();
    expect(store.rows.get(ID)?.outcome).toBe('other');
    expect(twilio.hangups).toHaveLength(1);
  });

  it('a do_not_call end also writes the opt-out, even if mark_do_not_call was never called', async () => {
    await run('end_call', { outcome: 'do_not_call', summary: 'Asked us to stop.' });
    expect(store.optOuts).toEqual([{ orgId: ORG, e164: TO, note: 'asked not to be called' }]);
    expect(store.rows.get(ID)?.outcome).toBe('do_not_call');
  });

  it('a second end/transfer is a no-op (only one closer acts)', async () => {
    await run('end_call', { outcome: 'hung_up', summary: '' });
    const res = await run('transfer_to_rep', { reason: 'interested', summary: 'x' });
    expect(res.then).toBe('hangup');
    await settle();
    expect(twilio.hangups).toHaveLength(1);
    expect(twilio.redirects).toHaveLength(0);
  });

  it('a failed REST hangup falls back to closing the stream (which ends the call)', async () => {
    twilio.failHangup = true;
    await run('end_call', { outcome: 'hung_up', summary: '' });
    await settle();
    expect(call.stopStream).toHaveBeenCalled();
  });

  it('a DB failure never stops the hang-up', async () => {
    store.setOutcome = async () => {
      throw new Error('db down');
    };
    const res = await run('end_call', { outcome: 'hung_up', summary: '' });
    expect(res.then).toBe('hangup');
    await settle();
    expect(twilio.hangups).toEqual([CALL_SID]);
  });
});

describe('transfer_to_rep', () => {
  it('marks the row transferring/qualified_transferred, then redirects to the rep with the time limit lifted', async () => {
    const res = await run('transfer_to_rep', { reason: 'wants_offer', summary: 'Wants a cash offer.' });
    expect(res.then).toBe('transfer');
    expect(store.rows.get(ID)).toMatchObject({ status: 'transferring', outcome: 'qualified_transferred', summary: 'Wants a cash offer.' });
    await settle();
    expect(twilio.redirects).toEqual([
      { callSid: CALL_SID, twiml: '<Response><Dial>wants_offer</Dial></Response>', opts: { timeLimit: TRANSFER_TIME_LIMIT_SECONDS } },
    ]);
  });

  it('a bad reason still transfers (a person asked for a person)', async () => {
    await run('transfer_to_rep', { reason: 7 });
    await settle();
    expect(twilio.redirects[0]?.twiml).toContain('question');
  });

  it('if Twilio refuses the lifted time limit, the transfer still goes through without it', async () => {
    const redirect = vi.fn().mockRejectedValueOnce(new Error('bad TimeLimit')).mockResolvedValueOnce(undefined);
    twilio.redirect = redirect;
    await run('transfer_to_rep', { reason: 'interested', summary: 'x' });
    await settle();
    expect(redirect).toHaveBeenCalledTimes(2);
    expect(redirect.mock.calls[1]).toEqual([CALL_SID, '<Response><Dial>interested</Dial></Response>']);
    expect(store.rows.get(ID)?.outcome).toBe('qualified_transferred');
    expect(twilio.hangups).toHaveLength(0);
  });

  it('a failed redirect marks transfer_failed, asks for a callback, and hangs up', async () => {
    twilio.failRedirect = true;
    await run('transfer_to_rep', { reason: 'interested', summary: 'Hot lead.' });
    await settle();
    expect(store.rows.get(ID)?.outcome).toBe('transfer_failed');
    expect(store.rows.get(ID)?.summary).toContain('call them back');
    expect(twilio.hangups).toEqual([CALL_SID]);
  });
});

describe('mark_do_not_call', () => {
  it('upserts the opt-out immediately, sets do_not_call, and keeps talking (for the goodbye)', async () => {
    const res = await run('mark_do_not_call', { note: 'stop calling me' });
    expect(res).toEqual({ output: 'done — say a brief goodbye and end the call', then: 'continue' });
    expect(store.optOuts).toEqual([{ orgId: ORG, e164: TO, note: 'stop calling me' }]);
    expect(store.rows.get(ID)?.outcome).toBe('do_not_call');
    expect(twilio.hangups).toHaveLength(0);
  });

  it('a wrong number is opted out and recorded as wrong_number', async () => {
    await run('mark_do_not_call', { note: 'Wrong number' });
    expect(store.optOuts).toHaveLength(1);
    expect(store.rows.get(ID)?.outcome).toBe('wrong_number');
  });

  it('retries the opt-out write once, and throws if it still fails (the bridge reports "tool failed")', async () => {
    const upsert = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(undefined);
    store.upsertOptOut = upsert;
    await run('mark_do_not_call', { note: 'stop' });
    expect(upsert).toHaveBeenCalledTimes(2);
    store.upsertOptOut = vi.fn().mockRejectedValue(new Error('down'));
    await expect(run('mark_do_not_call', { note: 'stop' })).rejects.toThrow('down');
  });

  it('do_not_call is never overwritten by a later end_call outcome', async () => {
    await run('mark_do_not_call', { note: 'stop' });
    await run('end_call', { outcome: 'not_interested', summary: 'bye' });
    expect(store.rows.get(ID)?.outcome).toBe('do_not_call');
  });
});

describe('save_qualification and schedule_callback', () => {
  it('merges only known, non-empty, capped fields', async () => {
    const res = await run('save_qualification', { motivation: 'relocating', timeline: '', bogus: 'x', condition: 'y'.repeat(900) });
    expect(res).toEqual({ output: 'saved', then: 'continue' });
    const q = store.rows.get(ID)?.qualification as Record<string, string>;
    expect(Object.keys(q).sort()).toEqual(['condition', 'motivation']);
    expect(q.condition).toHaveLength(500);
  });

  it('stores an ISO callback time and appends the request to the summary', async () => {
    const res = await run('schedule_callback', { when: '2026-10-07T17:00:00-05:00', note: 'after work' });
    expect(res).toEqual({ output: 'scheduled', then: 'continue' });
    expect(store.rows.get(ID)?.callbackAt?.toISOString()).toBe('2026-10-07T22:00:00.000Z');
    expect(store.rows.get(ID)?.summary).toBe('Callback requested: 2026-10-07T17:00:00-05:00 — after work');
  });

  it('keeps words it cannot parse as text only', async () => {
    await run('schedule_callback', { when: 'Thursday after 5 PM', note: '' });
    expect(store.rows.get(ID)?.callbackAt).toBeNull();
    expect(store.rows.get(ID)?.summary).toBe('Callback requested: Thursday after 5 PM');
  });
});

describe('parseCallbackAt', () => {
  it('accepts only ISO 8601 (V8 would happily parse "5" as a date)', () => {
    expect(parseCallbackAt('5')).toBeNull();
    expect(parseCallbackAt('Thursday')).toBeNull();
    expect(parseCallbackAt('2026-10-07')).toEqual(new Date('2026-10-07T00:00:00Z'));
    expect(parseCallbackAt('2026-10-07T17:00Z')).toEqual(new Date('2026-10-07T17:00:00Z'));
    expect(parseCallbackAt('2026-13-45T99:00Z')).toBeNull();
  });
});
