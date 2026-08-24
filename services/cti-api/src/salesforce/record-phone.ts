import { soqlEscape, soqlQuery } from './client.js';
import { normalize } from '../phone.js';

/**
 * Pick the primary (first-dialed) and fallback (dial-on-true-no-answer) raw
 * numbers. Mobile is the primary and the Phone is the fallback; with no Mobile
 * the Phone is the primary and there is no fallback. Dedup of Mobile == Phone
 * happens after normalization in `resolveDialNumber` (raw formats can differ).
 */
export function choosePhones(
  mobile: string | null | undefined,
  phone: string | null | undefined,
): { primaryRaw: string | null; fallbackRaw: string | null } {
  const m = mobile?.trim();
  const p = phone?.trim();
  if (m) return { primaryRaw: m, fallbackRaw: p || null };
  if (p) return { primaryRaw: p, fallbackRaw: null };
  return { primaryRaw: null, fallbackRaw: null };
}

type PhoneFields = { MobilePhone?: string | null; Phone?: string | null };

/** A record the lookup actually found: its phone fields (possibly empty) and
 *  whether Skip on Dialer is checked. Null from a lookup means "no such record". */
type FoundRecord = { fields: PhoneFields; skipOnDialer: boolean };

/** What one record answers about being dialed. `e164` is null when the record
 *  exists but has no dialable number — `resolveDialNumber` returns null only
 *  when the record itself is missing, because a found record still has to
 *  report its Skip on Dialer checkbox (skip beats unreachable). */
export interface DialTarget {
  e164: string | null;
  fallbackE164: string | null;
  skipOnDialer: boolean;
}

/** The rep-facing "don't power-dial this one" checkbox. It lives on Lead and
 *  Opportunity only — Contact has no such field, so a Contact is never flagged. */
const SKIP_FIELD = 'Skip_on_Dialer__c';

/** Warn deduper ONLY. It must never gate the query itself: this process serves
 *  many orgs (salesforce_connections is per user), so one org missing the field
 *  cannot decide what we ask every other org. */
let warnedSkipField = false;

/** Drop the warn-once flag. Tests only. */
export function _resetSkipFieldWarnForTests(): void {
  warnedSkipField = false;
}

/**
 * Run `withField`, and in an org that has not got `Skip_on_Dialer__c` (a dev org,
 * or prod mid-deploy) fall back to `withoutField` for THIS lookup. A missing
 * field is a configuration fact, not a failure: deploy order must never be able
 * to stop the dialer. The log line is deduped; the query is not.
 *
 * Salesforce answers INVALID_FIELD for BOTH causes — the field is absent from the
 * org, and the querying user lacks field-level read on it — and the error cannot
 * tell them apart. So this also fails open for an unassigned rep, who then
 * power-dials records their manager flagged. That is the specified trade (deploy
 * order can never break dialing).
 *
 * Know the limit of the warn before you rely on it: the dedupe is process-wide,
 * so only the FIRST affected connection is ever named. One org still missing the
 * field burns the single line, and a later FLS denial on a different connection
 * is then completely silent. Naming every affected connection needs per-user
 * dedupe, which emits more than the once-per-process the brief specifies — a
 * spec change, not a local fix.
 */
async function soqlToleratingMissingSkipField<T>(
  userId: string,
  withField: string,
  withoutField: string,
): Promise<T[]> {
  try {
    return await soqlQuery<T>(userId, withField);
  } catch (err) {
    if (!/INVALID_FIELD/.test((err as Error).message)) throw err;
    if (!warnedSkipField) {
      warnedSkipField = true;
      console.warn(
        `[record-phone] ${SKIP_FIELD} unreadable for connection user ${userId} ` +
          `(field absent from the org, or no field-level read on it) — ` +
          `that connection's power-dial queues treat every record as unflagged`,
      );
    }
    return await soqlQuery<T>(userId, withoutField);
  }
}

async function lookupLead(userId: string, rid: string): Promise<FoundRecord | null> {
  const rows = await soqlToleratingMissingSkipField<PhoneFields & { Skip_on_Dialer__c?: boolean | null }>(
    userId,
    `SELECT MobilePhone, Phone, ${SKIP_FIELD} FROM Lead WHERE Id = '${rid}' LIMIT 1`,
    `SELECT MobilePhone, Phone FROM Lead WHERE Id = '${rid}' LIMIT 1`,
  );
  const row = rows[0];
  return row ? { fields: row, skipOnDialer: row.Skip_on_Dialer__c === true } : null;
}

async function lookupContact(userId: string, rid: string): Promise<FoundRecord | null> {
  // No skip field on Contact — never ask for it, never flag one.
  const rows = await soqlQuery<PhoneFields>(userId, `SELECT MobilePhone, Phone FROM Contact WHERE Id = '${rid}' LIMIT 1`);
  const row = rows[0];
  return row ? { fields: row, skipOnDialer: false } : null;
}

/** Primary Opportunity Contact Role → Contact phone, with the Opportunity's own
 *  checkbox read through the same parent traversal (one round trip). No primary
 *  contact role means there is nothing to dial and nothing to read. */
async function lookupOpportunity(userId: string, rid: string): Promise<FoundRecord | null> {
  type Row = {
    Contact?: PhoneFields | null;
    Opportunity?: { Skip_on_Dialer__c?: boolean | null } | null;
  };
  const where = `WHERE OpportunityId = '${rid}' AND IsPrimary = true LIMIT 1`;
  const rows = await soqlToleratingMissingSkipField<Row>(
    userId,
    `SELECT Contact.MobilePhone, Contact.Phone, Opportunity.${SKIP_FIELD} FROM OpportunityContactRole ${where}`,
    `SELECT Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole ${where}`,
  );
  const row = rows[0];
  return row ? { fields: row.Contact ?? {}, skipOnDialer: row.Opportunity?.Skip_on_Dialer__c === true } : null;
}

/**
 * The number a power-dial run should call for one record, plus whether the rep
 * has checked Skip on Dialer on it.
 *
 * Null means the RECORD is missing (or invisible to this rep). A record that
 * exists but has no dialable number comes back with `e164: null` — the queue
 * needs its checkbox either way, since a flagged record must read as skipped
 * rather than merely unreachable.
 */
export async function resolveDialNumber(
  userId: string,
  objectType: 'Lead' | 'Contact' | 'Opportunity',
  recordId: string,
): Promise<DialTarget | null> {
  const rid = soqlEscape(recordId);
  const found = objectType === 'Lead'
    ? await lookupLead(userId, rid)
    : objectType === 'Contact'
      ? await lookupContact(userId, rid)
      : await lookupOpportunity(userId, rid);
  if (!found) return null;

  const { skipOnDialer } = found;
  const { primaryRaw, fallbackRaw } = choosePhones(found.fields.MobilePhone, found.fields.Phone);
  const primary = primaryRaw ? normalize(primaryRaw) : null;
  if (!primary?.ok || !primary.value) return { e164: null, fallbackE164: null, skipOnDialer };
  const e164 = primary.value.e164;

  let fallbackE164: string | null = null;
  if (fallbackRaw) {
    const fb = normalize(fallbackRaw);
    // Only a valid, DISTINCT number is a real fallback — a Phone that equals the
    // Mobile (common) would just re-dial the same line.
    if (fb.ok && fb.value && fb.value.e164 !== e164) fallbackE164 = fb.value.e164;
  }
  return { e164, fallbackE164, skipOnDialer };
}
