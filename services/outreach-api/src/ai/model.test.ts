import { describe, expect, it, vi } from 'vitest';
import { ContactChannel, DoNotContactCategory, TRIAGE_TAGS, TriageResult } from '@cti/contracts';
import {
  AnthropicTriageModel,
  costMicros,
  isPricedModel,
  TRIAGE_INPUT_SCHEMA,
  TRIAGE_MODEL,
  TRIAGE_TOOL_NAME,
  TriageOutputError,
  type MessagesClient,
} from './model.js';

const VALID: TriageResult = {
  summary: 'Owner inherited a vacant house and wants a quick sale. Prefers texts because she works nights.',
  channels: [{ channel: 'sms', reason: '"Prefers text, works nights"' }],
  timing: 'after 2pm',
  tags: ['inherited', 'vacant', 'prefers_text'],
  doNotContact: null,
};
const PROMPT = { system: 'SYSTEM', user: '<notes>…</notes>' };

/** Walks a parsed JSON value by keys and indexes. */
function at(value: unknown, ...path: Array<string | number>): unknown {
  return path.reduce<unknown>((v, key) => (v as Record<string | number, unknown> | undefined)?.[key], value);
}

function fakeClient(content: Array<{ type: string; name?: string; input?: unknown }>) {
  const create = vi.fn(async () => ({ content, usage: { input_tokens: 812, output_tokens: 143 } }));
  const client: MessagesClient = { messages: { create } };
  return { client, create };
}

describe('costMicros', () => {
  it('prices Haiku 4.5 at 1 and 5 micro-dollars per input and output token', () => {
    expect(costMicros(TRIAGE_MODEL, 812, 143)).toBe(812 + 143 * 5);
  });
  it('refuses a model without a price', () => {
    expect(() => costMicros('claude-unknown', 1, 1)).toThrow(/no price/);
  });
  it('isPricedModel says which models costMicros knows', () => {
    expect(isPricedModel(TRIAGE_MODEL)).toBe(true);
    expect(isPricedModel('claude-unknown')).toBe(false);
  });
  it('the Anthropic adapter exposes the model id it calls', () => {
    expect(new AnthropicTriageModel({ client: {} as never }).modelId).toBe(TRIAGE_MODEL);
    expect(new AnthropicTriageModel({ client: {} as never, model: 'claude-x' }).modelId).toBe('claude-x');
  });
});

describe('TRIAGE_INPUT_SCHEMA', () => {
  it('mirrors TriageResult: same required keys and the contract enums', () => {
    expect([...TRIAGE_INPUT_SCHEMA.required].sort()).toEqual(Object.keys(TriageResult.shape).sort());
    const p = (...path: Array<string | number>) => at(TRIAGE_INPUT_SCHEMA.properties, ...path);
    expect(p('channels', 'items', 'properties', 'channel', 'enum')).toEqual(ContactChannel.options);
    expect(p('tags', 'items', 'enum')).toEqual([...TRIAGE_TAGS]);
    expect(p('doNotContact', 'anyOf', 1, 'properties', 'category', 'enum')).toEqual(DoNotContactCategory.options);
    expect(p('channels', 'maxItems')).toBe(3);
    expect(p('tags', 'maxItems')).toBe(8);
  });
});

describe('AnthropicTriageModel', () => {
  it('forces the record_triage tool and returns the parsed input with token usage', async () => {
    const { client, create } = fakeClient([
      { type: 'text' },
      { type: 'tool_use', name: TRIAGE_TOOL_NAME, input: VALID },
    ]);
    const out = await new AnthropicTriageModel({ client }).triage(PROMPT);
    expect(out).toEqual({ result: VALID, inputTokens: 812, outputTokens: 143, model: TRIAGE_MODEL });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: TRIAGE_MODEL,
        system: 'SYSTEM',
        messages: [{ role: 'user', content: '<notes>…</notes>' }],
        tool_choice: { type: 'tool', name: TRIAGE_TOOL_NAME },
        tools: [expect.objectContaining({ name: TRIAGE_TOOL_NAME, input_schema: TRIAGE_INPUT_SCHEMA })],
      }),
    );
  });

  it('rejects tool input that fails the TriageResult schema with TriageOutputError carrying the usage', async () => {
    const { client } = fakeClient([{ type: 'tool_use', name: TRIAGE_TOOL_NAME, input: { ...VALID, tags: ['not_a_tag'] } }]);
    const err = await new AnthropicTriageModel({ client }).triage(PROMPT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriageOutputError);
    expect((err as TriageOutputError).message).toMatch(/tags/);
    expect((err as TriageOutputError).usage).toEqual({ inputTokens: 812, outputTokens: 143, model: TRIAGE_MODEL });
  });

  it('rejects a response without a record_triage tool call', async () => {
    const { client } = fakeClient([{ type: 'text' }]);
    await expect(new AnthropicTriageModel({ client }).triage(PROMPT)).rejects.toBeInstanceOf(TriageOutputError);
  });

  it('lets an API failure through unchanged (the caller stops the tick)', async () => {
    const client: MessagesClient = { messages: { create: vi.fn(async () => { throw new Error('overloaded'); }) } };
    await expect(new AnthropicTriageModel({ client }).triage(PROMPT)).rejects.toThrow('overloaded');
  });
});
