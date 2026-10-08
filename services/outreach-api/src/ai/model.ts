/**
 * The triage model port and its Anthropic adapter. The adapter forces one tool call
 * (`record_triage`) whose input schema mirrors `TriageResult`, then validates the tool
 * input with zod: the model proposes, nothing it returns is used unvalidated.
 */
import { ContactChannel, DoNotContactCategory, TRIAGE_TAGS, TriageResult } from '@cti/contracts';

export const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

/** USD per million tokens = micro-dollars per token (Haiku 4.5: $1 in, $5 out). */
export const PRICE_MICROS_PER_TOKEN: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // Plan 1C call plans (Sonnet 5.5): $2 in, $10 out.
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

/** Cost of one call in micro-dollars. Throws for a model without a price, so spend is never silently zero. */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICE_MICROS_PER_TOKEN[model];
  if (!price) throw new Error(`no price configured for model ${model}`);
  return inputTokens * price.input + outputTokens * price.output;
}

/** True when `costMicros` has a price for `model`. */
export function isPricedModel(model: string): boolean {
  return Object.hasOwn(PRICE_MICROS_PER_TOKEN, model);
}

export interface TriagePrompt {
  system: string;
  user: string;
}

export interface TriageUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface TriageModel {
  /** The model id calls are made (and priced) with; the tick refuses a model `costMicros` cannot price. */
  readonly modelId: string;
  triage(prompt: TriagePrompt): Promise<{ result: TriageResult; inputTokens: number; outputTokens: number; model: string }>;
}

/** The model answered, but not with a valid `TriageResult`. `usage` is what the call cost. */
export class TriageOutputError extends Error {
  constructor(
    message: string,
    readonly usage: TriageUsage,
  ) {
    super(message);
    this.name = 'TriageOutputError';
  }
}

export const TRIAGE_TOOL_NAME = 'record_triage';

/** A client tool definition, in the Messages API's shape. */
export interface TriageTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; [key: string]: unknown };
}

/** JSON Schema for the tool input; mirrors `TriageResult` in @cti/contracts (enums come from the contract). */
export const TRIAGE_INPUT_SCHEMA: TriageTool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'channels', 'timing', 'tags', 'doNotContact'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 600, description: 'Two or three plain sentences.' },
    channels: {
      type: 'array',
      maxItems: 3,
      description: 'Best channel first; empty when the notes give no signal.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['channel', 'reason'],
        properties: {
          channel: { type: 'string', enum: [...ContactChannel.options] },
          reason: { type: 'string', minLength: 1, maxLength: 300, description: 'Quote or paraphrase of the supporting note.' },
        },
      },
    },
    timing: { type: ['string', 'null'], maxLength: 200 },
    tags: { type: 'array', maxItems: 8, items: { type: 'string', enum: [...TRIAGE_TAGS] } },
    doNotContact: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'quote'],
          properties: {
            category: { type: 'string', enum: [...DoNotContactCategory.options] },
            quote: { type: 'string', minLength: 1, maxLength: 300 },
          },
        },
      ],
    },
  },
};

export const TRIAGE_TOOL: TriageTool = {
  name: TRIAGE_TOOL_NAME,
  description: 'Record the triage of one homeowner record. Call exactly once.',
  input_schema: TRIAGE_INPUT_SCHEMA,
};

/** Claude 4 models accept a forced tool choice. Claude 5 models refuse "tool" and "any" (400), so they get structured output. */
const FORCED_TOOL_CHOICE = /^claude-(?:haiku|sonnet|opus)-4/;

/** Size and bound keywords structured output refuses ("For 'array' type, property 'maxItems' is not supported"); the zod contract still enforces them. */
const SIZE_KEYWORDS = new Set(['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);

function withoutSizeKeywords(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutSizeKeywords);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !SIZE_KEYWORDS.has(k)).map(([k, x]) => [k, withoutSizeKeywords(x)]));
}

export type ToolRequest =
  | { tools: TriageTool[]; tool_choice: { type: 'tool'; name: string } }
  | { output_config: { format: { type: 'json_schema'; schema: Record<string, unknown> } } };

/**
 * How a request gets the model's answer in the tool's shape. A free ("auto") tool choice is not enough on Claude 5:
 * with a deep schema it sometimes sends nested values as strings, so structured output constrains the answer instead.
 */
export function requestFor(model: string, tool: TriageTool): ToolRequest {
  if (FORCED_TOOL_CHOICE.test(model)) return { tools: [tool], tool_choice: { type: 'tool', name: tool.name } };
  return { output_config: { format: { type: 'json_schema', schema: withoutSizeKeywords(tool.input_schema) as Record<string, unknown> } } };
}

/** The answer: the tool call's input, else a structured-output JSON object, else undefined (an output error for the caller). */
export function readToolInput(content: ReadonlyArray<{ type: string; name?: string; input?: unknown; text?: string }>, toolName: string): unknown {
  const call = content.find((b) => b.type === 'tool_use' && b.name === toolName);
  if (call) return call.input;
  const text = content.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The slice of the Anthropic SDK client the adapter uses (an `Anthropic` instance satisfies it). */
export interface MessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: 'user'; content: string }>;
      tools?: TriageTool[];
      tool_choice?: { type: 'tool'; name: string };
      output_config?: { format: { type: 'json_schema'; schema: Record<string, unknown> } };
    }, options?: { signal?: AbortSignal }): Promise<{
      content: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

const MAX_OUTPUT_TOKENS = 1_024;

export class AnthropicTriageModel implements TriageModel {
  readonly modelId: string;
  constructor(private readonly deps: { client: MessagesClient; model?: string }) {
    this.modelId = deps.model ?? TRIAGE_MODEL;
  }

  async triage(prompt: TriagePrompt): Promise<{ result: TriageResult; inputTokens: number; outputTokens: number; model: string }> {
    const response = await this.deps.client.messages.create({
      model: this.modelId,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      ...requestFor(this.modelId, TRIAGE_TOOL),
    });
    const usage: TriageUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: this.modelId,
    };
    const input = readToolInput(response.content, TRIAGE_TOOL_NAME);
    if (input === undefined) throw new TriageOutputError('the model did not call record_triage', usage);
    const parsed = TriageResult.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new TriageOutputError(`invalid triage output: ${issues}`, usage);
    }
    return { result: parsed.data, ...usage };
  }
}
