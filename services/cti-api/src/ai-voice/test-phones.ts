/**
 * The org's test-phones list (`ai_test_phones`, migration 0061; admins keep it on outreach-web's Testing page): the
 * phones that get the AI agent when they call one of its numbers (inbound-call.ts), and — together with the
 * AI_VOICE_TEST_NUMBERS env list, kept for compatibility — the numbers an admin may place a test call to (gate.ts,
 * routes-internal.ts). Numbers are stored as strict E.164, unique per org, at most TEST_PHONES_MAX of them
 * (outreach-api enforces both on add), so the org's list is always small.
 */
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';

type Db = ReturnType<typeof getDb>;
const t = schema.aiTestPhones;

/** One listed phone: who added it is who an inbound call from it is started by. */
export interface TestPhoneMatch {
  id: string;
  addedBy: string;
  label: string;
}

export const testPhoneNumbersQuery = (db: Db, orgId: string) => db.select({ e164: t.e164 }).from(t).where(eq(t.orgId, orgId));

/** The org's listed numbers (E.164). */
export async function testPhoneNumbers(db: Db, orgId: string): Promise<ReadonlySet<string>> {
  const rows = await testPhoneNumbersQuery(db, orgId);
  return new Set(rows.map((r) => r.e164));
}

export const findTestPhoneQuery = (db: Db, orgId: string, e164: string) =>
  db
    .select({ id: t.id, addedBy: t.addedBy, label: t.label })
    .from(t)
    .where(and(eq(t.orgId, orgId), eq(t.e164, e164)))
    .limit(1);

/** The org's listing of exactly `e164` (strict E.164), or null when that phone is not on the list. */
export async function findTestPhone(db: Db, orgId: string, e164: string): Promise<TestPhoneMatch | null> {
  const [row] = await findTestPhoneQuery(db, orgId, e164);
  return row ?? null;
}
