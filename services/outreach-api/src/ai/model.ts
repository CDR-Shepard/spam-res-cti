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
};

/** Cost of one call in micro-dollars. Throws for a model without a price, so spend is never silently zero. */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICE_MICROS_PER_TOKEN[model];
  if (!price) throw new Error(`no price configured for model ${model}`);
  return inputTokens * price.input + outputTokens * price.output;
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

/** The slice of the Anthropic SDK client the adapter uses (an `Anthropic` instance satisfies it). */
export interface MessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: 'user'; content: string }>;
      tools: TriageTool[];
      tool_choice: { type: 'tool'; name: string };
    }): Promise<{
      content: Array<{ type: string; name?: string; input?: unknown }>;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

const MAX_OUTPUT_TOKENS = 1_024;

export class AnthropicTriageModel implements TriageModel {
  private readonly model: string;
  constructor(private readonly deps: { client: MessagesClient; model?: string }) {
    this.model = deps.model ?? TRIAGE_MODEL;
  }

  async triage(prompt: TriagePrompt): Promise<{ result: TriageResult; inputTokens: number; outputTokens: number; model: string }> {
    const response = await this.deps.client.messages.create({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      tools: [TRIAGE_TOOL],
      tool_choice: { type: 'tool', name: TRIAGE_TOOL_NAME },
    });
    const usage: TriageUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: this.model,
    };
    const call = response.content.find((b) => b.type === 'tool_use' && b.name === TRIAGE_TOOL_NAME);
    if (!call) throw new TriageOutputError('the model did not call record_triage', usage);
    const parsed = TriageResult.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new TriageOutputError(`invalid triage output: ${issues}`, usage);
    }
    return { result: parsed.data, ...usage };
  }
}
