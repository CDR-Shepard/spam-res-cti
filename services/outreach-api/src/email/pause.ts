/**
 * The tenant's Sam-email switch and pause, written into `organizations.settings.samEmail`.
 *
 * Resend closes an account whose complaint rate passes 0.08%, so one spam complaint pauses email for the
 * whole tenant until an admin turns it back on (the webhook tick calls `pauseSamEmail`; the settings
 * route calls `setSamEmailEnabled`). Both are ONE UPDATE that builds the new `samEmail` object from the
 * live row with jsonb_set / `||`, never a read followed by a write: a settings save landing at the same
 * moment writes other keys of the same blob, and a read-modify-write here would put its stale copy back.
 * A blob (or a `samEmail` key) that is not an object is replaced by an object rather than failing the
 * pause: pausing is a safety stop and must always land.
 *
 * Reading is settings.ts `samEmailSettings`. Logs: none here; the caller logs the tenant id.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';

/** The blob as an object, whatever it holds now. */
const settingsObject = sql`case when jsonb_typeof(settings) = 'object' then settings else '{}'::jsonb end`;
/** The `samEmail` key as an object, whatever it holds now. */
const samEmailObject = sql`case when jsonb_typeof(settings -> 'samEmail') = 'object' then settings -> 'samEmail' else '{}'::jsonb end`;

/** Pause Sam's email for the tenant: when and why, `enabled` left as it was. A second pause replaces the first. */
export async function pauseSamEmail(db: Db, i: { orgId: string; reason: string; now: Date }): Promise<void> {
  await db.execute(sql`
    update organizations
    set settings = jsonb_set(
      ${settingsObject},
      '{samEmail}',
      ${samEmailObject} || jsonb_build_object('pausedAt', ${i.now.toISOString()}::text, 'pausedReason', ${i.reason}::text),
      true)
    where id = ${i.orgId}::uuid`);
}

/** Turn Sam's email on or off for the tenant. Turning it on clears a pause (an admin has looked into it); turning it off keeps one. */
export async function setSamEmailEnabled(db: Db, i: { orgId: string; enabled: boolean }): Promise<void> {
  const next = i.enabled
    ? sql`(${samEmailObject} - 'pausedAt' - 'pausedReason') || jsonb_build_object('enabled', true)`
    : sql`${samEmailObject} || jsonb_build_object('enabled', false)`;
  await db.execute(sql`
    update organizations
    set settings = jsonb_set(${settingsObject}, '{samEmail}', ${next}, true)
    where id = ${i.orgId}::uuid`);
}
