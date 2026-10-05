/**
 * SQL for the board and the release: whether a do-not-contact flag on the record is pending
 * (the same rule as `pendingDncFlag` in campaigns/dnc-hold.ts), and whether a person ever
 * dismissed one. Both expect `crm_records` aliased as `r`.
 */
import { sql } from 'drizzle-orm';

/** A flagged triage of the record that is newer than the one a person dismissed (or none was dismissed). */
export const DNC_PENDING_SQL = sql`exists (
  select 1 from record_triage rt
  left join record_triage d on d.id = r.dnc_dismissed_triage_id
  where rt.crm_record_id = r.id and rt.org_id = r.org_id
    and jsonb_typeof(rt.result -> 'doNotContact') = 'object'
    and (d.id is null or (rt.created_at, rt.id) > (d.created_at, d.id))
)`;

/** A person has dismissed some do-not-contact flag on the record. */
export const DNC_EVER_DISMISSED_SQL = sql`(r.dnc_dismissed_triage_id is not null)`;
