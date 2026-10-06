/**
 * Test a record, running the call (plan 1E Task 8, spec §4.3): a ready preview is rung as a 1D practice call, either to
 * one of the admin test numbers (`practice`) or to the admin's own browser tab (`practice_browser`, an incoming-only token
 * from cti-api, browser-token.ts there).
 *
 * The guarantees it carries (spec §7):
 *   G-2  cti-api writes the call as is_test + practice: no Salesforce write, booking, conversion, opt-out, touch or
 *        write-back. Nothing here writes anything but the ai_record_test_calls row.
 *   G-3  only a number on AI_VOICE_TEST_NUMBERS, or `aitest_<this admin>_…`, is ever sent: checked here for the words,
 *        decided by cti-api's gate.
 *   G-5  the plan text is rendered afresh from the stored plan and checked (renderPlanForAgent) before any trigger.
 *   G-8  the test is read org-scoped; another tenant's is not_found.
 *
 * The limits (one live call, six an hour per admin, limits.ts) are checked and the row inserted under the admin's
 * advisory lock. Logs carry ids and codes only: never the number, the identity or the plan text.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { EditableCallPlan, aiTestIdentityUser, type InternalAiCallResponse, type InternalAiCallTarget, type RecordTestCallRequest } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { CtiClient } from '../ai-calls/cti-client.js';
import { renderPlanForAgent } from '../ai-calls/plan-text.js';
import { practiceSlots, testNumber } from '../ai-calls/practice.js';
import { describePlanTextIssues } from '../call-plans/plan-text-words.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import type { RunnerLogger } from '../jobs/boss.js';
import type { RequestContext } from '../tenancy/scope.js';
import { withCallLimit, type LimitRefusal } from './limits.js';
import { loadRecordTest } from './store.js';

export type RunError = 'not_found' | 'not_ready' | 'plan_text_rejected' | 'not_a_test_number' | 'not_your_browser' | 'cti_unreachable';
export type RunResult =
  | { ok: true; response: InternalAiCallResponse; callId: string }
  | { ok: false; error: RunError; words?: string[] }
  | { ok: false; refusal: LimitRefusal };

export interface RunDeps {
  db: Db;
  clients: SalesforceClientFactory;
  cti: CtiClient;
  now: Date;
  log: RunnerLogger;
  /** AI_CALL_DEFAULT_SPECIALISTS: the appointment owner list of a tenant that has saved none. */
  defaultSpecialists: readonly string[];
}

type Destination = { mode: 'phone'; to: string } | { mode: 'browser'; identity: string };

/** Only the admin's own test number or own browser identity (G-3); the gate in cti-api decides again. */
async function destination(deps: RunDeps, ctx: RequestContext, body: RecordTestCallRequest): Promise<Destination | RunError> {
  if (body.mode === 'browser') {
    const owner = aiTestIdentityUser(body.identity);
    return owner !== null && owner === ctx.session.userId.toLowerCase() ? { mode: 'browser', identity: body.identity } : 'not_your_browser';
  }
  const to = await testNumber(deps.cti, body.to);
  if (to === 'unreachable') return 'cti_unreachable';
  return to === null ? 'not_a_test_number' : { mode: 'phone', to };
}

export async function startRecordTestCall(deps: RunDeps, ctx: RequestContext, testId: string, body: RecordTestCallRequest): Promise<RunResult> {
  const { db, now } = deps;
  const test = await loadRecordTest(db, ctx.orgId, testId, now);
  if (!test) return { ok: false, error: 'not_found' };
  const plan = EditableCallPlan.safeParse(test.plan);
  if (test.status !== 'ready' || !plan.success) return { ok: false, error: 'not_ready' };
  const rendered = renderPlanForAgent(plan.data, now);
  if (!rendered.ok) return { ok: false, error: 'plan_text_rejected', words: describePlanTextIssues(plan.data, rendered.issues) };
  const dest = await destination(deps, ctx, body);
  if (typeof dest === 'string') return { ok: false, error: dest };

  const context = { returning: plan.data.reengagement?.lastContact != null };
  // The request's tenant row already holds the settings (requireContext read it).
  const slots = await practiceSlots(deps, ctx.orgId, ctx.tenant.settings, 'record-test.call');
  const userId = ctx.session.userId;
  const idempotencyKey = `rtest:${randomUUID()}`;
  const inserted = await withCallLimit(db, { orgId: ctx.orgId, userId, now }, async (tx) => {
    const [row] = await tx
      .insert(schema.aiRecordTestCalls)
      .values({
        orgId: ctx.orgId,
        recordTestId: test.id,
        requestedBy: userId,
        mode: dest.mode,
        toE164: dest.mode === 'phone' ? dest.to : null,
        clientIdentity: dest.mode === 'browser' ? dest.identity : null,
        idempotencyKey,
        // The limits read created_at against this same clock.
        createdAt: now,
      })
      .returning({ id: schema.aiRecordTestCalls.id });
    return row!.id;
  });
  if (!inserted.ok) return { ok: false, refusal: inserted.refusal };
  const callId = inserted.value;

  const record = { objectType: test.sfObject, recordId: test.sfRecordId, planText: rendered.text, context, ...(slots.length ? { slots } : {}) };
  const target: InternalAiCallTarget =
    dest.mode === 'phone' ? { kind: 'practice', ...record, to: dest.to } : { kind: 'practice_browser', ...record, clientIdentity: dest.identity };
  const answer = await deps.cti.trigger({ orgId: ctx.orgId, userId, idempotencyKey, target });
  // A test key is never re-sent, so a 409 is as final as a transport failure: the row keeps a null result (as 1D practice).
  if (answer.kind !== 'response') {
    deps.log.warn({ orgId: ctx.orgId, testId, callId, transport: answer.kind === 'transport' ? answer.error : 'conflict' }, 'record-test: cti-api did not answer');
    return { ok: false, error: 'cti_unreachable' };
  }
  await db
    .update(schema.aiRecordTestCalls)
    .set({ result: answer.response, aiCallId: answer.response.aiCallId ?? null })
    .where(eq(schema.aiRecordTestCalls.id, callId));
  deps.log.info({ orgId: ctx.orgId, testId, callId, mode: dest.mode, result: answer.response.result }, 'record-test: trigger answered');
  return { ok: true, response: answer.response, callId };
}
