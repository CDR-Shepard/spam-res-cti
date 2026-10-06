/**
 * The call plan port and its Anthropic adapter: one forced tool call (`record_call_plan`)
 * whose input schema mirrors `CallPlan`, validated with zod before anything uses it.
 */
import { CALL_GOAL_KEYS, CallPlan, DoNotContactCategory, EvidenceSource, PreferredWindow, QUALIFICATION_TOPICS } from '@cti/contracts';
import type { MessagesClient, TriageTool, TriageUsage } from './model.js';

export const CALL_PLAN_MODEL_DEFAULT = 'claude-sonnet-5-5';
export const CALL_PLAN_TOOL_NAME = 'record_call_plan';
const MAX_OUTPUT_TOKENS = 3_000;

const text = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const list = (maxLength: number, maxItems: number, minItems = 0) => ({ type: 'array', minItems, maxItems, items: text(maxLength) });

export const CALL_PLAN_INPUT_SCHEMA: TriageTool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['situationSummary', 'sellingSignals', 'opener', 'goals', 'talkingPoints', 'questions', 'avoid', 'bestTimeToCall', 'doNotContact', 'reengagement', 'stillToLearn'],
  properties: {
    situationSummary: { ...text(800), description: 'Three to five plain sentences: who they are, the property, what happened so far, where things stand.' },
    sellingSignals: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['signal', 'evidence', 'source', 'strength'],
        properties: {
          signal: text(200),
          evidence: { ...text(300), description: 'Words copied from the data.' },
          source: { type: 'string', enum: [...EvidenceSource.options] },
          strength: { type: 'string', enum: ['strong', 'moderate', 'weak'] },
        },
      },
    },
    opener: { ...text(300), description: 'What to say after the AI disclosure, once they agree to a minute. No price, no pressure.' },
    goals: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      description: `Exactly one entry for each of: ${CALL_GOAL_KEYS.join(', ')}.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goal', 'known', 'approach'],
        properties: {
          goal: { type: 'string', enum: [...CALL_GOAL_KEYS] },
          known: { type: ['string', 'null'], maxLength: 300 },
          approach: text(300),
        },
      },
    },
    talkingPoints: list(200, 8),
    questions: list(200, 10, 1),
    avoid: list(200, 8),
    bestTimeToCall: {
      type: 'object',
      additionalProperties: false,
      required: ['window', 'reason'],
      properties: { window: { type: 'string', enum: [...PreferredWindow.options] }, reason: { type: 'string', maxLength: 200 } },
    },
    doNotContact: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'quote'],
          properties: { category: { type: 'string', enum: [...DoNotContactCategory.options] }, quote: text(300) },
        },
      ],
    },
    // Plan 1D. lastContact is replaced by our computed words after parsing (call-plans/plan-context.ts).
    reengagement: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['lastContact', 'lastTopic'],
          properties: { lastContact: { type: ['string', 'null'], maxLength: 80 }, lastTopic: { type: ['string', 'null'], maxLength: 200 } },
        },
      ],
      description: 'Null when the facts show no last real contact. Otherwise lastContact is the facts\' words exactly, and lastTopic what that contact was about, with no digits.',
    },
    stillToLearn: {
      type: 'array',
      maxItems: 9,
      items: { type: 'string', enum: [...QUALIFICATION_TOPICS] },
      description: "Only topics from the facts' missing list that this call should learn.",
    },
  },
};

export const CALL_PLAN_TOOL: TriageTool = {
  name: CALL_PLAN_TOOL_NAME,
  description: 'Record the call plan for one homeowner. Call exactly once.',
  input_schema: CALL_PLAN_INPUT_SCHEMA,
};

export interface CallPlanResult {
  plan: CallPlan;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CallPlanModel {
  /** The model id calls are made (and priced) with; the tick refuses a model `costMicros` cannot price. */
  readonly modelId: string;
  /** `signal` aborts the model call (the tick's per-lead bound). */
  plan(prompt: { system: string; user: string }, opts?: { signal?: AbortSignal }): Promise<CallPlanResult>;
}

/** Which check failed, never what the model wrote: safe to log. */
export interface PlanIssue {
  path: string;
  code: string;
}

/**
 * The model answered, but not with a valid `CallPlan`. `usage` is what the call cost.
 * `rawDoNotContact` is the unvalidated `doNotContact` of the tool input (undefined when there was none):
 * a flag must not be lost because the rest of the plan was unusable, so the tick validates it on its own.
 */
export class CallPlanOutputError extends Error {
  readonly issues: PlanIssue[];
  readonly rawDoNotContact: unknown;
  constructor(
    message: string,
    readonly usage: TriageUsage,
    detail: { issues?: PlanIssue[]; rawDoNotContact?: unknown } = {},
  ) {
    super(message);
    this.name = 'CallPlanOutputError';
    this.issues = detail.issues ?? [];
    this.rawDoNotContact = detail.rawDoNotContact;
  }
}

export class AnthropicCallPlanModel implements CallPlanModel {
  readonly modelId: string;
  constructor(private readonly deps: { client: MessagesClient; model?: string }) {
    this.modelId = deps.model ?? CALL_PLAN_MODEL_DEFAULT;
  }

  async plan(prompt: { system: string; user: string }, opts: { signal?: AbortSignal } = {}): Promise<CallPlanResult> {
    const response = await this.deps.client.messages.create(
      {
        model: this.modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        tools: [CALL_PLAN_TOOL],
        tool_choice: { type: 'tool', name: CALL_PLAN_TOOL_NAME },
      },
      { signal: opts.signal },
    );
    const usage: TriageUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, model: this.modelId };
    const call = response.content.find((b) => b.type === 'tool_use' && b.name === CALL_PLAN_TOOL_NAME);
    if (!call) throw new CallPlanOutputError('the model did not call record_call_plan', usage);
    const parsed = CallPlan.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', code: i.code }));
      const rawDoNotContact = (call.input as { doNotContact?: unknown } | null | undefined)?.doNotContact;
      throw new CallPlanOutputError(`invalid call plan: ${issues.map((i) => `${i.path} (${i.code})`).join('; ')}`, usage, { issues, rawDoNotContact });
    }
    return { plan: parsed.data, ...usage };
  }
}
