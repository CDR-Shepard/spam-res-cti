/**
 * Editable agent prompts (plan docs/superpowers/plans/2026-10-16-editable-agent-prompts.md, Task 5): the admin routes that read,
 * preview, save and reset the AI phone agent's instructions and voicemail template. cti-api (which owns the placeholders and the
 * defaults) is a fake `checkPrompt`; the versions table is real Postgres (set TEST_DATABASE_URL, see test/pg.ts), because the
 * contract is about what a save leaves in `ai_agent_prompts`: append-only rows, newest wins, never another org's.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  AGENT_PROMPT_MAX_CHARS,
  AGENT_PROMPT_VERSIONS_SHOWN,
  AgentPromptState,
  AgentPromptsResponse,
  type AgentPromptCheck,
  type AgentPromptKind,
  type InternalAgentPromptCheckRequest,
} from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { PromptCheckOutcome } from '../ai-calls/cti-client.js';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { CHECK_UNAVAILABLE_WORDS, registerAgentPromptRoutes } from './agent-prompts.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const auth = { authorization: 'Bearer t' };
const KINDS = ['instructions', 'voicemail'] as const;
const PLACEHOLDERS: AgentPromptCheck['placeholders'] = [
  { name: 'sellerFirstName', kind: 'text', description: 'The seller first name' },
  { name: 'hasAppointmentOffer', kind: 'section', description: 'Shown when a time can be offered' },
];
const defaultCheck = (kind: AgentPromptKind): AgentPromptCheck => ({ defaultTemplate: `DEFAULT ${kind} for {{sellerFirstName}}`, placeholders: PLACEHOLDERS, rendered: null, problems: [] });

/** A fake cti-api: null → the kind's default; a template → rendered with a marker, unless `refuse` says what is wrong with it. */
function fakeCti() {
  const answer = { transport: false, problems: [] as string[] };
  const checkPrompt = vi.fn(async (req: InternalAgentPromptCheckRequest): Promise<PromptCheckOutcome> => {
    if (answer.transport) return { kind: 'transport', error: 'timeout' };
    if (req.template === null) return { kind: 'check', check: defaultCheck(req.kind) };
    const problems = answer.problems;
    return { kind: 'check', check: { ...defaultCheck(req.kind), rendered: problems.length ? null : `RENDERED(${req.template.length})`, problems } };
  });
  return { checkPrompt, answer };
}

let app: FastifyInstance | undefined;
let lines: string[] = [];
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const send = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app!.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
const sessionOf = (orgId: string, userId: string, isAdmin = true) => ({ userId, orgId, email: 'admin@gg.co', isAdmin, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false });

async function buildWith(db: Db, cti: ReturnType<typeof fakeCti> | null) {
  lines = [];
  app = await buildApp({
    cfg: testConfig({ NODE_ENV: 'development' }),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    logStream: { write: (line) => lines.push(line) },
    apiRoutes: [(scope) => registerAgentPromptRoutes(scope, { db, cti })],
  });
}

describe('agent prompt routes, who may call them (no database needed)', () => {
  const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
  const ID = randomUUID();
  const routes = [
    ['GET', '/api/settings/agent-prompts', undefined],
    ['POST', '/api/settings/agent-prompts/instructions/preview', { template: 'x' }],
    ['PUT', '/api/settings/agent-prompts/instructions', { template: 'x' }],
    ['PUT', '/api/settings/agent-prompts/voicemail', { template: null }],
    ['GET', `/api/settings/agent-prompts/instructions/versions/${ID}`, undefined],
  ] as const;

  it('401 without a session; 403 ADMIN_ONLY for a non-admin on every route, and cti-api is never asked', async () => {
    const cti = fakeCti();
    await buildWith(fakeDb({ organizations: [ORG] }).db, cti);
    state.session = null;
    for (const [method, url, body] of routes) expect((await send(method, url, body)).statusCode, url).toBe(401);
    state.session = sessionOf('O1', 'U-REP', false);
    for (const [method, url, body] of routes) {
      const res = await send(method, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('ADMIN_ONLY');
    }
    expect(cti.checkPrompt).not.toHaveBeenCalled();
  });

  it('a non-admin is refused before the kind is looked at (an unknown kind is 403, not 400)', async () => {
    await buildWith(fakeDb({ organizations: [ORG] }).db, fakeCti());
    state.session = sessionOf('O1', 'U-REP', false);
    expect((await send('PUT', '/api/settings/agent-prompts/system', { template: 'x' })).statusCode).toBe(403);
  });

  it('with no cti-api configured (AI calls off) every route that needs it answers 503 prompt_check_unavailable', async () => {
    await buildWith(fakeDb({ organizations: [ORG] }).db, null);
    state.session = sessionOf('O1', 'U-ADMIN');
    for (const [method, url, body] of routes.slice(0, 4)) {
      const res = await send(method, url, body);
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ error: 'prompt_check_unavailable', message: CHECK_UNAVAILABLE_WORDS });
    }
  });
});

describe.skipIf(!pgLane)('agent prompt routes (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(() => {
    state.session = null;
  });

  /** A fresh org with an admin who exists in users (created_by is a foreign key), signed in, with a fake cti-api. */
  async function signedInAdmin(email = 'admin@gg.co') {
    const orgId = await seedOrg(t.db);
    const [user] = await t.db.insert(schema.users).values({ orgId, email, isAdmin: true }).returning({ id: schema.users.id });
    state.session = sessionOf(orgId, user!.id);
    const cti = fakeCti();
    await buildWith(t.db, cti);
    return { orgId, userId: user!.id, cti };
  }
  const rowsOf = (orgId: string, kind: AgentPromptKind) =>
    t.db.select().from(schema.aiAgentPrompts).where(and(eq(schema.aiAgentPrompts.orgId, orgId), eq(schema.aiAgentPrompts.kind, kind))).orderBy(asc(schema.aiAgentPrompts.createdAt));
  const getAll = async () => AgentPromptsResponse.parse((await send('GET', '/api/settings/agent-prompts')).json());

  describe('GET /settings/agent-prompts', () => {
    it('a fresh org: nothing saved, the default and the placeholders from cti-api, no versions, for both kinds', async () => {
      const { cti } = await signedInAdmin();
      const res = await send('GET', '/api/settings/agent-prompts');
      expect(res.statusCode).toBe(200);
      const body = AgentPromptsResponse.parse(res.json());
      for (const kind of KINDS) {
        expect(body[kind]).toEqual({ kind, active: null, defaultTemplate: defaultCheck(kind).defaultTemplate, placeholders: PLACEHOLDERS, updatedAt: null, updatedByEmail: null, versions: [] });
      }
      expect(cti.checkPrompt).toHaveBeenCalledWith({ kind: 'instructions', template: null });
      expect(cti.checkPrompt).toHaveBeenCalledWith({ kind: 'voicemail', template: null });
    });

    it('cti-api unreachable: 503 prompt_check_unavailable with the plain words', async () => {
      const { cti } = await signedInAdmin();
      cti.answer.transport = true;
      const res = await send('GET', '/api/settings/agent-prompts');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'prompt_check_unavailable', message: "Can't check the prompt right now — try again in a minute" });
      expect(CHECK_UNAVAILABLE_WORDS).toBe("Can't check the prompt right now — try again in a minute");
    });

    it('lists at most the newest 20 versions, newest first, with who saved them; active and updatedAt are the newest', async () => {
      const { orgId, userId } = await signedInAdmin('grant@gg.co');
      const start = Date.parse('2026-10-01T12:00:00.000Z');
      const rows = Array.from({ length: AGENT_PROMPT_VERSIONS_SHOWN + 5 }, (_, i) => ({
        orgId, kind: 'voicemail' as const, body: `version ${i}`, createdBy: i % 2 === 0 ? userId : null, createdAt: new Date(start + i * 60_000),
      }));
      await t.db.insert(schema.aiAgentPrompts).values(rows);
      const { voicemail, instructions } = await getAll();
      expect(voicemail.versions).toHaveLength(AGENT_PROMPT_VERSIONS_SHOWN);
      expect(voicemail.versions.map((v) => v.chars)).toEqual(Array.from({ length: 20 }, (_, i) => `version ${24 - i}`.length));
      expect(voicemail.versions[0]).toMatchObject({ createdAt: new Date(start + 24 * 60_000).toISOString(), createdByEmail: 'grant@gg.co', isDefault: false });
      expect(voicemail.versions[1]!.createdByEmail).toBeNull();
      expect(voicemail.active).toBe('version 24');
      expect(voicemail.updatedAt).toBe(new Date(start + 24 * 60_000).toISOString());
      expect(voicemail.updatedByEmail).toBe('grant@gg.co');
      expect(instructions.versions).toEqual([]);
    });

    it("is org-scoped: another org's versions are never shown, and each org's newest is its own active", async () => {
      const a = await signedInAdmin('a@gg.co');
      await t.db.insert(schema.aiAgentPrompts).values({ orgId: a.orgId, kind: 'instructions', body: 'ORG A TEXT', createdBy: a.userId });
      const b = await signedInAdmin('b@gg.co');
      expect((await getAll()).instructions).toMatchObject({ active: null, versions: [] });
      await t.db.insert(schema.aiAgentPrompts).values({ orgId: b.orgId, kind: 'instructions', body: 'ORG B TEXT', createdBy: b.userId });
      const seen = (await getAll()).instructions;
      expect(seen.active).toBe('ORG B TEXT');
      expect(seen.versions).toHaveLength(1);
    });
  });

  describe('PUT /settings/agent-prompts/:kind', () => {
    it.each(KINDS)('a valid %s template is checked, stored under the saver, returned as the new state, and then shown by GET', async (kind) => {
      const { orgId, userId, cti } = await signedInAdmin('grant@gg.co');
      const text = `Hello {{sellerFirstName}}, this is the ${kind}.`;
      const put = await send('PUT', `/api/settings/agent-prompts/${kind}`, { template: text });
      expect(put.statusCode).toBe(200);
      const saved = AgentPromptState.parse(put.json());
      expect(saved).toMatchObject({ kind, active: text, defaultTemplate: defaultCheck(kind).defaultTemplate, placeholders: PLACEHOLDERS, updatedByEmail: 'grant@gg.co' });
      expect(saved.versions).toEqual([expect.objectContaining({ createdByEmail: 'grant@gg.co', isDefault: false, chars: text.length })]);
      expect(cti.checkPrompt).toHaveBeenCalledWith({ kind, template: text });

      const rows = await rowsOf(orgId, kind);
      expect(rows).toEqual([expect.objectContaining({ orgId, kind, body: text, createdBy: userId })]);

      const after = (await getAll())[kind];
      expect(after.active).toBe(text);
      expect(after.versions).toHaveLength(1);
      expect(after.versions[0]).toMatchObject({ id: rows[0]!.id, createdByEmail: 'grant@gg.co', chars: text.length });
      expect((await getAll())[kind === 'voicemail' ? 'instructions' : 'voicemail'].active).toBeNull();
    });

    it('every save adds a version and the newest is the active one (append-only: nothing is overwritten)', async () => {
      const { orgId } = await signedInAdmin();
      for (const text of ['first', 'second', 'third']) expect((await send('PUT', '/api/settings/agent-prompts/voicemail', { template: text })).statusCode).toBe(200);
      expect((await rowsOf(orgId, 'voicemail')).map((r) => r.body)).toEqual(['first', 'second', 'third']);
      const { voicemail } = await getAll();
      expect(voicemail.active).toBe('third');
      expect(voicemail.versions.map((v) => v.chars)).toEqual(['third'.length, 'second'.length, 'first'.length]);
    });

    it('a template with problems is 400 invalid_prompt with those problems, and nothing is stored', async () => {
      const { orgId, cti } = await signedInAdmin();
      cti.answer.problems = ['{{nope}} is not a placeholder.', 'The section "{{#a}}" is never closed (line 3).'];
      const res = await send('PUT', '/api/settings/agent-prompts/instructions', { template: 'Hi {{nope}}' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_prompt', problems: cti.answer.problems });
      expect(await rowsOf(orgId, 'instructions')).toEqual([]);
    });

    it('cti-api unreachable: 503 prompt_check_unavailable with the plain words, and nothing is stored', async () => {
      const { orgId, cti } = await signedInAdmin();
      cti.answer.transport = true;
      const res = await send('PUT', '/api/settings/agent-prompts/instructions', { template: 'Hi there' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'prompt_check_unavailable', message: "Can't check the prompt right now — try again in a minute" });
      expect(await rowsOf(orgId, 'instructions')).toEqual([]);
    });

    it('template null resets: a NULL-body row is added (the history keeps the earlier text), GET shows the default in use', async () => {
      const { orgId, cti } = await signedInAdmin();
      await send('PUT', '/api/settings/agent-prompts/instructions', { template: 'Custom text' });
      cti.checkPrompt.mockClear();
      const put = await send('PUT', '/api/settings/agent-prompts/instructions', { template: null });
      expect(put.statusCode).toBe(200);
      expect(AgentPromptState.parse(put.json())).toMatchObject({ kind: 'instructions', active: null, defaultTemplate: defaultCheck('instructions').defaultTemplate });
      // Only the default was asked for: a reset has no template to check.
      expect(cti.checkPrompt.mock.calls.map(([r]) => r)).toEqual([{ kind: 'instructions', template: null }]);

      expect((await rowsOf(orgId, 'instructions')).map((r) => r.body)).toEqual(['Custom text', null]);
      const { instructions } = await getAll();
      expect(instructions.active).toBeNull();
      expect(instructions.versions).toHaveLength(2);
      expect(instructions.versions[0]).toMatchObject({ isDefault: true, chars: 0 });
      expect(instructions.versions[1]).toMatchObject({ isDefault: false, chars: 'Custom text'.length });
    });

    it('a reset when cti-api is unreachable stores nothing (the answer carries the defaults, so it cannot be built)', async () => {
      const { orgId, cti } = await signedInAdmin();
      cti.answer.transport = true;
      expect((await send('PUT', '/api/settings/agent-prompts/voicemail', { template: null })).statusCode).toBe(503);
      expect(await rowsOf(orgId, 'voicemail')).toEqual([]);
    });

    it('a template over the kind limit is 400 invalid_prompt with a readable problem, cti-api is not asked, and nothing is stored; exactly the limit is fine', async () => {
      const { orgId, cti } = await signedInAdmin();
      for (const kind of KINDS) {
        const max = AGENT_PROMPT_MAX_CHARS[kind];
        const res = await send('PUT', `/api/settings/agent-prompts/${kind}`, { template: 'x'.repeat(max + 1) });
        expect(res.statusCode, kind).toBe(400);
        const { error, problems } = res.json() as { error: string; problems: string[] };
        expect(error).toBe('invalid_prompt');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(String(max.toLocaleString('en-US')));
        expect(problems[0]).not.toContain('xxxx');
        expect(await rowsOf(orgId, kind)).toEqual([]);
      }
      expect(cti.checkPrompt).not.toHaveBeenCalled();
      for (const kind of KINDS) expect((await send('PUT', `/api/settings/agent-prompts/${kind}`, { template: 'x'.repeat(AGENT_PROMPT_MAX_CHARS[kind]) })).statusCode, kind).toBe(200);
    });

    it.each([
      ['a missing template', {}],
      ['a template that is not text', { template: 42 }],
      ['no body at all', undefined],
    ])('%s is 400 INVALID_BODY', async (_label, payload) => {
      const { orgId, cti } = await signedInAdmin();
      const res = await send('PUT', '/api/settings/agent-prompts/voicemail', payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_BODY');
      expect(cti.checkPrompt).not.toHaveBeenCalled();
      expect(await rowsOf(orgId, 'voicemail')).toEqual([]);
    });

    it('a kind that is not one of the two is 400 on every route and nothing happens', async () => {
      const { orgId, cti } = await signedInAdmin();
      const id = randomUUID();
      for (const [method, url, body] of [
        ['PUT', '/api/settings/agent-prompts/system', { template: 'x' }],
        ['POST', '/api/settings/agent-prompts/system/preview', { template: 'x' }],
        ['GET', `/api/settings/agent-prompts/system/versions/${id}`, undefined],
      ] as const) {
        const res = await send(method, url, body);
        expect(res.statusCode, url).toBe(400);
        expect(res.json().code).toBe('INVALID_KIND');
      }
      expect(cti.checkPrompt).not.toHaveBeenCalled();
      expect(await t.db.select().from(schema.aiAgentPrompts).where(eq(schema.aiAgentPrompts.orgId, orgId))).toEqual([]);
    });
  });

  describe('POST /settings/agent-prompts/:kind/preview', () => {
    it('passes cti-api\'s check through: the rendered text when it is fine, the problems when it is not; nothing is stored', async () => {
      const { orgId, cti } = await signedInAdmin();
      const ok = await send('POST', '/api/settings/agent-prompts/voicemail/preview', { template: 'Hi {{sellerFirstName}}' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ...defaultCheck('voicemail'), rendered: `RENDERED(${'Hi {{sellerFirstName}}'.length})` });
      expect(cti.checkPrompt).toHaveBeenCalledWith({ kind: 'voicemail', template: 'Hi {{sellerFirstName}}' });

      cti.answer.problems = ['{{nope}} is not a placeholder.'];
      const bad = await send('POST', '/api/settings/agent-prompts/voicemail/preview', { template: 'Hi {{nope}}' });
      expect(bad.statusCode).toBe(200);
      expect(bad.json()).toEqual({ ...defaultCheck('voicemail'), rendered: null, problems: ['{{nope}} is not a placeholder.'] });
      expect(await rowsOf(orgId, 'voicemail')).toEqual([]);
    });

    it('cti-api unreachable: 503 prompt_check_unavailable', async () => {
      const { cti } = await signedInAdmin();
      cti.answer.transport = true;
      const res = await send('POST', '/api/settings/agent-prompts/instructions/preview', { template: 'Hi' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'prompt_check_unavailable', message: CHECK_UNAVAILABLE_WORDS });
    });

    it('a draft over the kind limit is 400 invalid_prompt with a readable problem, and cti-api is not asked', async () => {
      const { cti } = await signedInAdmin();
      const res = await send('POST', '/api/settings/agent-prompts/voicemail/preview', { template: 'y'.repeat(AGENT_PROMPT_MAX_CHARS.voicemail + 1) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_prompt', problems: [expect.stringContaining('1,500')] });
      expect(cti.checkPrompt).not.toHaveBeenCalled();
    });

    it('a body without a template is 400 INVALID_BODY', async () => {
      await signedInAdmin();
      const res = await send('POST', '/api/settings/agent-prompts/voicemail/preview', {});
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_BODY');
    });
  });

  describe('GET /settings/agent-prompts/:kind/versions/:id', () => {
    it('the text of one version (a reset version has a null body)', async () => {
      const { orgId } = await signedInAdmin();
      await send('PUT', '/api/settings/agent-prompts/instructions', { template: 'Older text' });
      await send('PUT', '/api/settings/agent-prompts/instructions', { template: null });
      const [older, reset] = await rowsOf(orgId, 'instructions');
      const a = await send('GET', `/api/settings/agent-prompts/instructions/versions/${older!.id}`);
      expect(a.statusCode).toBe(200);
      expect(a.json()).toEqual({ id: older!.id, body: 'Older text' });
      expect((await send('GET', `/api/settings/agent-prompts/instructions/versions/${reset!.id}`)).json()).toEqual({ id: reset!.id, body: null });
    });

    it("another org's version id, an unknown id, and a version of the other kind are all 404", async () => {
      const other = await signedInAdmin('other@gg.co');
      await send('PUT', '/api/settings/agent-prompts/instructions', { template: 'Org B secret strategy' });
      const [theirs] = await rowsOf(other.orgId, 'instructions');
      const mine = await signedInAdmin('mine@gg.co');
      await send('PUT', '/api/settings/agent-prompts/voicemail', { template: 'My voicemail' });
      const [myVoicemail] = await rowsOf(mine.orgId, 'voicemail');

      for (const id of [theirs!.id, randomUUID()]) {
        const res = await send('GET', `/api/settings/agent-prompts/instructions/versions/${id}`);
        expect(res.statusCode, id).toBe(404);
        expect(res.body).not.toContain('Org B secret strategy');
      }
      expect((await send('GET', `/api/settings/agent-prompts/instructions/versions/${myVoicemail!.id}`)).statusCode).toBe(404);
      expect((await send('GET', `/api/settings/agent-prompts/voicemail/versions/${myVoicemail!.id}`)).statusCode).toBe(200);
    });

    it('an id that is not a UUID is 400 INVALID_ID', async () => {
      await signedInAdmin();
      const res = await send('GET', '/api/settings/agent-prompts/instructions/versions/not-an-id');
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_ID');
    });
  });

  it('never logs the template text, whatever the outcome', async () => {
    const { cti } = await signedInAdmin();
    const MARK = 'TOPSECRETMARKER';
    await send('POST', '/api/settings/agent-prompts/instructions/preview', { template: `a ${MARK}` });
    await send('PUT', '/api/settings/agent-prompts/instructions', { template: `b ${MARK}` });
    cti.answer.problems = [`c ${MARK.length} problem`];
    await send('PUT', '/api/settings/agent-prompts/instructions', { template: `c ${MARK}` });
    cti.answer.problems = [];
    cti.answer.transport = true;
    await send('PUT', '/api/settings/agent-prompts/instructions', { template: `d ${MARK}` });
    await send('PUT', '/api/settings/agent-prompts/instructions', { template: MARK.repeat(AGENT_PROMPT_MAX_CHARS.instructions) });
    await send('PUT', '/api/settings/agent-prompts/system', { template: `e ${MARK}` });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(MARK);
  });
});
