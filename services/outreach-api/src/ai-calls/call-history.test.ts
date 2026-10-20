import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_TEXT_MAX } from '@cti/contracts';
import type { Db } from '@cti/db';

const m = vi.hoisted(() => ({ realConversation: vi.fn(), readTimeline: vi.fn(), historyDigest: vi.fn() }));
vi.mock('../conversations/seller-view.js', () => ({ realConversation: m.realConversation }));
vi.mock('../conversations/timeline.js', () => ({ readTimeline: m.readTimeline }));
vi.mock('../conversations/digest.js', () => ({ historyDigest: m.historyDigest }));

import { callHistory } from './call-history.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const RECORD = '22222222-2222-4222-8222-222222222222';
const TOUCH = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const db = { tag: 'db' } as unknown as Db;
const SECRET_TEXT = 'PRIVATE seller reply text';
const ids = { orgId: ORG, touchId: TOUCH, crmRecordId: RECORD };
const WARN = "ai_call.place: the seller's history could not be read; the call goes without it";

let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetAllMocks();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  m.realConversation.mockResolvedValue({ id: CONVERSATION });
  m.readTimeline.mockResolvedValue([{ type: 'note' }]);
  m.historyDigest.mockReturnValue('2026-10-02 Email from Sam — "Hi": Hello');
});

describe('callHistory', () => {
  it('reads the seller\'s real conversation, then digests it to the trigger\'s cap', async () => {
    expect(await callHistory({ db, log }, ids)).toBe('2026-10-02 Email from Sam — "Hi": Hello');
    expect(m.realConversation).toHaveBeenCalledWith(db, ORG, RECORD);
    expect(m.readTimeline).toHaveBeenCalledWith(db, { orgId: ORG, crmRecordId: RECORD, conversationId: CONVERSATION });
    expect(m.historyDigest).toHaveBeenCalledWith([{ type: 'note' }], HISTORY_TEXT_MAX);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a seller with no conversation yet still has her calls read (conversationId null)', async () => {
    m.realConversation.mockResolvedValue(null);
    await callHistory({ db, log }, ids);
    expect(m.readTimeline).toHaveBeenCalledWith(db, { orgId: ORG, crmRecordId: RECORD, conversationId: null });
  });

  it('an empty digest is no history (null), not an empty string', async () => {
    m.historyDigest.mockReturnValue('');
    expect(await callHistory({ db, log }, ids)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the conversation lookup', () => m.realConversation.mockRejectedValue(new RangeError(SECRET_TEXT)), 'RangeError'],
    ['the timeline read', () => m.readTimeline.mockRejectedValue(new TypeError(SECRET_TEXT)), 'TypeError'],
    ['the digest', () => m.historyDigest.mockImplementation(() => { throw new SyntaxError(SECRET_TEXT); }), 'SyntaxError'],
    ['a non-Error throw', () => m.readTimeline.mockRejectedValue(SECRET_TEXT), 'string'],
  ])('%s throwing: no history, one warning with the ids and the error name only', async (_what, arrange, name) => {
    arrange();
    expect(await callHistory({ db, log }, ids)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ orgId: ORG, touchId: TOUCH, errName: name }, WARN);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(SECRET_TEXT);
  });
});
