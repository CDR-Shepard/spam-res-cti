/**
 * The inbound agent's tools (plan 2026-10-16 inbound agent testing): `end_call` only. It saves nothing during the call;
 * the caller details are filled in from the transcript afterwards (caller-details.ts). A call is offered only its
 * direction's tools: anything else is refused as an unknown tool, whatever the model sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runToolBatch } from './bridge-tools.js';
import { AI_CALL_TOOLS, INBOUND_TOOLS, OUTBOUND_TOOL_NAMES, TOOL_NAMES, toolsFor } from './prompt-tools.js';
import { defaultToolEffects, handleToolCall, type CallControl, type ToolCtx } from './service-tools.js';
import { CALL_SID, fakeStore, fakeTwilio, silentLog, type FakeStore, type FakeTwilio } from './testing.js';

const ID = '11111111-2222-4333-8444-555555555555';
const CALLER = '+16195550142';
const UNKNOWN_TOOL = '{"error":"unknown tool"}';
/** An inbound call never carries one; given one anyway, book_priority_appointment is still refused. */
const GRANT = { specialistSfUserId: '0058X00000Fsx39QAB', specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles', defaultStart: '2030-01-07T17:00:00.000Z' };

let store: FakeStore;
let twilio: FakeTwilio;
let inbound: ToolCtx;
let outbound: ToolCtx;
let call: CallControl & { claimClose: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  store = fakeStore();
  twilio = fakeTwilio();
  await store.insert({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: CALLER, status: 'in_progress', callSid: CALL_SID, isTest: true, direction: 'inbound' });
  const base = { store, aiCallId: ID, orgId: 'o1', toE164: CALLER, log: silentLog, now: () => new Date(), slots: [], priority: null, consultations: null, isTest: true };
  inbound = { ...base, direction: 'inbound' };
  outbound = base;
  call = {
    callSid: CALL_SID,
    twilio,
    claimClose: vi.fn(() => true),
    waitForPlayback: async () => {},
    stopStream: () => {},
    transferTwiml: () => '<Response/>',
  };
});

const run = (ctx: ToolCtx, name: Parameters<typeof handleToolCall>[0], args: unknown) =>
  handleToolCall(name, args, { ctx, effects: defaultToolEffects, call });
const qualification = () => store.rows.get(ID)!.qualification;

describe('INBOUND_TOOLS', () => {
  it('is exactly end_call: the live agent has no save tool', () => {
    expect(INBOUND_TOOLS.map((t) => t.name)).toEqual(['end_call']);
    expect(INBOUND_TOOLS[0]).toEqual(AI_CALL_TOOLS.find((t) => t.name === 'end_call'));
  });

  it('the outbound tools are unchanged', () => {
    expect(AI_CALL_TOOLS.map((t) => t.name)).toEqual([
      'transfer_to_rep',
      'end_call',
      'mark_do_not_call',
      'save_qualification',
      'schedule_callback',
      'wait_for_user',
    ]);
    expect(toolsFor({ slots: [], priority: null, alreadyBooked: false })).toBe(AI_CALL_TOOLS);
    expect(toolsFor({ slots: [{ id: 'p1' } as never], priority: null, alreadyBooked: false }).map((t) => t.name)).toEqual([
      ...AI_CALL_TOOLS.map((t) => t.name),
      'book_appointment',
    ]);
    expect([...OUTBOUND_TOOL_NAMES]).toEqual([
      'transfer_to_rep', 'end_call', 'mark_do_not_call', 'save_qualification', 'schedule_callback', 'book_appointment', 'book_priority_appointment',
    ]);
  });

  it('save_caller_details is not a tool any call is offered, and not a tool name the call service knows', () => {
    expect([...TOOL_NAMES]).toEqual([...OUTBOUND_TOOL_NAMES]);
    expect(TOOL_NAMES).not.toContain('save_caller_details');
    expect(AI_CALL_TOOLS.some((t) => t.name === 'save_caller_details')).toBe(false);
    expect(INBOUND_TOOLS.some((t) => t.name === 'save_caller_details')).toBe(false);
  });
});

describe('save_caller_details, should the model still send it', () => {
  it.each([
    ['an inbound call', () => inbound],
    ['an outbound call', () => outbound],
  ])('is refused on %s as an unknown tool, and nothing is written', async (_name, ctx) => {
    const res = await run(ctx(), 'save_caller_details' as never, { status: 'qualified', location: 'x' });
    expect(res).toEqual({ output: UNKNOWN_TOOL });
    expect(qualification()).toEqual({});
    expect(store.rows.get(ID)?.outcome).toBeNull();
  });

  it('never reaches a tool hook through the bridge: it is an unknown tool there too', async () => {
    const sent: Array<{ item?: { output?: string } }> = [];
    const onTool = vi.fn(async () => ({ output: 'saved' }));
    await runToolBatch([{ name: 'save_caller_details', call_id: 'c1', arguments: '{"location":"Del Mar"}' }], {
      onTool,
      log: silentLog,
      send: (m) => sent.push(m as { item?: { output?: string } }),
    });
    expect(onTool).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('unknown tool');
  });
});

describe('an inbound call is offered only its own tools', () => {
  it.each(['transfer_to_rep', 'mark_do_not_call', 'save_qualification', 'schedule_callback', 'book_appointment', 'book_priority_appointment'] as const)(
    '%s is refused as an unknown tool, with no side effect',
    async (name) => {
      const args = { reason: 'interested', summary: 's', note: 'stop', motivation: 'm', when: 'now', slot_id: 'p1', start: '2030-01-07T10:00', address_confirmed: true };
      expect(await run({ ...inbound, priority: GRANT }, name, args)).toEqual({
        output: UNKNOWN_TOOL,
      });
      expect(call.claimClose).not.toHaveBeenCalled();
      expect(twilio.redirects).toEqual([]);
      expect(store.optOuts).toEqual([]);
      expect(store.rows.get(ID)).toMatchObject({ outcome: null, qualification: {}, summary: null, callbackAt: null });
    },
  );

  it('end_call works on an inbound call (and never opts the test phone out)', async () => {
    expect(await run(inbound, 'end_call', { outcome: 'do_not_call', summary: 'Asked not to be called.' })).toEqual({ output: 'ending', then: 'hangup' });
    expect(store.optOuts).toEqual([]);
  });
});
