import { describe, expect, it, vi } from 'vitest';
import { CALL_GOAL_KEYS, CallPlan, DoNotContactCategory, EvidenceSource, PreferredWindow } from '@cti/contracts';
import { validPlan } from '../test/call-plan-fixtures.js';
import { costMicros, isPricedModel } from './model.js';
import {
  AnthropicCallPlanModel,
  CALL_PLAN_INPUT_SCHEMA,
  CALL_PLAN_MODEL_DEFAULT,
  CALL_PLAN_TOOL,
  CALL_PLAN_TOOL_NAME,
  CallPlanOutputError,
} from './call-plan-model.js';

type Block = { type: string; name?: string; input?: unknown };
const client = (content: Block[]) => ({ messages: { create: vi.fn(async () => ({ content, usage: { input_tokens: 12_000, output_tokens: 1_500 } })) } });

/** Walks a parsed JSON value by keys and indexes. */
function at(value: unknown, ...path: Array<string | number>): unknown {
  return path.reduce<unknown>((v, key) => (v as Record<string | number, unknown> | undefined)?.[key], value);
}

describe('AnthropicCallPlanModel', () => {
  it('forces the record_call_plan tool and returns the validated plan with usage', async () => {
    const c = client([{ type: 'tool_use', name: CALL_PLAN_TOOL_NAME, input: validPlan }]);
    const out = await new AnthropicCallPlanModel({ client: c }).plan({ system: 'S', user: 'U' });
    expect(out).toMatchObject({ plan: validPlan, inputTokens: 12_000, outputTokens: 1_500, model: 'claude-sonnet-5-5' });
    expect(c.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-5-5',
        tool_choice: { type: 'tool', name: CALL_PLAN_TOOL_NAME },
        tools: [CALL_PLAN_TOOL],
        messages: [{ role: 'user', content: 'U' }],
        system: 'S',
      }),
      expect.anything(),
    );
  });
  it('uses a configured model id', async () => {
    const c = client([{ type: 'tool_use', name: CALL_PLAN_TOOL_NAME, input: validPlan }]);
    const model = new AnthropicCallPlanModel({ client: c, model: 'claude-opus-5' });
    expect(model.modelId).toBe('claude-opus-5');
    await model.plan({ system: 'S', user: 'U' });
    expect(c.messages.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5' }), expect.anything());
  });
  it('defaults to claude-sonnet-5-5', () => {
    expect(CALL_PLAN_MODEL_DEFAULT).toBe('claude-sonnet-5-5');
    expect(new AnthropicCallPlanModel({ client: client([]) }).modelId).toBe('claude-sonnet-5-5');
  });
  it('throws CallPlanOutputError carrying usage when the tool input does not validate', async () => {
    const c = client([{ type: 'tool_use', name: CALL_PLAN_TOOL_NAME, input: { ...validPlan, questions: [] } }]);
    const err = await new AnthropicCallPlanModel({ client: c }).plan({ system: 'S', user: 'U' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallPlanOutputError);
    expect((err as CallPlanOutputError).usage).toEqual({ inputTokens: 12_000, outputTokens: 1_500, model: 'claude-sonnet-5-5' });
    expect((err as Error).message).toMatch(/questions/);
  });
  it('reports only the paths and codes of the failed checks, never the validator messages or the model values', async () => {
    const bad = { ...validPlan, openingLine: 12_345, situationSummary: 'x'.repeat(5_000) };
    const err = (await new AnthropicCallPlanModel({ client: client([{ type: 'tool_use', name: CALL_PLAN_TOOL_NAME, input: bad }]) }).plan({ system: 'S', user: 'U' }).catch((e: unknown) => e)) as CallPlanOutputError;
    expect(err.issues.length).toBeGreaterThan(0);
    for (const i of err.issues) expect(Object.keys(i).sort()).toEqual(['code', 'path']);
    expect(err.issues).toContainEqual({ path: 'situationSummary', code: 'too_big' });
    expect(err.message).toMatch(/^invalid call plan: /);
    expect(err.message).not.toMatch(/Expected|Required|received|characters/i);
  });
  it('carries the raw doNotContact of a rejected plan, so a flag is not lost with it', async () => {
    const flag = { category: 'attorney', quote: 'talk to my lawyer' };
    const c = client([{ type: 'tool_use', name: CALL_PLAN_TOOL_NAME, input: { ...validPlan, questions: [], doNotContact: flag } }]);
    const err = (await new AnthropicCallPlanModel({ client: c }).plan({ system: 'S', user: 'U' }).catch((e: unknown) => e)) as CallPlanOutputError;
    expect(err.rawDoNotContact).toEqual(flag);
    const none = (await new AnthropicCallPlanModel({ client: client([{ type: 'text' }]) }).plan({ system: 'S', user: 'U' }).catch((e: unknown) => e)) as CallPlanOutputError;
    expect(none.rawDoNotContact).toBeUndefined();
    expect(none.issues).toEqual([]);
  });
  it('passes the abort signal to the SDK call', async () => {
    const c = client([{ type: 'tool_use', name: CALL_PLAN_TOOL_NAME, input: validPlan }]);
    const signal = new AbortController().signal;
    await new AnthropicCallPlanModel({ client: c }).plan({ system: 'S', user: 'U' }, { signal });
    expect(c.messages.create).toHaveBeenCalledWith(expect.anything(), { signal });
  });
  it('rejects a plan that names one goal twice, or carries an extra price key the contract does not know', async () => {
    const twice = { ...validPlan, goals: [...validPlan.goals.slice(0, 3), validPlan.goals[0]] };
    await expect(new AnthropicCallPlanModel({ client: client([{ type: 'tool_use', name: CALL_PLAN_TOOL_NAME, input: twice }]) }).plan({ system: 'S', user: 'U' })).rejects.toBeInstanceOf(
      CallPlanOutputError,
    );
    const out = await new AnthropicCallPlanModel({ client: client([{ type: 'tool_use', name: CALL_PLAN_TOOL_NAME, input: { ...validPlan, offerPrice: 150_000 } }]) }).plan({
      system: 'S',
      user: 'U',
    });
    expect(out.plan).not.toHaveProperty('offerPrice');
  });
  it('throws when the model answers without the tool', async () => {
    await expect(new AnthropicCallPlanModel({ client: client([{ type: 'text' }]) }).plan({ system: 'S', user: 'U' })).rejects.toBeInstanceOf(CallPlanOutputError);
  });
  it('ignores a tool_use block of another tool', async () => {
    await expect(new AnthropicCallPlanModel({ client: client([{ type: 'tool_use', name: 'record_triage', input: validPlan }]) }).plan({ system: 'S', user: 'U' })).rejects.toBeInstanceOf(
      CallPlanOutputError,
    );
  });
});

describe('CALL_PLAN_INPUT_SCHEMA', () => {
  it('mirrors CallPlan: same required keys and the contract enums', () => {
    expect([...CALL_PLAN_INPUT_SCHEMA.required].sort()).toEqual(Object.keys(CallPlan.shape).sort());
    const p = (...path: Array<string | number>) => at(CALL_PLAN_INPUT_SCHEMA.properties, ...path);
    expect(p('goals', 'items', 'properties', 'goal', 'enum')).toEqual([...CALL_GOAL_KEYS]);
    expect(p('goals', 'minItems')).toBe(4);
    expect(p('goals', 'maxItems')).toBe(4);
    expect(p('sellingSignals', 'items', 'properties', 'source', 'enum')).toEqual(EvidenceSource.options);
    expect(p('bestTimeToCall', 'properties', 'window', 'enum')).toEqual(PreferredWindow.options);
    expect(p('doNotContact', 'anyOf', 1, 'properties', 'category', 'enum')).toEqual(DoNotContactCategory.options);
    expect(p('questions', 'minItems')).toBe(1);
  });
});

describe('pricing', () => {
  it('prices claude-sonnet-5-5 so the daily budget counts plan calls', () => {
    expect(isPricedModel('claude-sonnet-5-5')).toBe(true);
    expect(costMicros('claude-sonnet-5-5', 1_000, 100)).toBe(1_000 * 2 + 100 * 10);
  });
});
