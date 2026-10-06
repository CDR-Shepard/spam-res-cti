/**
 * Plan 1D write-back: what one row needs from our own database before it touches Salesforce. The call (cti-api's
 * `ai_calls` row, read only), the campaign, the tenant's settings, and the Status or Stage the plan's research saw (CF-6:
 * the research of the touch's plan, never the newest research).
 */
import { sql } from 'drizzle-orm';
import { BookedAppointment } from '@cti/contracts';
import type { Db } from '@cti/db';
import { outreachSettings, type OutreachSettings } from '../settings.js';
import type { WritebackRow } from './store.js';

/** The results page's outcome words (apps/outreach-web lib/call-words.ts OUTCOME_WORDS), copied: outreach-api does not import web code. */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  qualified_transferred: 'Transferred to a person',
  qualified_callback: 'Callback booked',
  not_interested: 'Not interested',
  do_not_call: 'Asked not to be called',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Call failed',
  wrong_number: 'Wrong number',
  hung_up: 'Hung up',
  transfer_failed: 'Transfer missed — call them back',
  blocked: 'Blocked',
  other: 'Other',
  appointment_set: 'Appointment set',
};

export interface WritebackCall {
  outcome: string;
  qualification: Record<string, string>;
  transcript: Array<{ role: string; text: string }>;
  summary: string | null;
  appointment: BookedAppointment | null;
  callbackAt: Date | null;
  isTest: boolean;
  /** A practice call (always also isTest): never written. */
  practice: boolean;
  toE164: string;
  /** When the call ended (the changes header and "ours" for an adopted conversion); null when unknown. */
  endedAt: Date | null;
  /** Who a transfer rang (`handoff_user_id`'s name), for "then transferred to …". */
  transferredTo: string | null;
}

export interface WritebackContext {
  row: WritebackRow;
  call: WritebackCall;
  campaignId: string | null;
  researchStatus: string | null;
  settings: OutreachSettings;
  /** The raw `organizations.settings`, for bookingSettings. */
  orgSettings: unknown;
}

interface Raw {
  outcome: string | null;
  qualification: unknown;
  transcript: unknown;
  summary: string | null;
  appointment: unknown;
  callback_at: Date | string | null;
  is_test: boolean;
  practice: boolean;
  to_e164: string;
  ended_at: Date | string | null;
  handoff_name: string | null;
  campaign_id: string | null;
  org_settings: unknown;
  snapshot: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const date = (v: Date | string | null): Date | null => {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function qualificationOf(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function transcriptOf(v: unknown): Array<{ role: string; text: string }> {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t) => (isObject(t) && typeof t.role === 'string' && typeof t.text === 'string' ? [{ role: t.role, text: t.text }] : []));
}

/** Status (Lead) or StageName (Opportunity) in the research snapshot's self block; null when absent or blank. */
export function researchStatusOf(snapshot: unknown, sfObject: 'Lead' | 'Opportunity'): string | null {
  if (!isObject(snapshot) || !Array.isArray(snapshot.records)) return null;
  const self = snapshot.records.find((b): b is Record<string, unknown> => isObject(b) && b.relation === 'self');
  if (!self || !Array.isArray(self.fields)) return null;
  const name = sfObject === 'Lead' ? 'status' : 'stagename';
  const field = self.fields.find((f): f is Record<string, unknown> => isObject(f) && typeof f.name === 'string' && f.name.toLowerCase() === name);
  const value = typeof field?.value === 'string' ? field.value.trim() : '';
  return value === '' ? null : value;
}

/** The row's call, campaign, settings and research status; null when the call is gone. */
export async function loadWritebackContext(db: Db, row: WritebackRow): Promise<WritebackContext | null> {
  const result = await db.execute(sql`
    select a.outcome, a.qualification, a.transcript, a.summary, a.appointment, a.callback_at, a.is_test, a.practice, a.to_e164, a.ended_at,
           u.display_name as handoff_name, e.campaign_id, o.settings as org_settings, rs.snapshot
    from ai_calls a
    join organizations o on o.id = a.org_id
    left join users u on u.id = a.handoff_user_id
    left join campaign_enrollments e on e.id = ${row.enrollmentId}::uuid and e.org_id = a.org_id
    left join touches t on t.id = ${row.touchId}::uuid and t.org_id = a.org_id
    left join call_plans p on p.id = t.call_plan_id
    left join call_research rs on rs.id = p.research_id
    where a.id = ${row.aiCallId}::uuid and a.org_id = ${row.orgId}::uuid`);
  const raw = (result as unknown as { rows: Raw[] }).rows[0];
  if (!raw) return null;
  const booked = BookedAppointment.safeParse(raw.appointment);
  return {
    row,
    call: {
      outcome: raw.outcome ?? row.outcome,
      qualification: qualificationOf(raw.qualification),
      transcript: transcriptOf(raw.transcript),
      summary: raw.summary,
      appointment: booked.success ? booked.data : null,
      callbackAt: date(raw.callback_at),
      isTest: raw.is_test,
      practice: raw.practice,
      toE164: raw.to_e164,
      endedAt: date(raw.ended_at),
      transferredTo: raw.handoff_name,
    },
    campaignId: raw.campaign_id,
    researchStatus: researchStatusOf(raw.snapshot, row.sfObject),
    settings: outreachSettings({ settings: raw.org_settings }),
    orgSettings: raw.org_settings,
  };
}
