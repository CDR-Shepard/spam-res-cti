/**
 * Real Postgres: booking an appointment slot (plan 1D, D-10). Two AI calls racing for the same owner's time: exactly one
 * books it, the other is told it is taken. Runs when TEST_DATABASE_URL points at a server you can CREATE DATABASE on
 * (as request-store.pg.test.ts), skipped otherwise.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { BookedAppointment } from '@cti/contracts';
import { loadMigrationFiles, runMigrations, schema } from '@cti/db';
import { setAppointment } from './store-booking.js';

const server = process.env.TEST_DATABASE_URL;
const OWNER = '0058X00000Fsx39QAB';

describe.skipIf(!server)('ai_calls appointment booking (real Postgres)', () => {
  const name = `cti_booking_${randomBytes(4).toString('hex')}`;
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let seq = 0;

  const urlFor = (database: string) => {
    const url = new URL(server!);
    url.pathname = `/${database}`;
    return url.toString();
  };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: server });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: urlFor(name), max: 12 });
    const client = await pool.connect();
    try {
      await runMigrations(client, await loadMigrationFiles(), { info: () => {}, error: (m: string) => console.error(m) });
    } finally {
      client.release();
    }
    db = drizzle(pool, { schema });
    const orgs = await db
      .insert(schema.organizations)
      .values([
        { name, slug: name, settings: {} },
        { name: `${name}b`, slug: `${name}b`, settings: {} },
      ])
      .returning({ id: schema.organizations.id });
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
    const [user] = await db.insert(schema.users).values({ orgId, email: `${name}@example.com`, kind: 'human' }).returning({ id: schema.users.id });
    userId = user!.id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: server });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  });

  const call = async (over: { org?: string; isTest?: boolean; practice?: boolean; ended?: boolean } = {}) => {
    seq += 1;
    const [row] = await db
      .insert(schema.aiCalls)
      .values({
        orgId: over.org ?? orgId,
        startedBy: userId,
        toE164: `+1619555${String(1000 + seq).slice(-4)}`,
        status: over.ended ? 'completed' : 'in_progress',
        isTest: over.isTest ?? false,
        practice: over.practice ?? false,
        ...(over.ended ? { endedAt: new Date() } : {}),
      })
      .returning({ id: schema.aiCalls.id });
    return row!.id;
  };
  const booked = (start: string, minutes: number, owner = OWNER): BookedAppointment => ({
    slotId: 'p1',
    kind: 'phone',
    start,
    end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
    specialistSfUserId: owner,
    addressConfirmed: false,
    note: '',
    bookedAt: new Date().toISOString(),
  });
  const appointmentOf = async (id: string) =>
    (await db.select({ a: schema.aiCalls.appointment }).from(schema.aiCalls).where(eq(schema.aiCalls.id, id)))[0]!.a;
  const run = (id: string, a: BookedAppointment) => setAppointment(db as never, id, a);

  it('D-10: eight calls racing for the same owner and time: exactly one books it, the rest hear it is taken', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => call()));
    const a = booked('2030-01-07T18:00:00.000Z', 15);
    const results = await Promise.all(ids.map((id) => run(id, a)));
    expect(results.filter((r) => r === 'booked')).toHaveLength(1);
    expect(results.filter((r) => r === 'taken')).toHaveLength(7);
    const stored = await Promise.all(ids.map(appointmentOf));
    expect(stored.filter((s) => s !== null)).toHaveLength(1);
  });

  it('D-10: an overlapping walkthrough is taken; a time that only touches is free', async () => {
    const first = await call();
    expect(await run(first, booked('2030-01-08T17:00:00.000Z', 60))).toBe('booked');
    expect(await run(await call(), booked('2030-01-08T17:30:00.000Z', 15))).toBe('taken');
    expect(await run(await call(), booked('2030-01-08T16:30:00.000Z', 60))).toBe('taken');
    expect(await run(await call(), booked('2030-01-08T18:00:00.000Z', 60))).toBe('booked');
    expect(await run(await call(), booked('2030-01-08T16:45:00.000Z', 15))).toBe('booked');
  });

  it('a 15-character owner id matches its 18-character form', async () => {
    await run(await call(), booked('2030-01-09T18:00:00.000Z', 15));
    expect(await run(await call(), booked('2030-01-09T18:00:00.000Z', 15, OWNER.slice(0, 15)))).toBe('taken');
  });

  it('another owner, another org, or a test / practice booking never blocks a real one', async () => {
    const t = '2030-01-10T18:00:00.000Z';
    expect(await run(await call({ isTest: true, practice: true }), booked(t, 15))).toBe('booked');
    expect(await run(await call({ isTest: true }), booked(t, 15))).toBe('booked');
    expect(await run(await call({ org: otherOrgId }), booked(t, 15))).toBe('booked');
    expect(await run(await call(), booked(t, 15, '005000000000001AAA'))).toBe('booked');
    expect(await run(await call(), booked(t, 15))).toBe('booked');
  });

  it('a practice call is refused a time a real call booked (it behaves as the real call would)', async () => {
    const t = '2030-01-11T18:00:00.000Z';
    expect(await run(await call(), booked(t, 15))).toBe('booked');
    expect(await run(await call({ isTest: true, practice: true }), booked(t, 15))).toBe('taken');
  });

  it('the same call booking again replaces its own booking (last wins), never blocks itself', async () => {
    const id = await call();
    expect(await run(id, booked('2030-01-12T18:00:00.000Z', 15))).toBe('booked');
    expect(await run(id, booked('2030-01-12T18:00:00.000Z', 15))).toBe('booked');
    expect(await run(id, booked('2030-01-12T21:00:00.000Z', 15))).toBe('booked');
    expect(await appointmentOf(id)).toMatchObject({ start: '2030-01-12T21:00:00.000Z' });
    // Its earlier time is free again.
    expect(await run(await call(), booked('2030-01-12T18:00:00.000Z', 15))).toBe('booked');
  });

  it('an ended call books nothing', async () => {
    const id = await call({ ended: true });
    expect(await run(id, booked('2030-01-13T18:00:00.000Z', 15))).toBe('not_live');
    expect(await appointmentOf(id)).toBeNull();
  });
});
