/**
 * The inbound agent's tools (plan 2026-10-16 inbound agent testing): `save_caller_details` (silent, merged into
 * ai_calls.qualification) and `end_call`. A call is offered only its direction's tools: anything else is refused as
 * an unknown tool, whatever the model sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INBOUND_DETAIL_FIELDS, INBOUND_STATUSES } from '@cti/contracts';
import { followUpAfterTools, runToolBatch, type FunctionCall } from './bridge-tools.js';
import { AI_CALL_TOOLS, INBOUND_TOOLS, OUTBOUND_TOOL_NAMES, SAVE_CALLER_DETAILS_TOOL, TOOL_NAMES, toolsFor } from './prompt-tools.js';
import { defaultToolEffects, handleToolCall, type CallControl, type ToolCtx } from './service-tools.js';
import { CALL_SID, fakeStore, fakeTwilio, silentLog, type FakeStore, type FakeTwilio } from './testing.js';

const ID = '11111111-2222-4333-8444-555555555555';
const CALLER = '+16195550142';
const SAVED_OUTPUT = "saved — carry on from where you were; don't thank them again or repeat yourself";
const UNKNOWN_TOOL = '{"error":"unknown tool"}';

let store: FakeStore;
let twilio: FakeTwilio;
let inbound: ToolCtx;
let outbound: ToolCtx;
let call: CallControl & { claimClose: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  store = fakeStore();
  twilio = fakeTwilio();
  await store.insert({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: CALLER, status: 'in_progress', callSid: CALL_SID, isTest: true, direction: 'inbound' });
  const base = { store, aiCallId: ID, orgId: 'o1', toE164: CALLER, log: silentLog, now: () => new Date(), slots: [], isTest: true };
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
  it('is exactly save_caller_details then end_call', () => {
    expect(INBOUND_TOOLS.map((t) => t.name)).toEqual(['save_caller_details', 'end_call']);
    expect(INBOUND_TOOLS[1]).toEqual(AI_CALL_TOOLS.find((t) => t.name === 'end_call'));
  });

  it('save_caller_details: a closed schema, every field optional, status limited to the four statuses', () => {
    const tool = INBOUND_TOOLS[0]!;
    expect(tool.description).toBe('Save what the caller told you — only the fields you learned; call again as you learn more. Silent: never announce it.');
    const params = tool.parameters as { properties: Record<string, { type: string; enum?: string[] }>; required: string[]; additionalProperties: boolean };
    expect(params.additionalProperties).toBe(false);
    expect(params.required).toEqual([]);
    expect(Object.keys(params.properties)).toEqual(['status', ...INBOUND_DETAIL_FIELDS]);
    expect(params.properties.status).toMatchObject({ type: 'string', enum: [...INBOUND_STATUSES] });
    for (const f of INBOUND_DETAIL_FIELDS) expect(params.properties[f]?.type).toBe('string');
  });

  it('is a call-service tool name, but never offered to an outbound call (toolsFor is unchanged)', () => {
    expect(TOOL_NAMES).toContain('save_caller_details');
    expect(OUTBOUND_TOOL_NAMES).not.toContain('save_caller_details');
    expect([...OUTBOUND_TOOL_NAMES, 'save_caller_details']).toEqual([...TOOL_NAMES]);
    expect(toolsFor([])).toBe(AI_CALL_TOOLS);
    expect(AI_CALL_TOOLS.some((t) => t.name === 'save_caller_details')).toBe(false);
  });
});

describe('save_caller_details', () => {
  it('saves only the known fields, trimmed, and answers like a note save (carry on)', async () => {
    const res = await run(inbound, 'save_caller_details', { location: '  North Park  ', timeline: 'this summer', favourite_colour: 'blue', price_expectation: 42 });
    expect(res).toEqual({ output: SAVED_OUTPUT, then: 'continue' });
    expect(qualification()).toEqual({ location: 'North Park', timeline: 'this summer' });
  });

  it('caps each field at 500 characters, the notes at 1,000', async () => {
    await run(inbound, 'save_caller_details', { condition: 'x'.repeat(900), notes: 'n'.repeat(1500) });
    expect(qualification()).toEqual({ condition: 'x'.repeat(500), notes: 'n'.repeat(1000) });
  });

  it('keeps a valid status and drops an invalid one', async () => {
    await run(inbound, 'save_caller_details', { status: 'qualified' });
    expect(qualification()).toEqual({ status: 'qualified' });
    await run(inbound, 'save_caller_details', { status: 'hot lead', urgency: 'high' });
    expect(qualification()).toEqual({ status: 'qualified', urgency: 'high' });
  });

  it('saves the seller, contact and follow-up fields too', async () => {
    const more = {
      seller_name: 'Dana',
      phone_number: '619-555-0142',
      property_address: '1240 Elm St',
      occupancy: 'tenants',
      motivation: 'inherited it',
      seller_sentiment: 'relaxed',
      recommended_next_action: 'call back today',
    };
    await run(inbound, 'save_caller_details', more);
    expect(qualification()).toEqual(more);
  });

  it('keeps a valid urgency_level and drops an invalid one', async () => {
    await run(inbound, 'save_caller_details', { urgency_level: 'high' });
    expect(qualification()).toEqual({ urgency_level: 'high' });
    await run(inbound, 'save_caller_details', { urgency_level: 'very', urgency: 'auction in 2 weeks' });
    expect(qualification()).toEqual({ urgency_level: 'high', urgency: 'auction in 2 weeks' });
  });

  it('offers urgency_level and status as fixed choices in the tool', () => {
    const props = (SAVE_CALLER_DETAILS_TOOL.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.urgency_level?.enum).toEqual(['high', 'medium', 'low', 'unknown']);
    expect(props.status?.enum).toEqual(['qualified', 'callback', 'disqualified', 'incomplete']);
    expect(Object.keys(props)).toHaveLength(17);
  });

  it('merges later saves into earlier ones', async () => {
    await run(inbound, 'save_caller_details', { location: 'Chula Vista' });
    await run(inbound, 'save_caller_details', { status: 'callback', best_callback_time: 'after 5' });
    expect(qualification()).toEqual({ location: 'Chula Vista', status: 'callback', best_callback_time: 'after 5' });
  });

  it('is refused on an outbound call, and nothing is written', async () => {
    expect(await run(outbound, 'save_caller_details', { location: 'x' })).toEqual({ output: UNKNOWN_TOOL });
    expect(qualification()).toEqual({});
  });
});

describe('save_caller_details landing after the call was finalized (final review M-2)', () => {
  const finalize = () => store.finalizeInbound(ID, { durationSeconds: 40, endedAt: new Date('2026-10-16T18:05:00Z'), failed: false });

  it('a status saved after finalize becomes the outcome: the call never reads Incomplete with a status saved', async () => {
    await finalize();
    expect(store.rows.get(ID)?.outcome).toBe('incomplete');
    await run(inbound, 'save_caller_details', { status: 'callback', location: 'Vista' });
    expect(store.rows.get(ID)).toMatchObject({ outcome: 'callback', status: 'completed', qualification: { status: 'callback', location: 'Vista' } });
  });

  it('a late save with no valid status leaves the outcome alone', async () => {
    await run(inbound, 'save_caller_details', { status: 'qualified' });
    await finalize();
    await run(inbound, 'save_caller_details', { location: 'Vista', status: 'hot lead' });
    expect(store.rows.get(ID)).toMatchObject({ outcome: 'qualified', qualification: { status: 'qualified', location: 'Vista' } });
  });

  it('a save while the call is live never sets the outcome (finalize does)', async () => {
    await run(inbound, 'save_caller_details', { status: 'disqualified' });
    expect(store.rows.get(ID)?.outcome).toBeNull();
  });
});

describe('an inbound call is offered only its own tools', () => {
  it.each(['transfer_to_rep', 'mark_do_not_call', 'save_qualification', 'schedule_callback', 'book_appointment'] as const)(
    '%s is refused as an unknown tool, with no side effect',
    async (name) => {
      expect(await run(inbound, name, { reason: 'interested', summary: 's', note: 'stop', motivation: 'm', when: 'now', slot_id: 'p1' })).toEqual({
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

  it('reaches save_caller_details through the bridge (a known tool name, not "unknown tool")', async () => {
    const sent: object[] = [];
    const onTool = vi.fn(async () => ({ output: SAVED_OUTPUT, then: 'continue' as const }));
    await runToolBatch([{ name: 'save_caller_details', call_id: 'c1', arguments: '{"location":"Del Mar"}' }], {
      onTool,
      log: silentLog,
      send: (m) => sent.push(m),
    });
    expect(onTool).toHaveBeenCalledWith('save_caller_details', { location: 'Del Mar' });
  });
});

describe('followUpAfterTools treats save_caller_details like save_qualification', () => {
  const fc = (name: string, id = 'c1'): FunctionCall => ({ name, call_id: id, arguments: '{}' });
  const SPEAK = { carryOn: true, speak: true };

  it('no follow-up after a details save riding on a spoken question', () => {
    expect(followUpAfterTools([fc('save_caller_details')], SPEAK, { audio: true, question: true })).toBe(false);
    expect(followUpAfterTools([fc('save_caller_details'), fc('save_qualification', 'c2')], SPEAK, { audio: true, question: true })).toBe(false);
  });

  it('a follow-up after a statement, a tool-first save, or a save mixed with end_call', () => {
    expect(followUpAfterTools([fc('save_caller_details')], SPEAK, { audio: true, question: false })).toBe(true);
    expect(followUpAfterTools([fc('save_caller_details')], SPEAK, { audio: false, question: false })).toBe(true);
    expect(followUpAfterTools([fc('save_caller_details'), fc('end_call', 'c2')], SPEAK, { audio: true, question: true })).toBe(true);
  });
});
