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

export async function resolveDialNumber(
  userId: string,
  objectType: 'Lead' | 'Opportunity',
  recordId: string,
): Promise<{ e164: string; fallbackE164: string | null } | null> {
  const rid = soqlEscape(recordId);
  let fields: { MobilePhone?: string | null; Phone?: string | null } | null = null;

  if (objectType === 'Lead') {
    const rows = await soqlQuery<{ MobilePhone?: string | null; Phone?: string | null }>(
      userId,
      `SELECT MobilePhone, Phone FROM Lead WHERE Id = '${rid}' LIMIT 1`,
    );
    fields = rows[0] ?? null;
  } else {
    // Primary Opportunity Contact Role → Contact phone.
    const rows = await soqlQuery<{ Contact?: { MobilePhone?: string | null; Phone?: string | null } | null }>(
      userId,
      'SELECT Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole ' +
        `WHERE OpportunityId = '${rid}' AND IsPrimary = true LIMIT 1`,
    );
    fields = rows[0]?.Contact ?? null;
  }

  if (!fields) return null;
  const { primaryRaw, fallbackRaw } = choosePhones(fields.MobilePhone, fields.Phone);
  if (!primaryRaw) return null;
  const primary = normalize(primaryRaw);
  if (!primary.ok || !primary.value) return null;
  const e164 = primary.value.e164;

  let fallbackE164: string | null = null;
  if (fallbackRaw) {
    const fb = normalize(fallbackRaw);
    // Only a valid, DISTINCT number is a real fallback — a Phone that equals the
    // Mobile (common) would just re-dial the same line.
    if (fb.ok && fb.value && fb.value.e164 !== e164) fallbackE164 = fb.value.e164;
  }
  return { e164, fallbackE164 };
}
