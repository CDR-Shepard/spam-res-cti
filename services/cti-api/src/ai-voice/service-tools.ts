/**
 * What happens when the agent calls a tool.
 *
 * Call CONTROL lives here and is fixed: `end_call` hangs up and
 * `transfer_to_rep` redirects to the rep, each only after the agent's last
 * words have played, and only for the first closer (the registry's `closing`
 * latch — voicemail and bridge failures use the same latch). Bookkeeping
 * around them is best-effort: a database blip must never keep a person on a
 * line they asked to leave.
 *
 * Side EFFECTS (`ToolEffects`) are an injected interface. The defaults here
 * are minimal; Task 7 extends them (Salesforce, callbacks) in this one file.
 *
 * Hard rule: any do-not-call request — `mark_do_not_call`, or `end_call`
 * with outcome `do_not_call` / `wrong_number` — upserts `opt_outs`
 * (shared with the CTI dialer). Plan 1D Part 6: except on a test or practice
 * call, which rings the admin's own phone: the outcome is recorded and the
 * call ends as usual, but that number is never opted out.
 */
import type { AppointmentSlot, BookedAppointment } from '@cti/contracts';
import { END_CALL_OUTCOMES, QUALIFICATION_FIELDS, TRANSFER_REASONS } from './prompt-tools.js';
import type { BridgeLog, ToolResult } from './bridge.js';
import type { ToolName } from './prompt.js';
import { bookAppointment, storeBooking } from './service-booking.js';
import type { AiCallOutcome, AiCallStore } from './store.js';
import { reformatSummary } from './summary.js';
import { TRANSFER_TIME_LIMIT_SECONDS, type AiVoiceTwilio } from './twilio.js';

export interface ToolCtx {
  store: AiCallStore;
  aiCallId: string;
  orgId: string;
  /** The number this call dialed (the opt-out target). */
  toE164: string;
  log: BridgeLog;
  now: () => Date;
  /** The appointment times this call may book (plan 1D); empty = book_appointment books nothing. */
  slots: readonly AppointmentSlot[];
  /**
   * A test or practice call (plan 1D Part 6): it rings an admin's own test number, so a do-not-call ends the call and is
   * recorded but never opts that number out. Absent = a real call.
   */
  isTest?: boolean;
}

export interface ToolEffects {
  /** Opt the number out (idempotent) and record the outcome. Throws if the opt-out cannot be written. */
  markDoNotCall(ctx: ToolCtx, note: string): Promise<void>;
  saveQualification(ctx: ToolCtx, fields: Record<string, string>): Promise<void>;
  scheduleCallback(ctx: ToolCtx, req: { when: string; note: string }): Promise<void>;
  /**
   * A transfer rang out or could not be placed: make sure someone calls them
   * back. `finalized`: the row was already closed (the status callback won the
   * race), so finalize's callback Task has been and gone — this one must make it.
   */
  transferFailed(ctx: ToolCtx, info: { finalized: boolean }): Promise<void>;
  /** Store the booking (plan 1D); 'taken' when another AI call already holds that owner's time (D-10). Throws if it cannot be written. */
  bookAppointment(ctx: ToolCtx, booked: BookedAppointment): Promise<'booked' | 'taken'>;
}

/** How the tool handler acts on the live call (built by the stream session). */
export interface CallControl {
  callSid: string;
  twilio: AiVoiceTwilio;
  /** True for the one caller allowed to end/transfer the call. */
  claimClose(): boolean;
  waitForPlayback(): Promise<void>;
  /** Close the media stream: Twilio runs past `</Connect>` and the call ends. Fallback hang-up. */
  stopStream(): void;
  transferTwiml(reason: string): string;
}

export interface ToolEnv {
  ctx: ToolCtx;
  effects: ToolEffects;
  call: CallControl;
}

const SUMMARY_MAX = 2000;
const QUALIFICATION_MAX = 500;
const WHEN_MAX = 200;
const NOTE_MAX = 500;
const WRONG_NUMBER = /wrong\s*number/i;
/** The summary line a transfer that did not connect leaves (summary.ts carries it through rewrites). */
export const TRANSFER_MISSED_LINE = 'Transfer to a specialist did not connect — call them back.';
/** end_call said appointment_set but nothing was booked: recorded as a callback with this line (summary.ts carries it). */
export const NO_APPOINTMENT_LINE = 'The agent ended as booked, but no appointment was saved — call them back.';
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const field = (args: unknown, key: string): unknown =>
  args !== null && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** An exact ISO 8601 time, else null (free text such as "Thursday after 5" stays text). */
export function parseCallbackAt(when: string): Date | null {
  if (!ISO_8601.test(when)) return null;
  const ms = Date.parse(when);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

async function bestEffort(ctx: ToolCtx, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    ctx.log.error({ aiCallId: ctx.aiCallId, what, err: errText(e) }, 'ai-voice: call bookkeeping failed');
  }
}

/** Upsert `opt_outs` (idempotent), retrying once; throws if it still fails. Never for a test or practice call (the admin's phone). */
async function writeOptOut(ctx: ToolCtx, note: string): Promise<void> {
  if (ctx.isTest) {
    ctx.log.info({ aiCallId: ctx.aiCallId }, 'ai-voice: do-not-call on a test or practice call; the test number is not opted out');
    return;
  }
  try {
    await ctx.store.upsertOptOut(ctx.orgId, ctx.toE164, note);
  } catch (first) {
    ctx.log.warn({ aiCallId: ctx.aiCallId, err: errText(first) }, 'ai-voice: opt-out write failed, retrying');
    await ctx.store.upsertOptOut(ctx.orgId, ctx.toE164, note);
  }
}

export const defaultToolEffects: ToolEffects = {
  async markDoNotCall(ctx, note) {
    await writeOptOut(ctx, note);
    await ctx.store.setOutcome(ctx.aiCallId, WRONG_NUMBER.test(note) ? 'wrong_number' : 'do_not_call', null);
  },
  async saveQualification(ctx, fields) {
    await ctx.store.mergeQualification(ctx.aiCallId, fields);
  },
  async scheduleCallback(ctx, req) {
    await ctx.store.update(ctx.aiCallId, { callbackAt: parseCallbackAt(req.when) });
    await ctx.store.appendSummary(ctx.aiCallId, `Callback requested: ${req.when}${req.note ? ` — ${req.note}` : ''}`);
  },
  async transferFailed(ctx, info) {
    if (!info.finalized) return ctx.store.appendSummary(ctx.aiCallId, TRANSFER_MISSED_LINE);
    // Finalize already wrote the formatted summary with the old outcome: re-render it.
    const row = await ctx.store.get(ctx.aiCallId);
    if (!row) return;
    const summary = reformatSummary(row.summary, {
      qualification: row.qualification,
      outcome: row.outcome,
      aiCallId: row.id,
      extra: [TRANSFER_MISSED_LINE],
    });
    await ctx.store.update(ctx.aiCallId, { summary });
  },
  bookAppointment: storeBooking,
};

/** After the agent's last words have played, run `act`; never throws. */
function afterPlayback(env: ToolEnv, what: string, act: () => Promise<void>): void {
  void (async () => {
    try {
      await env.call.waitForPlayback();
      await act();
    } catch (e) {
      env.ctx.log.error({ aiCallId: env.ctx.aiCallId, what, err: errText(e) }, 'ai-voice: call control failed');
    }
  })();
}

/** REST hang-up, falling back to closing the stream (which also ends the call). */
async function hangUp(env: ToolEnv): Promise<void> {
  try {
    await env.call.twilio.hangup(env.call.callSid);
  } catch (e) {
    env.ctx.log.warn({ aiCallId: env.ctx.aiCallId, err: errText(e) }, 'ai-voice: hangup failed, closing the stream');
    env.call.stopStream();
  }
}

/**
 * Redirect to the rep, lifting the AI call's time limit so the rep's
 * conversation is not cut off. If Twilio refuses that, a plain redirect is
 * still better than dropping the hand-off.
 */
async function redirectToRep(env: ToolEnv, twiml: string): Promise<void> {
  try {
    await env.call.twilio.redirect(env.call.callSid, twiml, { timeLimit: TRANSFER_TIME_LIMIT_SECONDS });
  } catch (e) {
    env.ctx.log.warn({ aiCallId: env.ctx.aiCallId, err: errText(e) }, 'ai-voice: transfer with time limit refused, retrying without');
    await env.call.twilio.redirect(env.call.callSid, twiml);
  }
}

/** The closing outcome; its summary is APPENDED so lines the tools wrote earlier (a callback time) survive. */
async function recordOutcome(ctx: ToolCtx, outcome: AiCallOutcome, summary: string | null): Promise<void> {
  await ctx.store.setOutcome(ctx.aiCallId, outcome, null);
  if (summary) await ctx.store.appendSummary(ctx.aiCallId, summary);
}

/** Was a booking stored for this call? A failed read counts as no. */
async function hasAppointment(ctx: ToolCtx): Promise<boolean> {
  try {
    return ((await ctx.store.get(ctx.aiCallId))?.appointment ?? null) !== null;
  } catch (e) {
    ctx.log.warn({ aiCallId: ctx.aiCallId, err: errText(e) }, 'ai-voice: appointment read failed, taken as no appointment');
    return false;
  }
}

const ALREADY_ENDING: ToolResult = { output: 'already ending', then: 'hangup' };

/**
 * The outcome is written only by the closer that wins `claimClose` (a
 * voicemail, transfer or failure that got there first owns the row). A
 * do-not-call request is honoured either way. `wrong_number` may replace the
 * `do_not_call` that mark_do_not_call wrote for the same wrong number; no
 * other outcome overwrites `do_not_call` (store.setOutcome).
 */
async function endCall(args: unknown, env: ToolEnv): Promise<ToolResult> {
  const { ctx } = env;
  const outcome = oneOf<AiCallOutcome>(field(args, 'outcome'), END_CALL_OUTCOMES, 'other');
  const summary = text(field(args, 'summary'), SUMMARY_MAX) || null;
  const optOut = outcome === 'do_not_call' || outcome === 'wrong_number';
  const note = outcome === 'wrong_number' ? 'wrong number' : 'asked not to be called';
  const claimed = env.call.claimClose();
  if (!claimed) {
    if (optOut) await bestEffort(ctx, 'opt_out', () => writeOptOut(ctx, note));
    return ALREADY_ENDING;
  }
  if (optOut) await bestEffort(ctx, 'opt_out', () => env.effects.markDoNotCall(ctx, note));
  await bestEffort(ctx, 'outcome', async () => {
    if (outcome === 'wrong_number') await ctx.store.replaceOutcome(ctx.aiCallId, 'do_not_call', 'wrong_number');
    if (outcome === 'appointment_set' && !(await hasAppointment(ctx))) {
      await recordOutcome(ctx, 'qualified_callback', summary);
      await ctx.store.appendSummary(ctx.aiCallId, NO_APPOINTMENT_LINE);
      return;
    }
    // I-1: a booked call whose line went quiet ends booked, exactly as when the caller hangs up (finalize keeps it).
    if (outcome === 'hung_up' && ctx.slots.length > 0 && (await hasAppointment(ctx))) {
      await recordOutcome(ctx, 'appointment_set', summary);
      return;
    }
    await recordOutcome(ctx, outcome, summary);
  });
  afterPlayback(env, 'hangup', () => hangUp(env));
  return { output: 'ending', then: 'hangup' };
}

async function transferToRep(args: unknown, env: ToolEnv): Promise<ToolResult> {
  const { ctx } = env;
  if (!env.call.claimClose()) return ALREADY_ENDING;
  const reason = oneOf(field(args, 'reason'), TRANSFER_REASONS, 'question');
  const summary = text(field(args, 'summary'), SUMMARY_MAX) || null;
  await bestEffort(ctx, 'transferring', async () => {
    await ctx.store.updateWhereStatus(ctx.aiCallId, ['ringing', 'in_progress'], { status: 'transferring' });
    await recordOutcome(ctx, 'qualified_transferred', summary);
  });
  afterPlayback(env, 'transfer', async () => {
    const twiml = env.call.transferTwiml(reason);
    try {
      await redirectToRep(env, twiml);
    } catch (e) {
      ctx.log.error({ aiCallId: ctx.aiCallId, err: errText(e) }, 'ai-voice: transfer redirect failed');
      await bestEffort(ctx, 'transfer_failed', async () => {
        await ctx.store.replaceOutcome(ctx.aiCallId, 'qualified_transferred', 'transfer_failed');
        await env.effects.transferFailed(ctx, { finalized: false });
      });
      await hangUp(env);
    }
  });
  return { output: 'transferring', then: 'transfer' };
}

function qualificationFields(args: unknown): Record<string, string> {
  return Object.fromEntries(
    QUALIFICATION_FIELDS.flatMap((k) => {
      const v = text(field(args, k), QUALIFICATION_MAX);
      return v ? [[k, v] as const] : [];
    }),
  );
}

/** The bridge's `hooks.onTool`. A throw here becomes `{"error":"tool failed"}` for the model. */
export async function handleToolCall(name: ToolName, args: unknown, env: ToolEnv): Promise<ToolResult> {
  const { ctx, effects } = env;
  switch (name) {
    case 'end_call':
      return endCall(args, env);
    case 'transfer_to_rep':
      return transferToRep(args, env);
    case 'mark_do_not_call':
      await effects.markDoNotCall(ctx, text(field(args, 'note'), NOTE_MAX) || 'asked not to be called');
      return { output: 'done — say a brief goodbye and end the call', then: 'continue' };
    case 'save_qualification':
      await effects.saveQualification(ctx, qualificationFields(args));
      return { output: 'saved', then: 'continue' };
    case 'schedule_callback':
      await effects.scheduleCallback(ctx, {
        when: text(field(args, 'when'), WHEN_MAX),
        note: text(field(args, 'note'), NOTE_MAX),
      });
      return { output: 'scheduled', then: 'continue' };
    case 'book_appointment':
      return bookAppointment(args, env);
    default: {
      const never: never = name;
      return { output: `{"error":"unknown tool ${String(never)}"}` };
    }
  }
}
