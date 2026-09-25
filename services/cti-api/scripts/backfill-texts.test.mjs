/**
 * Tests for the pure, DB/Twilio-free pieces of backfill-texts.mjs (design
 * docs/superpowers/specs/2026-09-25-inbound-texts-design.md, task 6). The
 * script's `main()` connects to a real Postgres database and calls the real
 * Twilio API, gated behind an `isMain` check (see the module's bottom) —
 * importing this module for its exported helpers never touches either, and
 * never logs a message body.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  INSERT_ROW_SQL,
  SELECT_AGENT_DIDS_SQL,
  SELECT_EXISTING_SIDS_SQL,
  existingSids,
  insertBackfillRow,
  isInboundMessage,
  parseArgs,
  resolveRep,
  toInsertRow,
} from './backfill-texts.mjs';

describe('parseArgs', () => {
  const SINCE = ['--since', '2026-09-01'];

  it('accepts --email + --since, dry run by default', () => {
    expect(parseArgs(['--email', 'garrett@gghomes.org', ...SINCE])).toEqual({
      apply: false, email: 'garrett@gghomes.org', userId: null, since: '2026-09-01',
    });
  });

  it('accepts --user-id + --since', () => {
    expect(parseArgs(['--user-id', 'abc-123', ...SINCE])).toEqual({
      apply: false, email: null, userId: 'abc-123', since: '2026-09-01',
    });
  });

  it('--apply turns writes on', () => {
    expect(parseArgs(['--email', 'a@b.com', ...SINCE, '--apply']).apply).toBe(true);
  });

  it('requires one of --email / --user-id', () => {
    expect(() => parseArgs([...SINCE])).toThrow(/--email.*--user-id/);
  });

  it('rejects BOTH --email and --user-id at once — ambiguous which rep', () => {
    expect(() => parseArgs(['--email', 'a@b.com', '--user-id', 'x', ...SINCE])).toThrow(/not both/);
  });

  it('requires --since in YYYY-MM-DD form', () => {
    expect(() => parseArgs(['--email', 'a@b.com'])).toThrow(/--since/);
    expect(() => parseArgs(['--email', 'a@b.com', '--since', '09/01/2026'])).toThrow(/--since/);
    expect(() => parseArgs(['--email', 'a@b.com', '--since', '2026-9-1'])).toThrow(/--since/);
  });
});

describe('isInboundMessage', () => {
  it('true only for direction "inbound" — an outbound text from this same number must never be backfilled', () => {
    expect(isInboundMessage({ direction: 'inbound' })).toBe(true);
    expect(isInboundMessage({ direction: 'outbound-api' })).toBe(false);
    expect(isInboundMessage({ direction: 'outbound-reply' })).toBe(false);
    expect(isInboundMessage({})).toBe(false);
  });
});

describe('toInsertRow — pure transform from a Twilio Message resource to an inbound_messages row', () => {
  const ctx = { orgId: 'org-1', userId: 'rep-1', batchId: 'batch-1' };

  it('maps sid/from/to/body/userId/batch, backfill=true implicit at the SQL layer', () => {
    const message = {
      sid: 'SM0123456789abcdef0123456789abcdef',
      from: '+16195550100',
      to: '+18585550199',
      body: 'is the house still available',
      numMedia: '0',
      direction: 'inbound',
      dateSent: new Date('2026-09-18T21:05:00Z'),
    };
    expect(toInsertRow(message, ctx)).toEqual({
      orgId: 'org-1',
      messageSid: 'SM0123456789abcdef0123456789abcdef',
      fromE164: '+16195550100',
      toE164: '+18585550199',
      body: 'is the house still available',
      numMedia: 0,
      userId: 'rep-1',
      backfillBatch: 'batch-1',
      receivedAt: new Date('2026-09-18T21:05:00Z'),
    });
  });

  it('parses numMedia to an int, defaulting to 0 for anything unparseable', () => {
    expect(toInsertRow({ sid: 'SM1', from: 'a', to: 'b', numMedia: '3', dateSent: new Date() }, ctx).numMedia).toBe(3);
    expect(toInsertRow({ sid: 'SM1', from: 'a', to: 'b', numMedia: undefined, dateSent: new Date() }, ctx).numMedia).toBe(0);
  });

  it('defaults body to an empty string when absent (never undefined into the DB)', () => {
    expect(toInsertRow({ sid: 'SM1', from: 'a', to: 'b', body: undefined, dateSent: new Date() }, ctx).body).toBe('');
  });

  it('accepts dateSent as an ISO string too (defensive — the live SDK returns a Date, but never trust it blindly)', () => {
    const out = toInsertRow({ sid: 'SM1', from: 'a', to: 'b', dateSent: '2026-09-18T21:05:00.000Z' }, ctx);
    expect(out.receivedAt).toEqual(new Date('2026-09-18T21:05:00Z'));
  });
});

describe('SELECT_AGENT_DIDS_SQL — only this rep\'s OWN agent numbers, never the shared dialer pool', () => {
  it('filters to kind=agent and this rep', () => {
    expect(SELECT_AGENT_DIDS_SQL).toMatch(/kind\s*=\s*'agent'/);
    expect(SELECT_AGENT_DIDS_SQL).toMatch(/assigned_user_id\s*=\s*\$1/);
  });
});

describe('INSERT_ROW_SQL — bare ON CONFLICT DO NOTHING (the unique index on message_sid is FULL, per migration 0044)', () => {
  it('inserts as backfill=true, status pending, with the batch id', () => {
    expect(INSERT_ROW_SQL).toMatch(/insert into inbound_messages/i);
    expect(INSERT_ROW_SQL).toMatch(/'pending'/);
    expect(INSERT_ROW_SQL).toMatch(/true/);
    expect(INSERT_ROW_SQL).toMatch(/on conflict do nothing/i);
    // Bare form — no explicit target/predicate, matching the repo convention
    // that keeps this working even if the unique index shape ever changes.
    expect(INSERT_ROW_SQL).not.toMatch(/on conflict\s*\(/i);
  });
});

describe('SELECT_EXISTING_SIDS_SQL', () => {
  it('checks message_sid against an array', () => {
    expect(SELECT_EXISTING_SIDS_SQL).toMatch(/message_sid\s*=\s*any\(\$1\)/i);
  });
});

/** A tiny fake pg client: records queries, answers by exact SQL string match. */
function fakeClient(answers) {
  const calls = [];
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql, params });
    const answer = answers[sql];
    if (answer === undefined) throw new Error(`fakeClient: no answer configured for ${JSON.stringify(sql)}`);
    return typeof answer === 'function' ? answer(params) : answer;
  });
  return { query, calls };
}

describe('resolveRep — looks the rep up by email OR by id, never both, and fails loudly on a miss', () => {
  it('looks up by email when given one', async () => {
    const client = fakeClient({
      'select id, email from users where email = $1': { rows: [{ id: 'rep-1', email: 'garrett@gghomes.org' }] },
    });
    const rep = await resolveRep(client, { email: 'garrett@gghomes.org', userId: null });
    expect(rep).toEqual({ id: 'rep-1', email: 'garrett@gghomes.org' });
    expect(client.calls[0].params).toEqual(['garrett@gghomes.org']);
  });

  it('looks up by id when given one', async () => {
    const client = fakeClient({
      'select id, email from users where id = $1': { rows: [{ id: 'rep-1', email: 'garrett@gghomes.org' }] },
    });
    const rep = await resolveRep(client, { email: null, userId: 'rep-1' });
    expect(rep.id).toBe('rep-1');
  });

  it('throws a clear error when no user matches — never silently backfills nobody', async () => {
    const client = fakeClient({ 'select id, email from users where email = $1': { rows: [] } });
    await expect(resolveRep(client, { email: 'nobody@gghomes.org', userId: null })).rejects.toThrow(/nobody@gghomes.org/);
  });
});

describe('insertBackfillRow — reports whether THIS call actually inserted (idempotency check)', () => {
  const row = {
    orgId: 'org-1', messageSid: 'SM1', fromE164: '+1a', toE164: '+1b', body: 'hi',
    numMedia: 0, userId: 'rep-1', backfillBatch: 'batch-1', receivedAt: new Date('2026-09-18T21:05:00Z'),
  };

  it('returns true when the insert landed (rowCount 1)', async () => {
    const client = fakeClient({ [INSERT_ROW_SQL]: { rowCount: 1 } });
    expect(await insertBackfillRow(client, row)).toBe(true);
    expect(client.calls[0].params).toEqual([
      'org-1', 'SM1', '+1a', '+1b', 'hi', 0, 'rep-1', 'batch-1', row.receivedAt,
    ]);
  });

  it('returns false when the row already existed (ON CONFLICT DO NOTHING, rowCount 0) — a re-run is a no-op', async () => {
    const client = fakeClient({ [INSERT_ROW_SQL]: { rowCount: 0 } });
    expect(await insertBackfillRow(client, row)).toBe(false);
  });
});

describe('existingSids — which of these message_sids are already stored (for an accurate dry-run count)', () => {
  it('returns an empty set without querying when there are no sids', async () => {
    const client = fakeClient({});
    const result = await existingSids(client, []);
    expect(result).toEqual(new Set());
    expect(client.calls).toEqual([]);
  });

  it('queries and returns the matched sids as a Set', async () => {
    const client = fakeClient({ [SELECT_EXISTING_SIDS_SQL]: { rows: [{ message_sid: 'SM1' }, { message_sid: 'SM2' }] } });
    const result = await existingSids(client, ['SM1', 'SM2', 'SM3']);
    expect(result).toEqual(new Set(['SM1', 'SM2']));
    expect(client.calls[0].params).toEqual([['SM1', 'SM2', 'SM3']]);
  });
});
