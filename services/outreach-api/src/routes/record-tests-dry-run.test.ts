/**
 * Test a record, "What would be written to Salesforce" (plan 1E Task 11): POST /api/record-tests/calls/:callId/dry-run,
 * admins only. dryRunTestCall is replaced (its SQL and Salesforce reads run on the Postgres lane in
 * record-tests/dry-run.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RecordTestDryRun } from '@cti/contracts';
import { buildApp } from '../app.js';
import { DescribeCache } from '../research/describe.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { fakeModel, GRANT } from '../test/writeback-harness.js';
import { registerRecordTestRoutes } from './record-tests.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
vi.mock('../record-tests/dry-run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../record-tests/dry-run.js')>()),
  dryRunTestCall: vi.fn(),
}));
const dry = vi.mocked(await import('../record-tests/dry-run.js'));

const CALL_ID = '88888888-8888-4888-8888-888888888888';
const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
const admin = { userId: '22222222-2222-4222-8222-222222222222', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const DRY: RecordTestDryRun = {
  status: 'ready',
  changes: [{ label: 'Stage', before: 'Closed Lost', after: 'Appointment Set', kind: 'changed' }],
  changesText: 'AI call on …',
  chatterText: 'AI call 1234 · …',
  wouldCreate: ['Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden', 'Chatter post'],
  conversion: null,
  note: null,
};
const model = fakeModel();

let app: FastifyInstance;
async function build() {
  return buildApp({
    cfg: testConfig({ NODE_ENV: 'development' }),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [
      (scope) =>
        registerRecordTestRoutes(scope, {
          db: fakeDb({ organizations: [ORG] }).db, clients: async () => { throw new Error('unused'); }, cti: null, model: null,
          describes: new DescribeCache(), defaultSpecialists: [GRANT], mappingModel: model, appPublicUrl: 'https://outreach.example',
        }),
    ],
  });
}
const post = (callId = CALL_ID) => app.inject({ method: 'POST', url: `/api/record-tests/calls/${callId}/dry-run`, headers: { authorization: 'Bearer t' } });

beforeEach(async () => {
  state.session = admin;
  vi.clearAllMocks();
  dry.dryRunTestCall.mockResolvedValue({ ok: true, dryRun: DRY });
  app = await build();
});
afterEach(async () => {
  await app?.close();
});

describe('POST /api/record-tests/calls/:callId/dry-run', () => {
  it('a rep gets 403 and nothing runs', async () => {
    state.session = { ...admin, isAdmin: false };
    expect((await post()).statusCode).toBe(403);
    expect(dry.dryRunTestCall).not.toHaveBeenCalled();
  });

  it('an admin gets the dry run, computed with the mapping model and the app URL in their org', async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(RecordTestDryRun.parse(res.json())).toEqual(DRY);
    const [deps, ctx, callId] = dry.dryRunTestCall.mock.calls[0]!;
    expect(deps).toMatchObject({ model, resultsBaseUrl: 'https://outreach.example' });
    expect(ctx.orgId).toBe('O1');
    expect(callId).toBe(CALL_ID);
  });

  it('a call id that is not a uuid is 404 and nothing runs', async () => {
    expect((await post('nope')).statusCode).toBe(404);
    expect(dry.dryRunTestCall).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, error: 'not_found' }, 404, 'NOT_FOUND'],
    [{ ok: false, error: 'not_finished' }, 409, 'NOT_FINISHED'],
    [{ ok: false, error: 'no_model' }, 503, 'NO_MODEL'],
    [{ ok: false, error: 'salesforce_error' }, 502, 'SALESFORCE_ERROR'],
    [{ ok: false, error: 'running' }, 409, 'DRY_RUN_RUNNING'],
    [{ ok: false, error: 'failed' }, 500, 'DRY_RUN_FAILED'],
    [{ ok: false, refusal: { code: 'AI_BUDGET_SPENT' } }, 409, 'AI_BUDGET_SPENT'],
  ] as const)('%j is %i %s', async (answer, status, code) => {
    dry.dryRunTestCall.mockResolvedValue(answer);
    const res = await post();
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code });
  });
});
