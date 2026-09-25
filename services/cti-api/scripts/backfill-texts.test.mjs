/**
 * Tests for backfill-texts.mjs (design docs/superpowers/specs/
 * 2026-09-25-inbound-texts-design.md, task 6). `main()` connects to a real
 * Postgres database and calls the real Twilio API, gated behind an `isMain`
 * check (see the module's bottom) — importing this module never touches
 * either. `run(argv, deps)` is the deps-injected entry point `main()` wraps
 * (review finding I3): every test below drives `run()` directly with fakes,
 * so nothing here needs DATABASE_URL, Twilio creds, or a live DB/API.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  INSERT_ROW_SQL,
  SELECT_AGENT_DIDS_SQL,
  SELECT_EXISTING_SIDS_SQL,
  existingSids,
  insertBackfillBatch,
  isInboundMessage,
  parseArgs,
  resolveRep,
  run,
  safeErrorMessage,
  toInsertRow,
} from './backfill-texts.mjs';

/** Collapses SQL to single-spaced text so a pin doesn't care about the
 *  source's own line breaks/indentation — an exact match, not a regex
 *  (review I3: "the scope SQL is pinned with a whitespace-normalized exact
 *  match instead of regexes"). */
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

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

describe('SELECT_AGENT_DIDS_SQL — only this rep\'s OWN agent numbers, never the shared dialer pool (I3: exact, not regex)', () => {
  it('is exactly this, whitespace-normalized', () => {
    expect(norm(SELECT_AGENT_DIDS_SQL)).toBe(
      "select id, e164, org_id from outbound_numbers where kind = 'agent' and assigned_user_id = $1",
    );
  });
});

describe('INSERT_ROW_SQL — bare ON CONFLICT DO NOTHING (the unique index on message_sid is FULL, per migration 0044)', () => {
  it('is exactly this, whitespace-normalized', () => {
    expect(norm(INSERT_ROW_SQL)).toBe(
      "insert into inbound_messages " +
        "(org_id, message_sid, from_e164, to_e164, body, num_media, user_id, status, backfill, backfill_batch, received_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7, 'pending', true, $8, $9) " +
        "on conflict do nothing",
    );
  });
});

describe('SELECT_EXISTING_SIDS_SQL', () => {
  it('is exactly this, whitespace-normalized', () => {
    expect(norm(SELECT_EXISTING_SIDS_SQL)).toBe('select message_sid from inbound_messages where message_sid = any($1)');
  });
});

describe('safeErrorMessage — never leaks Postgres .detail (which can quote a failing row) or the raw error object', () => {
  it('is just the message when there is no code', () => {
    expect(safeErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('appends the code, never .detail, even when detail is set', () => {
    const err = new Error('duplicate key value violates unique constraint');
    err.code = '23505';
    err.detail = 'Key (message_sid)=(SM1) already exists, body was "SUPER SECRET TEXT".';
    expect(safeErrorMessage(err)).toBe('duplicate key value violates unique constraint (code 23505)');
    expect(safeErrorMessage(err)).not.toContain('SUPER SECRET TEXT');
  });

  it('handles a non-Error thrown value', () => {
    expect(safeErrorMessage('just a string')).toBe('just a string');
  });
});

/** A tiny fake pg client: records queries in order, answers by exact SQL
 *  string match (or a function of the params, for a query whose answer
 *  depends on which call it is — e.g. "fail on the 2nd insert"). */
function fakeDb(answers) {
  const calls = [];
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql, params });
    const answer = answers[sql];
    if (answer === undefined) return { rows: [], rowCount: 0 };
    return typeof answer === 'function' ? answer(params, calls) : answer;
  });
  return { query, calls };
}

describe('resolveRep — looks the rep up by email OR by id, never both, and fails loudly on a miss', () => {
  it('looks up by email when given one', async () => {
    const db = fakeDb({
      'select id, email from users where email = $1': { rows: [{ id: 'rep-1', email: 'garrett@gghomes.org' }] },
    });
    const rep = await resolveRep(db, { email: 'garrett@gghomes.org', userId: null });
    expect(rep).toEqual({ id: 'rep-1', email: 'garrett@gghomes.org' });
    expect(db.calls[0].params).toEqual(['garrett@gghomes.org']);
  });

  it('looks up by id when given one', async () => {
    const db = fakeDb({
      'select id, email from users where id = $1': { rows: [{ id: 'rep-1', email: 'garrett@gghomes.org' }] },
    });
    const rep = await resolveRep(db, { email: null, userId: 'rep-1' });
    expect(rep.id).toBe('rep-1');
  });

  it('throws a clear error when no user matches — never silently backfills nobody', async () => {
    const db = fakeDb({ 'select id, email from users where email = $1': { rows: [] } });
    await expect(resolveRep(db, { email: 'nobody@gghomes.org', userId: null })).rejects.toThrow(/nobody@gghomes.org/);
  });
});

describe('existingSids — which of these message_sids are already stored (for an accurate dry-run count)', () => {
  it('returns an empty set without querying when there are no sids', async () => {
    const db = fakeDb({});
    const result = await existingSids(db, []);
    expect(result).toEqual(new Set());
    expect(db.calls).toEqual([]);
  });

  it('queries and returns the matched sids as a Set', async () => {
    const db = fakeDb({ [SELECT_EXISTING_SIDS_SQL]: { rows: [{ message_sid: 'SM1' }, { message_sid: 'SM2' }] } });
    const result = await existingSids(db, ['SM1', 'SM2', 'SM3']);
    expect(result).toEqual(new Set(['SM1', 'SM2']));
    expect(db.calls[0].params).toEqual([['SM1', 'SM2', 'SM3']]);
  });
});

describe('insertBackfillBatch — I1: one transaction for the whole run, never a half-inserted batch', () => {
  const rows = [
    { orgId: 'org-1', messageSid: 'SM1', fromE164: '+1a', toE164: '+1b', body: 'first', numMedia: 0, userId: 'rep-1', backfillBatch: 'batch-1', receivedAt: new Date('2026-09-18T00:00:00Z') },
    { orgId: 'org-1', messageSid: 'SM2', fromE164: '+1a', toE164: '+1b', body: 'second', numMedia: 0, userId: 'rep-1', backfillBatch: 'batch-1', receivedAt: new Date('2026-09-19T00:00:00Z') },
    { orgId: 'org-1', messageSid: 'SM3', fromE164: '+1a', toE164: '+1b', body: 'third', numMedia: 0, userId: 'rep-1', backfillBatch: 'batch-1', receivedAt: new Date('2026-09-20T00:00:00Z') },
  ];

  it('BEGINs, inserts every row, then COMMITs — returns the count actually inserted', async () => {
    const db = fakeDb({ BEGIN: {}, COMMIT: {}, [INSERT_ROW_SQL]: { rowCount: 1 } });
    const inserted = await insertBackfillBatch(db, rows);
    expect(inserted).toBe(3);
    const sqlOrder = db.calls.map((c) => c.sql);
    expect(sqlOrder).toEqual(['BEGIN', INSERT_ROW_SQL, INSERT_ROW_SQL, INSERT_ROW_SQL, 'COMMIT']);
  });

  it('a row already present (ON CONFLICT DO NOTHING, rowCount 0) is not counted, but does not fail the transaction', async () => {
    let n = 0;
    const db = fakeDb({
      BEGIN: {},
      COMMIT: {},
      [INSERT_ROW_SQL]: () => (++n === 2 ? { rowCount: 0 } : { rowCount: 1 }),
    });
    expect(await insertBackfillBatch(db, rows)).toBe(2);
  });

  it('a failure on the 2nd insert ROLLBACKs and never COMMITs — the review\'s exact scenario (I1)', async () => {
    let n = 0;
    const db = fakeDb({
      BEGIN: {},
      ROLLBACK: {},
      [INSERT_ROW_SQL]: () => {
        n++;
        if (n === 2) throw new Error('connection reset');
        return { rowCount: 1 };
      },
    });
    await expect(insertBackfillBatch(db, rows)).rejects.toThrow('connection reset');
    const sqlOrder = db.calls.map((c) => c.sql);
    expect(sqlOrder).toEqual(['BEGIN', INSERT_ROW_SQL, INSERT_ROW_SQL, 'ROLLBACK']);
    expect(sqlOrder).not.toContain('COMMIT');
  });

  it('passes every column in the documented order, including the shared batch id', async () => {
    const db = fakeDb({ BEGIN: {}, COMMIT: {}, [INSERT_ROW_SQL]: { rowCount: 1 } });
    await insertBackfillBatch(db, [rows[0]]);
    const insertCall = db.calls.find((c) => c.sql === INSERT_ROW_SQL);
    expect(insertCall.params).toEqual([
      'org-1', 'SM1', '+1a', '+1b', 'first', 0, 'rep-1', 'batch-1', rows[0].receivedAt,
    ]);
  });
});

// ---------------------------------------------------------------------------
// run(argv, deps) — I3: the whole CLI, deps-injected.
// ---------------------------------------------------------------------------

const SENTINEL = 'THE SECRET MESSAGE BODY SHOULD NEVER BE PRINTED 4471';

/** A fake Twilio SDK client whose `messages.list` returns the given messages
 *  for every DID (good enough for these tests — one DID per rep fixture). */
function fakeTwilio(messages) {
  const list = vi.fn(async () => messages);
  return { messages: { list } };
}

function outputSink() {
  const lines = [];
  return { stdout: (s) => lines.push(String(s)), stderr: (s) => lines.push(String(s)), lines };
}

const REP_ROW = { rows: [{ id: 'rep-1', email: 'garrett@gghomes.org' }] };
const DIDS_ROW = { rows: [{ id: 'n1', e164: '+16195550100', org_id: 'org-1' }] };

function baseDb(overrides = {}) {
  return fakeDb({
    'select id, email from users where email = $1': REP_ROW,
    [SELECT_AGENT_DIDS_SQL]: DIDS_ROW,
    [SELECT_EXISTING_SIDS_SQL]: { rows: [] },
    ...overrides,
  });
}

describe('run — dry run makes ZERO database writes (no INSERT, no BEGIN/COMMIT)', () => {
  it('a dry run with new texts found never calls insertBackfillBatch\'s SQL', async () => {
    const db = baseDb();
    const twilioClient = fakeTwilio([{ sid: 'SM1', from: '+1a', to: '+1b', direction: 'inbound', body: 'hi', dateSent: new Date() }]);
    const out = outputSink();
    const result = await run(['--email', 'garrett@gghomes.org', '--since', '2026-09-01'], { db, twilio: twilioClient, ...out });
    expect(result.exitCode).toBe(0);
    expect(db.calls.map((c) => c.sql)).not.toContain(INSERT_ROW_SQL);
    expect(db.calls.map((c) => c.sql)).not.toContain('BEGIN');
    expect(db.calls.map((c) => c.sql)).not.toContain('COMMIT');
  });

  it('--apply actually inserts (contrast case, proving the dry-run assertion above is meaningful)', async () => {
    const db = baseDb();
    const twilioClient = fakeTwilio([{ sid: 'SM1', from: '+1a', to: '+1b', direction: 'inbound', body: 'hi', dateSent: new Date() }]);
    const out = outputSink();
    const result = await run(['--email', 'garrett@gghomes.org', '--since', '2026-09-01', '--apply'], { db, twilio: twilioClient, ...out });
    expect(result.exitCode).toBe(0);
    expect(db.calls.map((c) => c.sql)).toContain(INSERT_ROW_SQL);
    expect(db.calls.map((c) => c.sql)).toContain('COMMIT');
  });

  it('the dry run does not print a batch id (one is not assigned until --apply actually needs it)', async () => {
    const db = baseDb();
    const twilioClient = fakeTwilio([{ sid: 'SM1', from: '+1a', to: '+1b', direction: 'inbound', body: 'hi', dateSent: new Date() }]);
    const out = outputSink();
    await run(['--email', 'garrett@gghomes.org', '--since', '2026-09-01'], { db, twilio: twilioClient, ...out });
    const joined = out.lines.join('\n');
    expect(joined).toContain('A new batch id is assigned on --apply');
    expect(joined).not.toMatch(/batch would be/);
  });
});

describe('run — a sentinel message body never reaches stdout or stderr, on the dry-run path or the error path', () => {
  it('dry-run path: the body is never printed even though it is right there in the fetched message', async () => {
    const db = baseDb();
    const twilioClient = fakeTwilio([{ sid: 'SM1', from: '+1a', to: '+1b', direction: 'inbound', body: SENTINEL, dateSent: new Date() }]);
    const out = outputSink();
    await run(['--email', 'garrett@gghomes.org', '--since', '2026-09-01'], { db, twilio: twilioClient, ...out });
    expect(out.lines.join('\n')).not.toContain(SENTINEL);
  });

  it('error path: a Postgres error whose .detail quotes the sentinel body never reaches output', async () => {
    let n = 0;
    const db = baseDb({
      [INSERT_ROW_SQL]: () => {
        n++;
        if (n === 1) {
          const err = new Error('duplicate key value violates unique constraint "inbound_messages_message_sid_unique"');
          err.code = '23505';
          err.detail = `Key (message_sid)=(SM1) already exists, body was "${SENTINEL}".`;
          throw err;
        }
        return { rowCount: 1 };
      },
    });
    const twilioClient = fakeTwilio([{ sid: 'SM1', from: '+1a', to: '+1b', direction: 'inbound', body: SENTINEL, dateSent: new Date() }]);
    const out = outputSink();
    const result = await run(['--email', 'garrett@gghomes.org', '--since', '2026-09-01', '--apply'], { db, twilio: twilioClient, ...out });
    expect(result.exitCode).toBe(1);
    expect(out.lines.join('\n')).not.toContain(SENTINEL);
    expect(out.lines.join('\n')).toContain('duplicate key value violates unique constraint');
  });
});

describe('run — other behavior', () => {
  it('a bad --since is reported via stderr and exits 1, never throwing out of run()', async () => {
    const out = outputSink();
    const result = await run(['--email', 'a@b.com'], { db: baseDb(), twilio: fakeTwilio([]), ...out });
    expect(result.exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('--since');
  });

  it('a rep with no agent DIDs backfills nothing and never calls Twilio', async () => {
    const db = baseDb({ [SELECT_AGENT_DIDS_SQL]: { rows: [] } });
    const twilioClient = fakeTwilio([]);
    const out = outputSink();
    const result = await run(['--email', 'garrett@gghomes.org', '--since', '2026-09-01'], { db, twilio: twilioClient, ...out });
    expect(result.exitCode).toBe(0);
    expect(twilioClient.messages.list).not.toHaveBeenCalled();
  });

  it('filters to inbound only and skips already-stored sids before deciding what is new', async () => {
    const db = baseDb({ [SELECT_EXISTING_SIDS_SQL]: { rows: [{ message_sid: 'SM1' }] } });
    const twilioClient = fakeTwilio([
      { sid: 'SM1', from: '+1a', to: '+1b', direction: 'inbound', body: 'already stored', dateSent: new Date() },
      { sid: 'SM2', from: '+1a', to: '+1b', direction: 'inbound', body: 'new', dateSent: new Date() },
      { sid: 'SM3', from: '+1a', to: '+1b', direction: 'outbound-reply', body: 'ours', dateSent: new Date() },
    ]);
    const out = outputSink();
    await run(['--email', 'garrett@gghomes.org', '--since', '2026-09-01', '--apply'], { db, twilio: twilioClient, ...out });
    const insertCalls = db.calls.filter((c) => c.sql === INSERT_ROW_SQL);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params[1]).toBe('SM2');
  });
});
