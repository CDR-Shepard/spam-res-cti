/**
 * Who may call the internal AI call routes (plan 1C): only outreach-api, over Railway's
 * private network. Four independent locks, cheapest refusal first:
 *   1. production, Host not *.railway.internal  → 404 (the public edge never routes such a
 *      host, so from the internet the routes do not exist)
 *   2. no OUTREACH_INTERNAL_SECRET configured   → production: the same 404 (a disabled route
 *      is indistinguishable from a missing one, S-4); elsewhere 503 internal_disabled
 *   3. any Origin header                        → 403 forbidden (browsers always send one)
 *   4. HMAC over method, path, timestamp, body  → 401 bad_signature
 * The route adds its own rate limit (INTERNAL_RATE_MAX a minute).
 */
import { eq } from 'drizzle-orm';
import {
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  verifyInternalRequest,
  type InternalVerdict,
  type SessionUser,
} from '@cti/auth';
import { schema } from '@cti/db';
import type { AppConfig } from '../config.js';
import type { Db } from '../dialer/pick-did.js';

export const INTERNAL_RATE_MAX = 60;
const PRIVATE_SUFFIX = '.railway.internal';

type Headers = Record<string, string | string[] | undefined>;
type InternalCfg = Pick<AppConfig, 'OUTREACH_INTERNAL_SECRET' | 'NODE_ENV'>;
type Refusal = { ok: false; status: 403 | 404 | 503; error: string };
export type InternalCheck =
  | { ok: true }
  | Refusal
  | { ok: false; status: 401; error: 'bad_signature'; reason: Exclude<InternalVerdict, { ok: true }>['reason'] };

const header = (h: Headers, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

export function internalHostAllowed(host: string | undefined, nodeEnv: AppConfig['NODE_ENV']): boolean {
  if (nodeEnv !== 'production') return true;
  if (!host) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, '');
  return name.endsWith(PRIVATE_SUFFIX) && name.length > PRIVATE_SUFFIX.length;
}

/** Locks 1-3: decided from the headers alone, so they run before the body is even read. A 404 is answered with `reply.callNotFound()`. */
export function checkInternalTransport(headers: Headers, cfg: InternalCfg): { ok: true } | Refusal {
  if (!internalHostAllowed(header(headers, 'host'), cfg.NODE_ENV)) return { ok: false, status: 404, error: 'not_found' };
  if (!cfg.OUTREACH_INTERNAL_SECRET) {
    return cfg.NODE_ENV === 'production' ? { ok: false, status: 404, error: 'not_found' } : { ok: false, status: 503, error: 'internal_disabled' };
  }
  if (header(headers, 'origin') !== undefined) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true };
}

/** All four locks, in order. */
export function checkInternalRequest(
  req: { method: string; url: string; headers: Headers; rawBody: string },
  cfg: InternalCfg,
  now: Date,
): InternalCheck {
  const transport = checkInternalTransport(req.headers, cfg);
  if (!transport.ok) return transport;
  const verdict = verifyInternalRequest(
    cfg.OUTREACH_INTERNAL_SECRET as string,
    { method: req.method, path: req.url, body: req.rawBody },
    { timestamp: header(req.headers, INTERNAL_TIMESTAMP_HEADER), signature: header(req.headers, INTERNAL_SIGNATURE_HEADER) },
    now,
  );
  return verdict.ok ? { ok: true } : { ok: false, status: 401, error: 'bad_signature', reason: verdict.reason };
}

/** The requesting outreach user as a SessionUser, mapped as @cti/auth's resolveSessionDetail maps a session's user. */
export async function internalSession(db: Db, orgId: string, userId: string): Promise<SessionUser | null> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user || user.orgId !== orgId || user.kind === 'service') return null;
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId), columns: { status: true } });
  if (org?.status !== 'active') return null;
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    isAdmin: user.isAdmin,
    powerDialerEnabled: user.powerDialerEnabled,
    kind: user.kind,
    isSuperAdmin: user.isSuperAdmin,
  };
}
