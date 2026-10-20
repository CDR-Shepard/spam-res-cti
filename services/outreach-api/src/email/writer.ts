/**
 * Sam's email writer: one model call that either drafts the email or says why it should not be drafted.
 *
 * `EmailWriter` is the port and `AnthropicEmailWriter` its adapter: one structured answer (`email_decision`, the
 * same `requestFor` the call plan model uses), validated with zod before anything uses it. `writeEmail` wraps a
 * writer in the tenant's daily AI budget: it reads the day's spend first, charges what the call cost after, and
 * never throws, so the caller handles three outcomes (a decision, over budget, failed) and nothing else.
 *
 * The seller's words and the model's answer are personal data: nothing here logs them, and a failure's `reason`
 * is a short code that names which check failed, never text from the model or the seller.
 */
import { z } from 'zod';
import { FlagReason } from '@cti/contracts';
import type { Db } from '@cti/db';
import { addSpend, budgetMicros, spentTodayMicros } from '../ai/budget.js';
import { costMicros, isPricedModel, readToolInput, requestFor, type MessagesClient, type TriageTool, type TriageUsage } from '../ai/model.js';
import { outreachSettings } from '../settings.js';
import { buildWriterPrompt, type WriterInput } from './writer-prompt.js';

export type { WriterInput };

export const EMAIL_TOOL_NAME = 'email_decision';
// Claude 5 thinks before it answers: room for that and an email under 150 words.
const MAX_OUTPUT_TOKENS = 4_000;

export const EMAIL_ACTIONS = ['send', 'flag', 'opt_out', 'not_interested', 'no_reply'] as const;
/** The flag reasons Sam may choose herself; the rest of `FlagReason` are raised by the system (a loop guard, a rejected draft). */
export const EMAIL_FLAG_REASONS = ['offer_or_price', 'angry_or_threat', 'legal', 'not_owner', 'wants_appointment', 'unsure'] as const;

/**
 * What Sam decided about the seller's email (or about writing to a seller). A `send` is a draft with a subject and a body;
 * a `flag` names why a person is needed (and its body is the thank-you that says someone will follow up); the other
 * actions need no draft.
 */
export const EmailDecision = z
  .object({
    action: z.enum(EMAIL_ACTIONS),
    flagReason: FlagReason.extract(EMAIL_FLAG_REASONS).nullable(),
    subject: z.string(),
    body: z.string(),
  })
  .superRefine((d, ctx) => {
    if (d.action === 'flag' && d.flagReason === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['flagReason'], message: 'a flag names its reason' });
    if (d.action === 'send' && d.subject.trim() === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'a send has a subject' });
    if (d.action === 'send' && d.body.trim() === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'a send has a body' });
  });
export type EmailDecision = z.infer<typeof EmailDecision>;

export const EMAIL_INPUT_SCHEMA: TriageTool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'flagReason', 'subject', 'body'],
  properties: {
    action: { type: 'string', enum: [...EMAIL_ACTIONS], description: 'send = write to the seller; flag = a person must take over (name the reason); opt_out, not_interested = the seller said so; no_reply = nothing to answer.' },
    flagReason: {
      anyOf: [{ type: 'null' }, { type: 'string', enum: [...EMAIL_FLAG_REASONS] }],
      description: 'Why a person must take over; null unless the action is flag.',
    },
    subject: { type: 'string', description: 'The email subject; empty when nothing is sent.' },
    body: { type: 'string', description: 'The email body in plain text, without signature or footer; empty when nothing is sent.' },
  },
};

export const EMAIL_TOOL: TriageTool = {
  name: EMAIL_TOOL_NAME,
  description: "Record what to do about this seller's email, and the email to send when there is one. Call exactly once.",
  input_schema: EMAIL_INPUT_SCHEMA,
};

export interface EmailWriter {
  /**
   * The model id the calls are made (and priced) with, when the writer knows it: `writeEmail` refuses a model
   * `costMicros` cannot price before it makes any call (a call it could not charge would be free).
   */
  readonly modelId?: string;
  write(
    prompt: { system: string; user: string },
    opts?: { signal?: AbortSignal },
  ): Promise<{ decision: EmailDecision; model: string; inputTokens: number; outputTokens: number }>;
}

/**
 * The model answered, but not with a valid `EmailDecision`. `usage` is what the call cost. The message says only
 * that the answer was unusable (and which fields failed), never what the model wrote.
 */
export class EmailOutputError extends Error {
  constructor(
    message: string,
    readonly usage: TriageUsage,
  ) {
    super(message);
    this.name = 'EmailOutputError';
  }
}

export class AnthropicEmailWriter implements EmailWriter {
  readonly modelId: string;
  constructor(private readonly deps: { client: MessagesClient; model: string }) {
    this.modelId = deps.model;
  }

  async write(prompt: { system: string; user: string }, opts: { signal?: AbortSignal } = {}): Promise<{ decision: EmailDecision; model: string; inputTokens: number; outputTokens: number }> {
    const response = await this.deps.client.messages.create(
      {
        model: this.modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        ...requestFor(this.modelId, EMAIL_TOOL),
      },
      { signal: opts.signal },
    );
    const usage: TriageUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, model: this.modelId };
    const input = readToolInput(response.content, EMAIL_TOOL_NAME);
    if (input === undefined) throw new EmailOutputError('the model did not answer with an email decision', usage);
    const parsed = EmailDecision.safeParse(input);
    if (!parsed.success) {
      // Paths only: a zod message can quote the value it refused.
      throw new EmailOutputError(`invalid email decision: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} (${i.code})`).join('; ')}`, usage);
    }
    return { decision: parsed.data, ...usage };
  }
}

export interface WriteEmailDeps {
  db: Db;
  writer: EmailWriter;
  orgId: string;
  /** `organizations.settings` as stored (the daily AI budget is read from it; junk falls back to the default). */
  settings: unknown;
  now: Date;
  /** Bounds the model call (the caller's own deadline). */
  signal?: AbortSignal;
  /** Where a spend that could not be recorded is said (ids and error names only). */
  log?: { warn(fields: Record<string, unknown>, message: string): void };
}

export type WriteEmailResult = { kind: 'ok'; decision: EmailDecision } | { kind: 'over_budget' } | { kind: 'failed'; reason: string };

const failed = (reason: string): WriteEmailResult => ({ kind: 'failed', reason });
const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * Charges one call to the tenant's day. `unpriced` = the model has no price (nothing is charged: the caller must
 * not use an answer it cannot account for). A spend that cannot be written is logged and the answer is still used:
 * the call is paid for either way, and throwing it away would only pay for it again.
 */
async function charge(deps: WriteEmailDeps, usage: TriageUsage): Promise<'charged' | 'unpriced'> {
  let micros: number;
  try {
    micros = costMicros(usage.model, usage.inputTokens, usage.outputTokens);
  } catch {
    return 'unpriced';
  }
  try {
    await addSpend(deps.db, deps.orgId, deps.now, micros);
  } catch (err) {
    deps.log?.warn({ orgId: deps.orgId, errName: errName(err) }, 'email.write: the cost of the call could not be recorded');
  }
  return 'charged';
}

/** True when the tenant's day has no budget left. */
async function overBudget(deps: WriteEmailDeps): Promise<boolean> {
  const budget = budgetMicros(outreachSettings({ settings: deps.settings }));
  return (await spentTodayMicros(deps.db, deps.orgId, deps.now)) >= budget;
}

async function attempt(deps: WriteEmailDeps, input: WriterInput): Promise<WriteEmailResult> {
  if (deps.writer.modelId !== undefined && !isPricedModel(deps.writer.modelId)) return failed('unpriced_model');
  try {
    if (await overBudget(deps)) return { kind: 'over_budget' };
  } catch (err) {
    deps.log?.warn({ orgId: deps.orgId, errName: errName(err) }, 'email.write: the day\'s AI spend could not be read');
    return failed('budget_unavailable');
  }
  const prompt = buildWriterPrompt(input);
  let answer: Awaited<ReturnType<EmailWriter['write']>>;
  try {
    answer = await deps.writer.write(prompt, { signal: deps.signal });
  } catch (err) {
    if (err instanceof EmailOutputError) {
      await charge(deps, err.usage);
      return failed('invalid_output');
    }
    return failed(deps.signal?.aborted ? 'aborted' : 'model_error');
  }
  if ((await charge(deps, { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, model: answer.model })) === 'unpriced') return failed('unpriced_model');
  // A first email has nobody to answer, so anything but a send is not an answer to use.
  if (input.mode === 'first' && answer.decision.action !== 'send') return failed('invalid_output');
  return { kind: 'ok', decision: answer.decision };
}

/**
 * Asks Sam what to do about one seller. Checks the tenant's budget first (a spent day never reaches the model),
 * charges what the call cost after (an unusable answer costs the same), and never throws.
 */
export async function writeEmail(deps: WriteEmailDeps, input: WriterInput): Promise<WriteEmailResult> {
  try {
    return await attempt(deps, input);
  } catch (err) {
    deps.log?.warn({ orgId: deps.orgId, errName: errName(err) }, 'email.write: unexpected error');
    return failed('unexpected_error');
  }
}
