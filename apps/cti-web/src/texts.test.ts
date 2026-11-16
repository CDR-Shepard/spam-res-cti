/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentLabel,
  badgeLabel,
  fetchNewTextCount,
  fetchTexts,
  markTextsSeen,
  readTextsSeenAt,
  senderHeadline,
  textsSeenKey,
  textStatusLabel,
  TEXTS_LOOKBACK_MS,
  type TextItem,
} from './texts';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

function textItem(over: Partial<TextItem> = {}): TextItem {
  return {
    id: 'm-1',
    fromE164: '+16195550100',
    toE164: '+16193507799',
    body: 'Call me after 3',
    numMedia: 0,
    receivedAt: '2026-11-16T18:00:00.000Z',
    optOut: false,
    salesforce: 'logged',
    senderName: null,
    openRecordId: null,
    ...over,
  };
}

beforeEach(() => {
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@x.com' }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('seen time', () => {
  const NOW = Date.parse('2026-11-16T18:00:00.000Z');

  it('starts a week back for a rep who never opened the tab', () => {
    expect(readTextsSeenAt('u1', NOW)).toBe(new Date(NOW - TEXTS_LOOKBACK_MS).toISOString());
  });

  it('remembers the newest text the rep has seen, per rep', () => {
    markTextsSeen('u1', '2026-11-16T17:00:00.000Z');
    expect(readTextsSeenAt('u1', NOW)).toBe('2026-11-16T17:00:00.000Z');
    expect(readTextsSeenAt('u2', NOW)).toBe(new Date(NOW - TEXTS_LOOKBACK_MS).toISOString());
    expect(localStorage.getItem(textsSeenKey('u1'))).toBe('2026-11-16T17:00:00.000Z');
  });

  it('never moves back: an older tab cannot bring old texts back as new', () => {
    markTextsSeen('u1', '2026-11-16T17:00:00.000Z');
    markTextsSeen('u1', '2026-11-16T16:00:00.000Z');
    expect(readTextsSeenAt('u1', NOW)).toBe('2026-11-16T17:00:00.000Z');
  });

  it('ignores a stored value that is not a time', () => {
    localStorage.setItem(textsSeenKey('u1'), 'garbage');
    expect(readTextsSeenAt('u1', NOW)).toBe(new Date(NOW - TEXTS_LOOKBACK_MS).toISOString());
    markTextsSeen('u1', '2026-11-16T15:00:00.000Z');
    expect(readTextsSeenAt('u1', NOW)).toBe('2026-11-16T15:00:00.000Z');
  });

  it('keeps working when storage throws (private window, blocked site data)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      expect(() => markTextsSeen('u1', '2026-11-16T17:00:00.000Z')).not.toThrow();
      expect(readTextsSeenAt('u1', NOW)).toBe(new Date(NOW - TEXTS_LOOKBACK_MS).toISOString());
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

describe('badgeLabel', () => {
  it('shows nothing for none, the number up to 9, then 9+', () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(9)).toBe('9');
    expect(badgeLabel(10)).toBe('9+');
    expect(badgeLabel(-1)).toBeNull();
    expect(badgeLabel(Number.NaN)).toBeNull();
  });
});

describe('row wording', () => {
  it('headlines the Salesforce name, else the formatted number', () => {
    expect(senderHeadline(textItem({ senderName: 'Pat Seller' }))).toBe('Pat Seller');
    expect(senderHeadline(textItem())).toBe('+1 (619) 555-0100');
    expect(senderHeadline(textItem({ fromE164: '+447700900123' }))).toBe('+447700900123');
  });

  it('says only what the rep needs to know about Salesforce', () => {
    expect(textStatusLabel(textItem())).toBeNull();
    expect(textStatusLabel(textItem({ salesforce: 'pending' }))).toBe('Logging to Salesforce…');
    expect(textStatusLabel(textItem({ salesforce: 'reconnect' }))).toBe('Not in Salesforce · sign-in expired');
    expect(textStatusLabel(textItem({ salesforce: 'failed' }))).toBe('Not in Salesforce');
  });

  it('counts attachments it cannot show', () => {
    expect(attachmentLabel(0)).toBeNull();
    expect(attachmentLabel(1)).toBe('1 attachment (not shown)');
    expect(attachmentLabel(3)).toBe('3 attachments (not shown)');
  });
});

describe('API calls', () => {
  it('fetchTexts reads the rep\'s list with the session token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ texts: [textItem()] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchTexts()).resolves.toEqual([textItem()]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/texts\?limit=50$/);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('fetchNewTextCount asks for texts after the seen time, encoded', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({ count: 4 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchNewTextCount('2026-11-16T18:00:00.000+00:00')).resolves.toBe(4);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/texts\/new\?since=2026-11-16T18%3A00%3A00.000%2B00%3A00$/);
  });

  it('fetchNewTextCount reads a malformed answer as zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ count: 'lots' })));
    await expect(fetchNewTextCount('2026-11-16T18:00:00.000Z')).resolves.toBe(0);
  });
});
