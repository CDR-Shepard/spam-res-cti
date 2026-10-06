/**
 * The Twilio Client identity a "Talk in browser" test registers under (plan 1E, spec §5.2):
 * `aitest_` + the admin's users.id as 32 lower-case hex + `_` + a 12-hex nonce, new for each run.
 *
 * It is never `rep_…`, so the admin's cti-web softphone never rings for it and no `rep_` parser
 * matches it. The user id inside it is how cti-api's gate binds the leg to the admin who asked.
 *
 * Its own module (not record-tests.ts) because ai-calls.ts needs the regex and record-tests.ts
 * imports ai-calls.ts: keeping it here avoids an import cycle.
 */

export const AI_TEST_IDENTITY_RE = /^aitest_([0-9a-f]{32})_([0-9a-f]{12})$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_RE = /^[0-9a-f]{12}$/;

/** The identity for `userId` (a uuid) and a 12-hex nonce. Throws on anything else: callers pass generated values. */
export function aiTestIdentity(userId: string, nonceHex12: string): string {
  if (!UUID_RE.test(userId)) throw new Error('aiTestIdentity: userId is not a uuid');
  if (!NONCE_RE.test(nonceHex12)) throw new Error('aiTestIdentity: nonce is not 12 lower-case hex');
  return `aitest_${userId.replace(/-/g, '').toLowerCase()}_${nonceHex12}`;
}

/** The users.id inside an aitest identity (dashes restored), or null for any other shape. */
export function aiTestIdentityUser(identity: string): string | null {
  const m = AI_TEST_IDENTITY_RE.exec(identity);
  if (!m) return null;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
