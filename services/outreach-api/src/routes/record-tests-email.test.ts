/**
 * Test a record, "Preview Sam's email" (owner, 2026-10-20): POST /api/record-tests/:id/email-preview, admins only.
 * previewTestEmail is replaced (its reads, the writer and the budget run on the Postgres lane in
 * record-tests/email-preview.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RecordTestEmailPreview } from '@cti/contracts';
import { buildApp } from '../app.js';
import type { EmailWriter } from '../email/writer.js';
import { DescribeCache } from '../research/describe.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { GRANT } from '../test/writeback-harness.js';
import { registerRecordTestRoutes } from './record-tests.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
vi.mock('../record-tests/email-preview.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../record-tests/email-preview.js')>()),
  previewTestEmail: vi.fn(),
}));
const mod = vi.mocked(await import('../record-tests/email-preview.js'));

const TEST_ID = '77777777-7777-4777-8777-777777777777';
const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
const admin = { userId: '22222222-2222-4222-8222-222222222222', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const PREVIEW: RecordTestEmailPreview = { subject: 'Your home on Oak Street', body: 'Hi Pat,\n\nIs the house still for sale?', footer: '—\nSam', issues: [] };
const writer: EmailWriter = { write: vi.fn() };
const EMAIL = { writer, companyName: 'GG Homes', postalAddress: '18872 MacArthur Blvd #220, Irvine, CA 92612' };

let app: FastifyInstance;
async function build({ email }: { email?: { writer: EmailWriter | null; companyName: string; postalAddress: string } } = { email: EMAIL }) {
  return buildApp({
    cfg: testConfig({ NODE_ENV: 'development' }),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [
      (scope) =>
        registerRecordTestRoutes(scope, {
          db: fakeDb({ organizations: [ORG] }).db, clients: async () => { throw new Error('unused'); }, cti: null, model: null,
          describes: new DescribeCache(), defaultSpecialists: [GRANT], maps: null, email,
        }),
    ],
  });
}
const post = (id = TEST_ID) => app.inject({ method: 'POST', url: `/api/record-tests/${id}/email-preview`, headers: { authorization: 'Bearer t' } });

beforeEach(async () => {
  state.session = admin;
  vi.clearAllMocks();
  mod.previewTestEmail.mockResolvedValue({ ok: true, preview: PREVIEW });
  app = await build();
});
afterEach(async () => {
  await app?.close();
});

describe('POST /api/record-tests/:id/email-preview', () => {
  it('a rep gets 403 and Sam is never asked', async () => {
    state.session = { ...admin, isAdmin: false };
    expect((await post()).statusCode).toBe(403);
    expect(mod.previewTestEmail).not.toHaveBeenCalled();
  });

  it("an admin gets Sam's email, written with the server's writer, company and postal address in their org", async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(RecordTestEmailPreview.parse(res.json())).toEqual(PREVIEW);
    const [deps, ctx, testId] = mod.previewTestEmail.mock.calls[0]!;
    expect(deps).toMatchObject({ writer, companyName: 'GG Homes', postalAddress: '18872 MacArthur Blvd #220, Irvine, CA 92612' });
    expect(deps.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.orgId).toBe('O1');
    expect(testId).toBe(TEST_ID);
  });

  it('a test id that is not a uuid is 404 and Sam is never asked', async () => {
    expect((await post('nope')).statusCode).toBe(404);
    expect(mod.previewTestEmail).not.toHaveBeenCalled();
  });

  it.each([{}, { email: { ...EMAIL, writer: null } }])('without a writer (%j) it is 503 EMAIL_NOT_CONFIGURED', async (deps) => {
    await app.close();
    app = await build(deps);
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_CONFIGURED' });
    expect(mod.previewTestEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404, 'NOT_FOUND'],
    ['not_ready', 409, 'NOT_READY'],
    ['over_budget', 409, 'AI_BUDGET_SPENT'],
    ['declined', 422, 'DRAFT_REFUSED'],
    ['failed', 502, 'MODEL_ERROR'],
  ] as const)('%s is %i %s', async (error, status, code) => {
    mod.previewTestEmail.mockResolvedValue({ ok: false, error });
    const res = await post();
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code });
  });
});
