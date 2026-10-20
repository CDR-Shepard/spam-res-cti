/**
 * "Preview Sam's email" on Test a record (owner, 2026-10-20: read what Sam would send before email is turned on): the
 * first email Sam would write to any Lead or Opportunity, from a ready preview, without a campaign.
 *
 * Sam is told what a campaign's first email tells her (email/writer-context.ts), read from the test instead: the plan
 * rendered for the voice agent as of now (as a campaign's email and a test call render it), the first name by the same
 * rule (`sellerFirstName`), the local time in the zone of the person's first phone in the dialer's order (the record's
 * field-map phones, then its contact's), and no history (no campaign has written to them). The model call goes through
 * `writeEmail`, so the tenant's daily AI budget is checked first and charged after. The answer comes back as it would be
 * sent (the body cleaned as renderEmail cleans it, the footer every email ends with) with the reasons Send would refuse it
 * as written (`draftIssues`). Nothing is sent, queued or stored: no email, conversation or crm_records row; the draft goes
 * back to the admin and nowhere else. Logs carry ids and outcome codes only.
 */
import { toE164 } from '@cti/phone';
import { EditableCallPlan, FieldMap, type RecordTestEmailPreview } from '@cti/contracts';
import type { Db } from '@cti/db';
import { renderPlanForAgent } from '../ai-calls/plan-text.js';
import { loadConnection } from '../crm/connection-store.js';
import { draftIssues } from '../email/draft-guard.js';
import { cleanBody, previewFooter } from '../email/render.js';
import { localTimeWords, researchBlocks, sellerFirstName, type ResearchBlock } from '../email/writer-context.js';
import { writeEmail, type EmailWriter, type WriterInput } from '../email/writer.js';
import { recipientTimezone } from '../planner/local-time.js';
import type { RequestContext } from '../tenancy/scope.js';
import { loadRecordTest } from './store.js';

export interface EmailPreviewDeps {
  db: Db;
  writer: EmailWriter;
  /** EMAIL_COMPANY_NAME and EMAIL_POSTAL_ADDRESS: the name Sam writes for and the footer's company line. */
  companyName: string;
  postalAddress: string;
  now: Date;
  log: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void };
  /** Bounds the model call (the route's own deadline). */
  signal?: AbortSignal;
}

export type EmailPreviewError = 'not_found' | 'not_ready' | 'over_budget' | 'declined' | 'failed';
export type EmailPreviewOutcome = { ok: true; preview: RecordTestEmailPreview } | { ok: false; error: EmailPreviewError };

/** The contact's phones a campaign reads after the record's own (campaigns/records.ts `snapshotFromRow`). */
const CONTACT_PHONE_FIELDS = ['MobilePhone', 'Phone'];

/** The values of `names` on `block`, in that order, matched in any case. */
function fieldValues(block: ResearchBlock | undefined, names: readonly string[]): string[] {
  if (!block) return [];
  return names.flatMap((name) => block.fields.filter((f) => f.name.toLowerCase() === name.toLowerCase()).map((f) => f.value));
}

/**
 * The first phone that parses: the record's field-map phones in order, then its first contact's (research reads the
 * primary first). Research keeps Phone and MobilePhone on the record whatever its size; a custom phone field
 * (Mobile_Phone__c) can be cut from a very large record, and then the next phone, or Central, sets the zone.
 */
function firstPhone(records: readonly ResearchBlock[], phoneFields: readonly string[]): string | null {
  const self = records.find((b) => b.relation === 'self');
  const contact = records.find((b) => b.relation === 'contact');
  const raw = [...fieldValues(self, phoneFields), ...fieldValues(contact, CONTACT_PHONE_FIELDS)];
  return raw.map((v) => toE164(v.trim())).find((e164): e164 is string => e164 !== null) ?? null;
}

/** The stored plan as the voice agent would get it now; null when it no longer parses or fails the agent's text check. */
function planTextNow(plan: unknown, now: Date): string | null {
  const parsed = EditableCallPlan.safeParse(plan);
  if (!parsed.success) return null;
  const rendered = renderPlanForAgent(parsed.data, now);
  return rendered.ok ? rendered.text : null;
}

/** The tested row as this module reads it. */
export interface TestedRecord {
  sfObject: 'Lead' | 'Opportunity';
  name: string | null;
  plan: unknown;
  research: unknown;
}

/** What Sam is told for the first email to a tested record. `phoneFields`: the tenant's field-map phones for its object. */
export function testWriterInput(t: TestedRecord, o: { now: Date; companyName: string; phoneFields: readonly string[] }): WriterInput {
  const records = researchBlocks((t.research as { records?: unknown } | null)?.records);
  return {
    mode: 'first',
    inbound: null,
    firstName: sellerFirstName(t.sfObject, t.name, records),
    companyName: o.companyName,
    planText: planTextNow(t.plan, o.now),
    history: '',
    localTime: localTimeWords(o.now, recipientTimezone(firstPhone(records, o.phoneFields))),
  };
}

/** The tenant's field-map phones for `sfObject`; none when the field map no longer parses (the contact's still count). */
async function phoneFieldsOf(db: Db, orgId: string, sfObject: 'Lead' | 'Opportunity'): Promise<readonly string[]> {
  const fieldMap = FieldMap.safeParse((await loadConnection(db, orgId))?.fieldMap);
  return fieldMap.success ? fieldMap.data[sfObject].phones : [];
}

/** The first email Sam would write to test `testId` of the caller's tenant. Never throws for a model or budget fault. */
export async function previewTestEmail(deps: EmailPreviewDeps, ctx: RequestContext, testId: string): Promise<EmailPreviewOutcome> {
  const row = await loadRecordTest(deps.db, ctx.orgId, testId, deps.now);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'ready') return { ok: false, error: 'not_ready' };
  const phoneFields = await phoneFieldsOf(deps.db, ctx.orgId, row.sfObject);
  const input = testWriterInput(row, { now: deps.now, companyName: deps.companyName, phoneFields });
  const result = await writeEmail({ db: deps.db, writer: deps.writer, orgId: ctx.orgId, settings: ctx.tenant.settings, now: deps.now, signal: deps.signal, log: deps.log }, input);
  deps.log.info({ orgId: ctx.orgId, testId, outcome: result.kind === 'failed' ? `failed:${result.reason}` : result.kind }, 'record-test: email preview');
  if (result.kind === 'over_budget') return { ok: false, error: 'over_budget' };
  if (result.kind === 'failed') return { ok: false, error: result.reason === 'declined' ? 'declined' : 'failed' };
  const { subject, body } = result.decision;
  return {
    ok: true,
    preview: { subject: subject.trim(), body: cleanBody(body), footer: previewFooter(deps.companyName, deps.postalAddress), issues: draftIssues({ subject, body }) },
  };
}
