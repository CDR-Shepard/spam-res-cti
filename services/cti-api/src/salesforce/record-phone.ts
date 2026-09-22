import { soqlEscape, soqlQuery } from './client.js';
import { normalize } from '@cti/phone';

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
type NameField = { Name?: string | null };

/** A record the lookup actually found: its phone fields (possibly empty),
 *  whether Skip on Dialer is checked, and what to headline for it. Null from a
 *  lookup means "no such record". */
type FoundRecord = { fields: PhoneFields; skipOnDialer: boolean; displayName: string | null; contactId: string | null };

/** What one record answers about being dialed. `e164` is null when the record
 *  exists but has no dialable number — `resolveDialNumber` returns null only
 *  when the record itself is missing, because a found record still has to
 *  report its Skip on Dialer checkbox (skip beats unreachable). */
export interface DialTarget {
  e164: string | null;
  fallbackE164: string | null;
  skipOnDialer: boolean;
  /** What the panel headlines from the first ring: a Lead's or Contact's
   *  `Name`; for an Opportunity its own `Name`, which the caller swaps for the
   *  primary contact's once `contactId` resolves (see `fetchContactNames`).
   *  Null when the record has no name — never "". */
  displayName: string | null;
  /** Opportunity only — `Opportunity.ContactId`, so the caller can look every
   *  contact's name up in ONE batched query for the whole run instead of one
   *  per record. `Contact.Name` is not traversable from Opportunity in SOQL,
   *  which is why this is an id and not a name. Null on Lead/Contact. */
  contactId: string | null;
}

/** Salesforce's `Name` as the card should show it: trimmed, and null rather
 *  than "" so the card can fall back to the number instead of headlining
 *  nothing. */
function cleanName(raw: string | null | undefined): string | null {
  const name = raw?.trim();
  return name ? name : null;
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
  const rows = await soqlToleratingMissingSkipField<PhoneFields & NameField & { Skip_on_Dialer__c?: boolean | null }>(
    userId,
    `SELECT Name, MobilePhone, Phone, ${SKIP_FIELD} FROM Lead WHERE Id = '${rid}' LIMIT 1`,
    `SELECT Name, MobilePhone, Phone FROM Lead WHERE Id = '${rid}' LIMIT 1`,
  );
  const row = rows[0];
  return row
    ? { fields: row, skipOnDialer: row.Skip_on_Dialer__c === true, displayName: cleanName(row.Name), contactId: null }
    : null;
}

async function lookupContact(userId: string, rid: string): Promise<FoundRecord | null> {
  // No skip field on Contact — never ask for it, never flag one.
  const rows = await soqlQuery<PhoneFields & NameField>(userId, `SELECT Name, MobilePhone, Phone FROM Contact WHERE Id = '${rid}' LIMIT 1`);
  const row = rows[0];
  return row ? { fields: row, skipOnDialer: false, displayName: cleanName(row.Name), contactId: null } : null;
}

/** The Opportunity's own phone fields, in dial order. This org stores phones
 *  on the Opportunity — 92% of open Opportunities carry one of these, only 42%
 *  have any Contact Role — so these come first and the Contact Role is the
 *  fallback. Custom fields: a dev org without them fails the lookup loudly
 *  (INVALID_FIELD on the retry too), which is the right answer for an org this
 *  code was never configured for. */
const OPP_PHONE_FIELDS = ['Mobile_Phone__c', 'Phone__c', 'Other_Phone__c'] as const;
type OppPhoneRow = Partial<Record<(typeof OPP_PHONE_FIELDS)[number], string | null>> & NameField & {
  Skip_on_Dialer__c?: boolean | null;
  /** The primary contact — filled on ~42% of open Opportunities here, and NOT
   *  traversable (`Contact.Name` fails "Didn't understand relationship"), so
   *  the name is resolved later, batched, by `fetchContactNames`. */
  ContactId?: string | null;
};

/** Fold the three Opportunity fields into the two-slot shape the rest of the
 *  lookup dials: primary = the first non-empty in order, fallback = the next
 *  non-empty. Exported for its tests. */
export function opportunityPhones(row: OppPhoneRow): PhoneFields {
  const present = OPP_PHONE_FIELDS.map((f) => row[f]?.trim()).filter((v): v is string => !!v);
  return { MobilePhone: present[0] ?? null, Phone: present[1] ?? null };
}

/** Primary Opportunity Contact Role → Contact phone. Consulted only when the
 *  Opportunity's own fields are all empty; the checkbox was already read from
 *  the Opportunity, so it is not asked for again here. No primary contact role
 *  means there is nothing to dial. */
async function lookupOpportunityContactRole(userId: string, rid: string): Promise<PhoneFields | null> {
  type Row = { Contact?: PhoneFields | null };
  const rows = await soqlQuery<Row>(
    userId,
    `SELECT Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole WHERE OpportunityId = '${rid}' AND IsPrimary = true LIMIT 1`,
  );
  const row = rows[0];
  return row ? row.Contact ?? {} : null;
}

/** The Opportunity's own fields first (with its Skip on Dialer checkbox in the
 *  same round trip, tolerating an org without the field exactly as the Lead
 *  branch does); the primary Contact Role's phone only when all three are
 *  empty. A missing Opportunity is null; one with no number anywhere is
 *  found-but-empty, so the queue still honors its checkbox. */
async function lookupOpportunity(userId: string, rid: string): Promise<FoundRecord | null> {
  const fields = `Name, ContactId, ${OPP_PHONE_FIELDS.join(', ')}`;
  const rows = await soqlToleratingMissingSkipField<OppPhoneRow>(
    userId,
    `SELECT ${fields}, ${SKIP_FIELD} FROM Opportunity WHERE Id = '${rid}' LIMIT 1`,
    `SELECT ${fields} FROM Opportunity WHERE Id = '${rid}' LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const skipOnDialer = row.Skip_on_Dialer__c === true;
  // The Opportunity's own Name is the headline until the caller's batched
  // contact lookup replaces it; the id rides along so that lookup can happen.
  const naming = { displayName: cleanName(row.Name), contactId: row.ContactId || null };
  const own = opportunityPhones(row);
  if (own.MobilePhone) return { fields: own, skipOnDialer, ...naming };
  const contact = await lookupOpportunityContactRole(userId, rid);
  return { fields: contact ?? {}, skipOnDialer, ...naming };
}

/** A Salesforce record id as the REST API hands them out: 18 case-sensitive
 *  alphanumerics. Anything else is not an id and is never interpolated — the
 *  escape below is the belt, this is the braces. 18 only, on purpose: the
 *  names come back keyed by the 18-char `Id`, so a 15-char input could never
 *  match its own result and would silently fall back to the Opportunity Name.
 *  The API never sends 15-char ids; refusing them makes that explicit. */
const SF_ID = /^[A-Za-z0-9]{18}$/;

/** SOQL's practical IN (...) bound, shared with `task-targets.ts`. */
const CONTACT_CHUNK = 200;

/**
 * The names of these Contacts, `Id → Name`, in ONE query per 200 ids for the
 * whole run — never one per record. Blank names are left out, so a caller can
 * `get()` and fall back on a miss. Invalid ids are dropped rather than escaped
 * and sent: the escape guards the quote, the shape check guards everything
 * else. A failed query is THROWN — whether a name is worth failing a queue
 * build over is the caller's call (it is not: see create-session.ts).
 */
export async function fetchContactNames(userId: string, contactIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(contactIds.filter((id) => SF_ID.test(id)))];
  const rows: Array<{ Id: string } & NameField> = [];
  for (let i = 0; i < ids.length; i += CONTACT_CHUNK) {
    const list = ids.slice(i, i + CONTACT_CHUNK).map((id) => `'${soqlEscape(id)}'`).join(',');
    rows.push(...await soqlQuery<{ Id: string } & NameField>(userId, `SELECT Id, Name FROM Contact WHERE Id IN (${list})`));
  }
  return new Map(rows.flatMap((row) => {
    const name = cleanName(row.Name);
    return name ? [[row.Id, name] as const] : [];
  }));
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

  const { skipOnDialer, displayName, contactId } = found;
  const { primaryRaw, fallbackRaw } = choosePhones(found.fields.MobilePhone, found.fields.Phone);
  const primary = primaryRaw ? normalize(primaryRaw) : null;
  if (!primary?.ok || !primary.value) return { e164: null, fallbackE164: null, skipOnDialer, displayName, contactId };
  const e164 = primary.value.e164;

  let fallbackE164: string | null = null;
  if (fallbackRaw) {
    const fb = normalize(fallbackRaw);
    // Only a valid, DISTINCT number is a real fallback — a Phone that equals the
    // Mobile (common) would just re-dial the same line.
    if (fb.ok && fb.value && fb.value.e164 !== e164) fallbackE164 = fb.value.e164;
  }
  return { e164, fallbackE164, skipOnDialer, displayName, contactId };
}
