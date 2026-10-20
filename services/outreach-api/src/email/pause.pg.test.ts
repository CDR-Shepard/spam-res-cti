/** Real Postgres: the tenant's Sam-email switch and pause are one atomic UPDATE on organizations.settings. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { samEmailSettings } from '../settings.js';
import { pauseSamEmail, setSamEmailEnabled } from './pause.js';

const NOW = new Date('2026-10-20T17:00:00.000Z');

describe.skipIf(!pgLane)('pauseSamEmail / setSamEmailEnabled (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function settingsOf(orgId: string): Promise<Record<string, unknown>> {
    const [row] = await t.db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
    return row!.settings as Record<string, unknown>;
  }

  it('enabling turns Sam email on and keeps every other setting', async () => {
    const orgId = await seedOrg(t.db, { aiDailyBudgetUsd: 40, liveChannels: ['rep_call'] });
    await setSamEmailEnabled(t.db, { orgId, enabled: true });
    const settings = await settingsOf(orgId);
    expect(settings).toEqual({ aiDailyBudgetUsd: 40, liveChannels: ['rep_call'], samEmail: { enabled: true } });
    expect(samEmailSettings({ settings }).enabled).toBe(true);
  });

  it('pausing records when and why, keeps it enabled and keeps every other setting', async () => {
    const orgId = await seedOrg(t.db, { aiDailyBudgetUsd: 40, samEmail: { enabled: true } });
    await pauseSamEmail(t.db, { orgId, reason: 'complaint', now: NOW });
    const settings = await settingsOf(orgId);
    expect(settings).toEqual({ aiDailyBudgetUsd: 40, samEmail: { enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint' } });
    expect(samEmailSettings({ settings })).toEqual({ enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint' });
  });

  it('enabling again clears the pause fields', async () => {
    const orgId = await seedOrg(t.db, { samEmail: { enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint', other: 1 } });
    await setSamEmailEnabled(t.db, { orgId, enabled: true });
    expect(await settingsOf(orgId)).toEqual({ samEmail: { enabled: true, other: 1 } });
  });

  it('disabling turns it off and leaves a pause in place', async () => {
    const orgId = await seedOrg(t.db, { samEmail: { enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint' } });
    await setSamEmailEnabled(t.db, { orgId, enabled: false });
    expect(samEmailSettings({ settings: await settingsOf(orgId) })).toEqual({ enabled: false, pausedAt: NOW.toISOString(), pausedReason: 'complaint' });
  });

  it('pausing a tenant that never enabled Sam email still records the pause (and stays off)', async () => {
    const orgId = await seedOrg(t.db);
    await pauseSamEmail(t.db, { orgId, reason: 'complaint', now: NOW });
    expect(samEmailSettings({ settings: await settingsOf(orgId) })).toEqual({ enabled: false, pausedAt: NOW.toISOString(), pausedReason: 'complaint' });
  });

  it('pausing twice keeps the latest pause', async () => {
    const orgId = await seedOrg(t.db, { samEmail: { enabled: true } });
    await pauseSamEmail(t.db, { orgId, reason: 'complaint', now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    await pauseSamEmail(t.db, { orgId, reason: 'bounce_rate', now: later });
    expect(samEmailSettings({ settings: await settingsOf(orgId) })).toMatchObject({ pausedAt: later.toISOString(), pausedReason: 'bounce_rate' });
  });

  it('repairs a junk blob instead of failing: settings that is not an object, samEmail that is not an object', async () => {
    const junkSettings = await seedOrg(t.db);
    await t.db.update(schema.organizations).set({ settings: ['oops'] }).where(eq(schema.organizations.id, junkSettings));
    await setSamEmailEnabled(t.db, { orgId: junkSettings, enabled: true });
    expect(await settingsOf(junkSettings)).toEqual({ samEmail: { enabled: true } });

    const junkSamEmail = await seedOrg(t.db, { keep: 1, samEmail: 'on' });
    await pauseSamEmail(t.db, { orgId: junkSamEmail, reason: 'complaint', now: NOW });
    expect(await settingsOf(junkSamEmail)).toEqual({ keep: 1, samEmail: { pausedAt: NOW.toISOString(), pausedReason: 'complaint' } });
  });

  it('touches only its own tenant', async () => {
    const a = await seedOrg(t.db, { samEmail: { enabled: true } });
    const b = await seedOrg(t.db, { samEmail: { enabled: true } });
    await pauseSamEmail(t.db, { orgId: a, reason: 'complaint', now: NOW });
    expect(samEmailSettings({ settings: await settingsOf(b) }).pausedAt).toBeNull();
  });

  it('never overwrites a key a concurrent settings save writes: the update is one statement on the live row', async () => {
    const orgId = await seedOrg(t.db, { aiDailyBudgetUsd: 25 });
    const saver = await t.pool.connect();
    try {
      // A settings save holds the row open while the pause arrives, then writes ITS key with jsonb_set too.
      await saver.query('begin');
      await saver.query(`update organizations set settings = jsonb_set(settings, '{aiDailyBudgetUsd}', '60') where id = $1`, [orgId]);
      const pause = pauseSamEmail(t.db, { orgId, reason: 'complaint', now: NOW });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await saver.query('commit');
      await pause;
    } finally {
      saver.release();
    }
    const settings = await settingsOf(orgId);
    expect(settings.aiDailyBudgetUsd).toBe(60);
    expect(samEmailSettings({ settings }).pausedAt).toBe(NOW.toISOString());
  });
});
