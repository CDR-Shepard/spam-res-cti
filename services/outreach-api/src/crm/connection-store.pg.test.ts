import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { encryptString } from '@cti/auth';
import type { FieldMap } from '@cti/contracts';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { loadConnection, markBroken } from './connection-store.js';

const emptyObject = { notes: [], phones: [], email: null, doNotCall: null, emailOptOut: null, skipOnDialer: null, consent: null, webFormSource: null, state: null, leadManager: null };
const fieldMap: FieldMap = { Lead: emptyObject, Opportunity: emptyObject };

describe.skipIf(!pgLane)('connection store (real Postgres)', () => {
  let t: TestDb;
  let orgId = '';

  beforeAll(async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32));
    t = await createTestDb();
    const [org] = await t.db.insert(schema.organizations).values({ name: 'A', slug: 'a-org' }).returning();
    orgId = org!.id;
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.delete(schema.crmConnections);
    await t.db.insert(schema.crmConnections).values({
      orgId, provider: 'salesforce', instanceUrl: 'https://gg.my.salesforce.com', sfOrgId: '00D1', sfUserId: '0051',
      accessTokenEnc: encryptString('AT'), refreshTokenEnc: 'CIPHER-NEW', status: 'connected', fieldMap,
    });
  });

  it('markBroken with the ciphertext it read leaves a reconnected row (new refresh token) untouched', async () => {
    await markBroken(t.db, orgId, 'stale failure', 'CIPHER-OLD');
    expect(await loadConnection(t.db, orgId)).toMatchObject({ status: 'connected', lastError: null });
  });

  it('markBroken with the current ciphertext marks the row broken', async () => {
    await markBroken(t.db, orgId, 'real failure', 'CIPHER-NEW');
    expect(await loadConnection(t.db, orgId)).toMatchObject({ status: 'broken', lastError: 'real failure' });
  });
});
