/**
 * The unsubscribe page and one-click unsubscribe. The unit lane replaces the conversation store with fakes so
 * it can pin what the route does and never does: GET changes nothing (mail scanners prefetch links), POST
 * stops the seller whatever its body or content type (RFC 8058 senders vary), a malformed token never reaches
 * the database, and neither a token, an address nor a name reaches a log line. The same flows on real tables
 * are in email-unsubscribe.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@cti/db';
import { buildApp } from '../app.js';
import { testConfig } from '../test/harness.js';
import { registerEmailUnsubscribeRoutes } from './email-unsubscribe.js';

const store = vi.hoisted(() => ({
  findConversationByToken: vi.fn(),
  stopSeller: vi.fn(),
}));
vi.mock('../conversations/store.js', () => store);

const TOKEN = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 20) + '234567';
const URL_PATH = `/api/email/unsubscribe/${TOKEN}`;
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const FAKE_DB = { fake: 'db' } as unknown as Db;

let app: FastifyInstance;
let logLines: string[];

async function build(companyName = 'GG Homes') {
  logLines = [];
  app = await buildApp({
    // development logs at debug level, so the request log lines exist to be read.
    cfg: testConfig({ NODE_ENV: 'development' }),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    logStream: { write: (line) => logLines.push(line) },
    apiRoutes: [(scope) => registerEmailUnsubscribeRoutes(scope, { db: FAKE_DB, companyName, now: () => NOW })],
  });
}

beforeEach(() => {
  store.findConversationByToken.mockReset().mockResolvedValue({ id: CONVERSATION_ID, token: TOKEN, orgId: 'org-1', crmRecordId: 'rec-1', practiceUserId: null });
  store.stopSeller.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  await app?.close();
});

/** The visible text of a page: tags dropped, the five entities escapeHtml writes decoded. */
function textOf(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

const post = (url: string, headers: Record<string, string>, payload?: string | Buffer) =>
  app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });

describe('GET /api/email/unsubscribe/:token', () => {
  it('shows the confirmation page with an Unsubscribe button, and changes nothing', async () => {
    await build();
    const res = await app.inject({ method: 'GET', url: URL_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<title>Unsubscribe<\/title>/);
    expect(res.body).toMatch(/<form method="post">/);
    expect(res.body).toMatch(/<button type="submit">Unsubscribe<\/button>/);
    expect(textOf(res.body)).toContain("Click the button to stop all calls, texts and emails from Sam, GG Homes' AI assistant.");
    expect(store.findConversationByToken).toHaveBeenCalledWith(FAKE_DB, TOKEN);
    expect(store.stopSeller).not.toHaveBeenCalled();
  });

  it('needs no session: there is no cookie and no bearer token on the request', async () => {
    await build();
    expect((await app.inject({ method: 'GET', url: URL_PATH })).statusCode).toBe(200);
  });

  it('carries the cache, robots, referrer and content-security headers, and has no script', async () => {
    await build();
    const res = await app.inject({ method: 'GET', url: URL_PATH });
    expect(res.headers).toMatchObject(SECURITY_HEADERS);
    expect(res.body.toLowerCase()).not.toContain('<script');
    expect(res.body).not.toMatch(/\son[a-z]+=/i);
  });

  it('shows nothing about the seller: not the token, the ids, or anything else from the conversation', async () => {
    await build();
    const { body } = await app.inject({ method: 'GET', url: URL_PATH });
    for (const secret of [TOKEN, CONVERSATION_ID, 'org-1', 'rec-1']) expect(body).not.toContain(secret);
  });

  it('writes the company name as text, never as markup', async () => {
    await build('<b onclick="x()">Acme & "Sons"</b>');
    const { body } = await app.inject({ method: 'GET', url: URL_PATH });
    expect(body).not.toContain('<b onclick');
    expect(body).toContain('&lt;b onclick=&quot;x()&quot;&gt;Acme &amp; &quot;Sons&quot;&lt;/b&gt;&#39;s AI assistant');
  });

  it('uses the possessive of the company name: Acme becomes Acme\'s, GG Homes becomes GG Homes\'', async () => {
    await build('Acme');
    expect(textOf((await app.inject({ method: 'GET', url: URL_PATH })).body)).toContain("from Sam, Acme's AI assistant.");
  });
});

describe('POST /api/email/unsubscribe/:token', () => {
  const UNSUBSCRIBED = "You're unsubscribed. Sam, GG Homes' AI assistant, won't call, text or email you again.";

  it('List-Unsubscribe=One-Click as urlencoded stops the seller as opted_out and shows the confirmation', async () => {
    await build();
    const res = await post(URL_PATH, { 'content-type': 'application/x-www-form-urlencoded' }, 'List-Unsubscribe=One-Click');
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject(SECURITY_HEADERS);
    expect(textOf(res.body)).toContain(UNSUBSCRIBED);
    expect(res.body).not.toMatch(/<form/);
    expect(store.stopSeller).toHaveBeenCalledTimes(1);
    expect(store.stopSeller).toHaveBeenCalledWith(FAKE_DB, { conversationId: CONVERSATION_ID, reason: 'opted_out', now: NOW });
  });

  it.each([
    ['multipart/form-data', 'multipart/form-data; boundary=xyz', '--xyz\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--xyz--\r\n'],
    ['JSON', 'application/json', '{"List-Unsubscribe":"One-Click"}'],
    ['malformed JSON', 'application/json', '{ this is not json'],
    ['text/plain', 'text/plain', 'unsubscribe me'],
    ['an unknown type', 'application/x-something-else', '\u0000\u0001binary'],
    ['an empty urlencoded body', 'application/x-www-form-urlencoded', ''],
  ])('accepts %s and stops the seller', async (_name, contentType, payload) => {
    await build();
    const res = await post(URL_PATH, { 'content-type': contentType }, payload);
    expect(res.statusCode).toBe(200);
    expect(store.stopSeller).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty POST with no content type', async () => {
    await build();
    const res = await app.inject({ method: 'POST', url: URL_PATH });
    expect(res.statusCode).toBe(200);
    expect(store.stopSeller).toHaveBeenCalledTimes(1);
  });

  it('accepts a body with no content type', async () => {
    await build();
    const res = await app.inject({ method: 'POST', url: URL_PATH, payload: 'List-Unsubscribe=One-Click' });
    expect(res.statusCode).toBe(200);
    expect(store.stopSeller).toHaveBeenCalledTimes(1);
  });

  it('repeating it is fine: both answer 200 with the confirmation', async () => {
    store.stopSeller.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await build();
    const first = await post(URL_PATH, { 'content-type': 'application/x-www-form-urlencoded' }, 'List-Unsubscribe=One-Click');
    const second = await post(URL_PATH, { 'content-type': 'application/x-www-form-urlencoded' }, 'List-Unsubscribe=One-Click');
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(textOf(second.body)).toContain(UNSUBSCRIBED);
  });

  it('refuses a body over 8 KB with 413 and stops nobody', async () => {
    await build();
    const res = await post(URL_PATH, { 'content-type': 'application/x-www-form-urlencoded' }, 'a='.padEnd(8 * 1024 + 1, 'x'));
    expect(res.statusCode).toBe(413);
    expect(store.stopSeller).not.toHaveBeenCalled();
  });

  it('answers a page, not JSON, when the stop fails, and says nothing about why', async () => {
    store.stopSeller.mockRejectedValue(Object.assign(new Error('boom: seller@example.com'), { code: '40001', detail: 'Key (address)=(seller@example.com)' }));
    await build();
    const res = await post(URL_PATH, { 'content-type': 'application/x-www-form-urlencoded' }, 'List-Unsubscribe=One-Click');
    expect(res.statusCode).toBe(500);
    expect(res.headers).toMatchObject(SECURITY_HEADERS);
    expect(textOf(res.body)).toContain('Something went wrong. Please try again in a minute.');
    expect(res.body).not.toContain('seller@example.com');
    expect(res.body).toMatch(/<form method="post">/);
  });
});

describe('an unknown or malformed token', () => {
  const NOT_VALID = 'This link is not valid.';

  it('an unknown token is 404 with the not-valid page, on GET and on POST, and stops nobody', async () => {
    store.findConversationByToken.mockResolvedValue(null);
    await build();
    for (const res of [await app.inject({ method: 'GET', url: URL_PATH }), await post(URL_PATH, { 'content-type': 'application/x-www-form-urlencoded' }, 'List-Unsubscribe=One-Click')]) {
      expect(res.statusCode).toBe(404);
      expect(res.headers).toMatchObject(SECURITY_HEADERS);
      expect(textOf(res.body)).toContain(NOT_VALID);
      expect(res.body).not.toMatch(/<form/);
    }
    expect(store.stopSeller).not.toHaveBeenCalled();
  });

  it.each([
    ['ABC', 'ABC'],
    ['an upper-case token of the right length', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['25 characters', 'abcdefghijklmnopqrstuvwxy'],
    ['27 characters', 'abcdefghijklmnopqrstuvwxyz2'],
    ['a digit outside 2-7', 'abcdefghijklmnopqrstuvwxy1'],
    ['a zero', 'abcdefghijklmnopqrstuvwxy0'],
    ['padding', 'abcdefghijklmnopqrstuvwx='],
    ['a hyphen', 'abcdefghijklmnopqrstuvwx-y'],
    ['an encoded space', 'abcdefghijklmnopqrstuvwx%20y'],
  ])('%s is 404 and never reaches the database', async (_name, token) => {
    await build();
    for (const res of [
      await app.inject({ method: 'GET', url: `/api/email/unsubscribe/${token}` }),
      await post(`/api/email/unsubscribe/${token}`, { 'content-type': 'application/x-www-form-urlencoded' }, 'List-Unsubscribe=One-Click'),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.headers).toMatchObject(SECURITY_HEADERS);
      expect(textOf(res.body)).toContain(NOT_VALID);
    }
    expect(store.findConversationByToken).not.toHaveBeenCalled();
    expect(store.stopSeller).not.toHaveBeenCalled();
  });
});

describe('logs', () => {
  it('never carry the token, an address or a name, but carry the conversation id when a seller unsubscribes', async () => {
    await build();
    await app.inject({ method: 'GET', url: URL_PATH });
    await post(URL_PATH, { 'content-type': 'application/x-www-form-urlencoded' }, 'List-Unsubscribe=One-Click');
    store.stopSeller.mockRejectedValue(Object.assign(new Error('boom: seller@example.com'), { code: '23505', detail: 'Key (address)=(seller@example.com)' }));
    await post(URL_PATH, { 'content-type': 'application/x-www-form-urlencoded' }, 'List-Unsubscribe=One-Click');
    await app.inject({ method: 'GET', url: '/api/email/unsubscribe/ABC' });
    await app.close();
    const log = logLines.join('');
    expect(log).toContain('/api/email/unsubscribe/');
    expect(log).toContain(CONVERSATION_ID);
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('seller@example.com');
    expect(log).not.toContain('GG Homes');
  });
});
