import { soqlEscape, soqlQuery } from './client.js';
import { normalize } from '../phone.js';

export function selectRawPhone(fields: { MobilePhone?: string | null; Phone?: string | null }): string | null {
  const m = fields.MobilePhone?.trim();
  if (m) return m;
  const p = fields.Phone?.trim();
  if (p) return p;
  return null;
}

export async function resolveDialNumber(
  userId: string,
  objectType: 'Lead' | 'Opportunity',
  recordId: string,
): Promise<{ e164: string } | null> {
  const rid = soqlEscape(recordId);
  let raw: string | null = null;

  if (objectType === 'Lead') {
    const rows = await soqlQuery<{ MobilePhone?: string | null; Phone?: string | null }>(
      userId,
      `SELECT MobilePhone, Phone FROM Lead WHERE Id = '${rid}' LIMIT 1`,
    );
    raw = rows[0] ? selectRawPhone(rows[0]) : null;
  } else {
    // Primary Opportunity Contact Role → Contact phone.
    const rows = await soqlQuery<{ Contact?: { MobilePhone?: string | null; Phone?: string | null } | null }>(
      userId,
      'SELECT Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole ' +
        `WHERE OpportunityId = '${rid}' AND IsPrimary = true LIMIT 1`,
    );
    raw = rows[0]?.Contact ? selectRawPhone(rows[0].Contact) : null;
  }

  if (!raw) return null;
  const norm = normalize(raw);
  return norm.ok && norm.value ? { e164: norm.value.e164 } : null;
}
