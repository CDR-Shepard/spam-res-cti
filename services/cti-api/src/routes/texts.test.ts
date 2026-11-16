import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { InboundMessage } from '@cti/db';
import type { TaskLinkInfo } from '../sms/text-list.js';

const state = vi.hoisted(() => ({
  authedUser: null as { userId: string; orgId: string; email: string; isAdmin: boolean } | null,
}));

vi.mock('@cti/auth', () => ({
  resolveSession: async () => state.authedUser,
}));

import { registerTextRoutes, type TextRouteDeps } from './texts.js';

const REP = { userId: 'u-1', orgId: 'o-1', email: 'rep@example.com', isAdmin: false };

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  id: 'm-1',
  orgId: 'o-1',
  messageSid: 'SM1',
  fromE164: '+16195550100',
  toE164: '+16193507799',
  body: 'Call me after 3',
  numMedia: 0,
  userId: 'u-1',
  status: 'done',
  attempts: 1,
  nextAttemptAt: new Date('2026-11-16T18:00:00Z'),
  lastError: null,
  sfTaskId: '00T000000000001AAA',
  emailedAt: null,
  emailSkipReason: null,
  backfill: false,
  backfillBatch: null,
  receivedAt: new Date('2026-11-16T18:00:00Z'),
  createdAt: new Date('2026-11-16T18:00:00Z'),
  updatedAt: new Date('2026-11-16T18:00:00Z'),
  ...over,
});

function fakeDeps(over: Partial<TextRouteDeps> = {}): TextRouteDeps & {
  listTexts: ReturnType<typeof vi.fn>;
  countSince: ReturnType<typeof vi.fn>;
  taskLinks: ReturnType<typeof vi.fn>;
} {
  return {
    listTexts: vi.fn(async () => [] as InboundMessage[]),
    countSince: vi.fn(async () => 0),
    taskLinks: vi.fn(async () => new Map<string, TaskLinkInfo>()),
    ...over,
  } as never;
}

describe('text routes', () => {
  let app: FastifyInstance;
  let deps: ReturnType<typeof fakeDeps>;

  async function build(d: ReturnType<typeof fakeDeps>): Promise<void> {
    deps = d;
    app = Fastify();
    await registerTextRoutes(app, d);
    await app.ready();
  }

  beforeEach(() => {
    state.authedUser = REP;
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /texts', () => {
    it('refuses without a session', async () => {
      await build(fakeDeps());
      state.authedUser = null;
      const res = await app.inject({ method: 'GET', url: '/texts' });
      expect(res.statusCode).toBe(401);
      expect(deps.listTexts).not.toHaveBeenCalled();
    });

    it("lists the signed-in rep's own texts, 50 by default", async () => {
      await build(fakeDeps());
      const res = await app.inject({ method: 'GET', url: '/texts' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ texts: [] });
      expect(deps.listTexts).toHaveBeenCalledWith('u-1', 50);
      expect(deps.taskLinks).not.toHaveBeenCalled();
    });

    it('takes a limit up to 100 and ignores a bad one', async () => {
      await build(fakeDeps());
      await app.inject({ method: 'GET', url: '/texts?limit=100' });
      await app.inject({ method: 'GET', url: '/texts?limit=500' });
      await app.inject({ method: 'GET', url: '/texts?limit=abc' });
      expect(deps.listTexts.mock.calls.map((c) => c[1])).toEqual([100, 50, 50]);
    });

    it('names each sender from its Salesforce Task, in one lookup', async () => {
      const rows = [
        msg(),
        msg({ id: 'm-2', sfTaskId: '00T000000000002AAA', fromE164: '+16195550111' }),
        msg({ id: 'm-3', sfTaskId: null, status: 'failed', lastError: 'reconnect Salesforce' }),
      ];
      await build(fakeDeps({
        listTexts: vi.fn(async () => rows),
        taskLinks: vi.fn(async () => new Map<string, TaskLinkInfo>([
          ['00T000000000001AAA', { whoId: '00Q000000000001AAA', whatId: null, whoName: 'Lee Lead', whatName: null }],
        ])),
      }) as never);
      const res = await app.inject({ method: 'GET', url: '/texts' });
      expect(deps.taskLinks).toHaveBeenCalledWith('u-1', ['00T000000000001AAA', '00T000000000002AAA']);
      const texts = res.json().texts;
      expect(texts.map((t: { id: string }) => t.id)).toEqual(['m-1', 'm-2', 'm-3']);
      expect(texts[0]).toMatchObject({ senderName: 'Lee Lead', openRecordId: '00Q000000000001AAA', salesforce: 'logged' });
      // Salesforce answered without m-2's Task: it is gone, so nothing to open.
      expect(texts[1]).toMatchObject({ senderName: null, openRecordId: null, salesforce: 'logged' });
      expect(texts[2]).toMatchObject({ senderName: null, openRecordId: null, salesforce: 'reconnect' });
    });

    it('still lists the texts when Salesforce cannot be reached', async () => {
      await build(fakeDeps({
        listTexts: vi.fn(async () => [msg()]),
        taskLinks: vi.fn(async () => { throw new Error('SOQL failed (401)'); }),
      }) as never);
      const res = await app.inject({ method: 'GET', url: '/texts' });
      expect(res.statusCode).toBe(200);
      expect(res.json().texts[0]).toMatchObject({ body: 'Call me after 3', senderName: null, openRecordId: '00T000000000001AAA' });
    });

    it('never returns the internal error text or message id', async () => {
      await build(fakeDeps({ listTexts: vi.fn(async () => [msg({ sfTaskId: null, status: 'failed', lastError: 'task create failed (400): [secret]' })]) }) as never);
      const res = await app.inject({ method: 'GET', url: '/texts' });
      expect(res.body).not.toContain('secret');
      expect(res.body).not.toContain('SM1');
      expect(res.json().texts[0].salesforce).toBe('failed');
    });
  });

  describe('GET /texts/new', () => {
    it('refuses without a session', async () => {
      await build(fakeDeps());
      state.authedUser = null;
      const res = await app.inject({ method: 'GET', url: '/texts/new?since=2026-11-16T18:00:00.000Z' });
      expect(res.statusCode).toBe(401);
    });

    it('counts the texts that arrived after the given time', async () => {
      await build(fakeDeps({ countSince: vi.fn(async () => 3) }) as never);
      const res = await app.inject({ method: 'GET', url: '/texts/new?since=2026-11-16T18:00:00.000Z' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ count: 3 });
      expect(deps.countSince).toHaveBeenCalledWith('u-1', new Date('2026-11-16T18:00:00.000Z'));
    });

    it('rejects a missing or malformed time', async () => {
      await build(fakeDeps());
      for (const url of ['/texts/new', '/texts/new?since=yesterday', '/texts/new?since=']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(400);
      }
      expect(deps.countSince).not.toHaveBeenCalled();
    });
  });
});
