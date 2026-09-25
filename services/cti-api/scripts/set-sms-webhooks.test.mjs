/**
 * Tests for set-sms-webhooks.mjs (design docs/superpowers/specs/
 * 2026-09-25-inbound-texts-design.md, task 7; review findings I3/I4).
 * `main()` connects to a real Postgres database and calls the real Twilio
 * API, gated behind an `isMain` check (see the module's bottom) — importing
 * this module never touches either. `run(argv, deps)` is the deps-injected
 * entry point `main()` wraps (I3): every behavior test below drives `run()`
 * directly with fakes, so nothing here needs DATABASE_URL, Twilio creds, a
 * live DB/API, or the real filesystem.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROLLBACK_KIND,
  ROLLBACK_VERSION,
  SELECT_NUMBERS_SQL,
  applyTwilioNumber,
  buildRollbackFile,
  buildRollbackRecords,
  classifyNumbers,
  defaultRollbackFilePath,
  fetchTwilioNumber,
  ignoresSmsUrl,
  parseArgs,
  run,
  safeErrorMessage,
  smsWebhookUrl,
  summarizeHosts,
  urlHost,
  validateRollbackFile,
} from './set-sms-webhooks.mjs';

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const DESIRED = 'https://ctiapi-production.up.railway.app/telephony/twilio/sms';
const API_PUBLIC_URL = 'https://ctiapi-production.up.railway.app';

describe('parseArgs', () => {
  it('defaults to a dry run with no rollback-file override and no restore', () => {
    expect(parseArgs([])).toEqual({ apply: false, rollbackFile: null, restoreFile: null });
  });

  it('--apply is the only thing that turns writes on', () => {
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(parseArgs(['--something-else']).apply).toBe(false);
  });

  it('--rollback-file overrides the default path', () => {
    expect(parseArgs(['--rollback-file', './my-backup.json']).rollbackFile).toBe('./my-backup.json');
  });

  it('--restore <file> sets restoreFile', () => {
    expect(parseArgs(['--restore', './rollback.json'])).toEqual({ apply: false, rollbackFile: null, restoreFile: './rollback.json' });
  });

  it('--restore + --apply both set, so restore mode writes', () => {
    expect(parseArgs(['--restore', './rollback.json', '--apply'])).toEqual({
      apply: true, rollbackFile: null, restoreFile: './rollback.json',
    });
  });
});

describe('smsWebhookUrl — must match routes/inbound-sms.ts byte-for-byte (the signature check depends on it)', () => {
  it('is an exact concatenation: no trailing slash added, no query string, no path normalization', () => {
    expect(smsWebhookUrl('https://ctiapi-production.up.railway.app')).toBe(
      'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
    );
  });
});

describe('SELECT_NUMBERS_SQL — every ACTIVE agent/dialer_pool number with a Twilio sid, nothing else (I3: exact, not regex)', () => {
  it('is exactly this, whitespace-normalized', () => {
    expect(norm(SELECT_NUMBERS_SQL)).toBe(
      "select id, e164, twilio_sid, kind from outbound_numbers where active and kind in ('agent', 'dialer_pool') and twilio_sid is not null order by e164",
    );
  });
});

describe('urlHost — the summary groups by host only, never the full URL (a URL can carry a token/path)', () => {
  it('extracts just the host', () => {
    expect(urlHost('https://old-tunnel.ngrok.io/telephony/twilio/sms?secret=abc')).toBe('old-tunnel.ngrok.io');
  });

  it('reports "(none)" for a null/empty URL, "(unparseable)" for garbage', () => {
    expect(urlHost(null)).toBe('(none)');
    expect(urlHost('')).toBe('(none)');
    expect(urlHost('not a url')).toBe('(unparseable)');
  });
});

describe('ignoresSmsUrl — Twilio ignores SmsUrl when an app or Messaging Service sid is set', () => {
  it('true when sms_application_sid is set', () => {
    expect(ignoresSmsUrl({ smsApplicationSid: 'AP123' })).toBe(true);
  });

  it('false when unset, null, or empty', () => {
    expect(ignoresSmsUrl({ smsApplicationSid: null })).toBe(false);
    expect(ignoresSmsUrl({ smsApplicationSid: '' })).toBe(false);
    expect(ignoresSmsUrl({})).toBe(false);
    expect(ignoresSmsUrl(undefined)).toBe(false);
  });
});

describe('safeErrorMessage — never leaks Postgres .detail or the raw error object', () => {
  it('is just the message when there is no code', () => {
    expect(safeErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('appends the code, never .detail', () => {
    const err = new Error('connection refused');
    err.code = 'ECONNREFUSED';
    err.detail = 'some sensitive detail';
    expect(safeErrorMessage(err)).toBe('connection refused (code ECONNREFUSED)');
  });
});

describe('classifyNumbers — already-set / would-change / fetch-failed / not-covered / mismatched', () => {
  const n1 = { id: '1', e164: '+16195550100', twilio_sid: 'PN1', kind: 'agent' };
  const n2 = { id: '2', e164: '+16195550101', twilio_sid: 'PN2', kind: 'dialer_pool' };
  const n3 = { id: '3', e164: '+16195550102', twilio_sid: 'PN3', kind: 'agent' };

  it('a number whose SmsUrl and SmsMethod already match exactly is "already set"', () => {
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: DESIRED, smsMethod: 'POST', phoneNumber: n1.e164 }]]);
    const r = classifyNumbers([n1], configBySid, DESIRED);
    expect(r.alreadySet).toEqual([n1]);
    expect(r.wouldChange).toEqual([]);
  });

  it('SmsMethod is compared case-insensitively', () => {
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: DESIRED, smsMethod: 'Post', phoneNumber: n1.e164 }]]);
    expect(classifyNumbers([n1], configBySid, DESIRED).alreadySet).toEqual([n1]);
  });

  it('a wrong URL, a missing URL, or a non-POST method all count as "would change"', () => {
    const configBySid = new Map([
      [n1.twilio_sid, { smsUrl: 'https://old.example.com/sms', smsMethod: 'POST', phoneNumber: n1.e164 }],
      [n2.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: n2.e164 }],
      [n3.twilio_sid, { smsUrl: DESIRED, smsMethod: 'GET', phoneNumber: n3.e164 }],
    ]);
    const r = classifyNumbers([n1, n2, n3], configBySid, DESIRED);
    expect(r.wouldChange).toEqual([n1, n2, n3]);
    expect(r.alreadySet).toEqual([]);
  });

  it('a number whose Twilio GET failed (no entry in configBySid) is "fetch failed", never guessed into another bucket', () => {
    const configBySid = new Map();
    const r = classifyNumbers([n1], configBySid, DESIRED);
    expect(r.fetchFailed).toEqual([n1]);
    expect(r.alreadySet).toEqual([]);
    expect(r.wouldChange).toEqual([]);
  });

  it('I4: a number with sms_application_sid set is "not covered" — never "already set" or "would change"', () => {
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: DESIRED, smsMethod: 'POST', smsApplicationSid: 'AP123', phoneNumber: n1.e164 }]]);
    const r = classifyNumbers([n1], configBySid, DESIRED);
    expect(r.notCovered).toEqual([n1]);
    expect(r.alreadySet).toEqual([]);
    expect(r.wouldChange).toEqual([]);
  });

  it('I4: a number whose Twilio phone_number does not match our e164 is "mismatched" — never written', () => {
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: '+19995551234' }]]);
    const r = classifyNumbers([n1], configBySid, DESIRED);
    expect(r.mismatched).toEqual([n1]);
    expect(r.wouldChange).toEqual([]);
  });

  it('a mismatch takes priority over a not-covered check (report the more alarming problem)', () => {
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: null, smsMethod: null, smsApplicationSid: 'AP1', phoneNumber: '+19995551234' }]]);
    const r = classifyNumbers([n1], configBySid, DESIRED);
    expect(r.mismatched).toEqual([n1]);
    expect(r.notCovered).toEqual([]);
  });

  it('a mixed batch splits into all five groups independently', () => {
    const configBySid = new Map([
      [n1.twilio_sid, { smsUrl: DESIRED, smsMethod: 'POST', phoneNumber: n1.e164 }],
      [n2.twilio_sid, { smsUrl: 'https://old.example.com', smsMethod: 'POST', phoneNumber: n2.e164 }],
      // n3 missing entirely — fetch failed
    ]);
    const r = classifyNumbers([n1, n2, n3], configBySid, DESIRED);
    expect(r.alreadySet).toEqual([n1]);
    expect(r.wouldChange).toEqual([n2]);
    expect(r.fetchFailed).toEqual([n3]);
  });
});

describe('summarizeHosts — the pre-write summary groups by host only, never the full URL (I4)', () => {
  it('counts current SmsUrl by host, sorted by count desc then host asc', () => {
    const n1 = { twilio_sid: 'PN1' };
    const n2 = { twilio_sid: 'PN2' };
    const n3 = { twilio_sid: 'PN3' };
    const configBySid = new Map([
      [n1.twilio_sid, { smsUrl: 'https://old.example.com/sms?token=abc' }],
      [n2.twilio_sid, { smsUrl: 'https://old.example.com/other' }],
      [n3.twilio_sid, { smsUrl: null }],
    ]);
    expect(summarizeHosts([n1, n2, n3], configBySid)).toEqual([
      ['old.example.com', 2],
      ['(none)', 1],
    ]);
  });

  it('never includes a token or path — only the host, even when the URL has one', () => {
    const n1 = { twilio_sid: 'PN1' };
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: 'https://x.example.com/secret-path?token=super-secret-value' }]]);
    const summary = JSON.stringify(summarizeHosts([n1], configBySid));
    expect(summary).not.toContain('secret-path');
    expect(summary).not.toContain('super-secret-value');
  });
});

describe('defaultRollbackFilePath', () => {
  it('is ./sms-webhooks-rollback-<ISO timestamp, colons replaced>.json', () => {
    expect(defaultRollbackFilePath(new Date('2026-09-25T21:05:00.000Z'))).toBe(
      './sms-webhooks-rollback-2026-09-25T21-05-00.000Z.json',
    );
  });
});

describe('buildRollbackRecords — sid -> previous sms_url/sms_method, for every number about to change', () => {
  it('maps each wouldChange number to its CURRENT (pre-write) Twilio value', () => {
    const n1 = { e164: '+16195550100', twilio_sid: 'PN1' };
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: 'https://old.example.com/sms', smsMethod: 'POST' }]]);
    expect(buildRollbackRecords([n1], configBySid)).toEqual([
      { sid: 'PN1', e164: '+16195550100', previousSmsUrl: 'https://old.example.com/sms', previousSmsMethod: 'POST' },
    ]);
  });

  it('a number with no prior config (null/missing) records nulls, not undefined', () => {
    const n1 = { e164: '+16195550100', twilio_sid: 'PN1' };
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: null, smsMethod: null }]]);
    expect(buildRollbackRecords([n1], configBySid)).toEqual([
      { sid: 'PN1', e164: '+16195550100', previousSmsUrl: null, previousSmsMethod: null },
    ]);
  });
});

describe('buildRollbackFile / validateRollbackFile — the round-trip envelope (review round 2, Important #1)', () => {
  const VALID_SID = 'PN00000000000000000000000000000000';
  const validRecord = { sid: VALID_SID, e164: '+16195550100', previousSmsUrl: 'https://old.example.com/sms', previousSmsMethod: 'POST' };

  it('buildRollbackFile wraps records in {kind, version, records}', () => {
    expect(buildRollbackFile([validRecord])).toEqual({ kind: ROLLBACK_KIND, version: ROLLBACK_VERSION, records: [validRecord] });
  });

  it('validateRollbackFile accepts exactly what buildRollbackFile produces', () => {
    expect(validateRollbackFile(buildRollbackFile([validRecord]))).toEqual({ ok: true, records: [validRecord] });
  });

  it('accepts a record with null previousSmsUrl/previousSmsMethod, and GET as well as POST', () => {
    const file = buildRollbackFile([
      { sid: VALID_SID, e164: '+16195550100', previousSmsUrl: null, previousSmsMethod: null },
      { ...validRecord, previousSmsMethod: 'GET' },
    ]);
    expect(validateRollbackFile(file).ok).toBe(true);
  });

  it('rejects a non-object, an array, and null', () => {
    expect(validateRollbackFile(null).ok).toBe(false);
    expect(validateRollbackFile('a string').ok).toBe(false);
    expect(validateRollbackFile([validRecord]).ok).toBe(false);
    expect(validateRollbackFile(42).ok).toBe(false);
  });

  it('rejects the wrong kind or version', () => {
    expect(validateRollbackFile({ kind: 'wrong', version: 1, records: [] }).ok).toBe(false);
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 999, records: [] }).ok).toBe(false);
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: '1', records: [] }).ok).toBe(false); // string "1" != number 1
  });

  it('rejects records that is missing, null, or not an array', () => {
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1 }).ok).toBe(false);
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: null }).ok).toBe(false);
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: {} }).ok).toBe(false);
  });

  it('rejects a null entry, or any entry missing required fields, inside records', () => {
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: [null] }).ok).toBe(false);
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: [{}] }).ok).toBe(false);
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: [{ sid: VALID_SID }] }).ok).toBe(false);
  });

  it('rejects a sid that is not PN + 32 lowercase hex characters', () => {
    for (const badSid of [
      'PN1', // too short
      'AC00000000000000000000000000000000', // wrong prefix (Account sid, not a Number sid)
      'PN0000000000000000000000000000000G', // 'G' is not hex
      'PN0123456789ABCDEF0123456789ABCDEF', // uppercase hex — Twilio sids are lowercase
    ]) {
      expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: [{ ...validRecord, sid: badSid }] }).ok).toBe(false);
    }
  });

  it('rejects a non-string e164, a non-string/non-null previousSmsUrl, and a previousSmsMethod outside GET/POST/null', () => {
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: [{ ...validRecord, e164: 12345 }] }).ok).toBe(false);
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: [{ ...validRecord, previousSmsUrl: 42 }] }).ok).toBe(false);
    expect(validateRollbackFile({ kind: ROLLBACK_KIND, version: 1, records: [{ ...validRecord, previousSmsMethod: 'PATCH' }] }).ok).toBe(false);
  });

  it('a file shaped like the buy scripts\' fleet-buy.json hand-off is rejected (no kind/version, wrong record shape)', () => {
    // buy-agent-numbers.ts / buy-pool-numbers.mjs write exactly this shape.
    const fleetBuyShaped = [{ e164: '+16195550100', sid: VALID_SID, kind: 'agent', label: 'Agent evren LA', assignEmail: 'evren@gghomessd.com' }];
    expect(validateRollbackFile(fleetBuyShaped).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchTwilioNumber / applyTwilioNumber — the actual Twilio HTTP calls.
// Everywhere else, `run()` is tested through the injected `deps.twilio`
// abstraction, which never exercises these two functions at all — the
// review's own mutation table (S6/S7/S8) found they had NO coverage: a
// mutation dropping `sms_application_sid`/`phone_number` from the GET
// mapping, or adding a field to the POST body, survived every existing test.
// ---------------------------------------------------------------------------

describe('fetchTwilioNumber — the Twilio GET mapping (review round 2, S6/S7)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps every field classifyNumbers/buildRollbackRecords depend on, including sms_application_sid and phone_number', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          sms_url: 'https://old.example.com/sms',
          sms_method: 'POST',
          sms_application_sid: 'AP00000000000000000000000000000000',
          phone_number: '+16195550100',
          // Fields this script must NEVER read or act on:
          voice_url: 'https://old.example.com/voice',
          auth_token: 'should-never-be-touched',
        }),
        { status: 200 },
      );
    }));

    const result = await fetchTwilioNumber('ACtest', 'test-token', 'PN00000000000000000000000000000000');

    expect(result).toEqual({
      smsUrl: 'https://old.example.com/sms',
      smsMethod: 'POST',
      smsApplicationSid: 'AP00000000000000000000000000000000',
      phoneNumber: '+16195550100',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/IncomingPhoneNumbers/PN00000000000000000000000000000000.json');
    expect(calls[0].init?.method).toBeUndefined(); // GET
  });

  it('a missing sms_application_sid or phone_number maps to null, never undefined (classifyNumbers depends on this)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    const result = await fetchTwilioNumber('ACtest', 'test-token', 'PN1');
    expect(result).toEqual({ smsUrl: null, smsMethod: null, smsApplicationSid: null, phoneNumber: null });
  });

  it('a non-2xx response throws with the status, never the full body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 })));
    await expect(fetchTwilioNumber('ACtest', 'test-token', 'PN1')).rejects.toThrow('Twilio GET PN1 -> 404');
  });
});

describe('applyTwilioNumber — the Twilio POST body, exactly (review round 2, S8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends EXACTLY the given fields as a POST, form-encoded, and nothing else', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ sid: 'PN00000000000000000000000000000000' }), { status: 200 });
    }));

    await applyTwilioNumber('ACtest', 'test-token', 'PN00000000000000000000000000000000', { SmsUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/sms', SmsMethod: 'POST' });

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/IncomingPhoneNumbers/PN00000000000000000000000000000000.json');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('ACtest:test-token').toString('base64')}`);
    // Exact body — no VoiceUrl, no extra field, this exact order.
    expect(init.body).toBe('SmsUrl=https%3A%2F%2Fctiapi-production.up.railway.app%2Ftelephony%2Ftwilio%2Fsms&SmsMethod=POST');
  });

  it('a restore call with an empty SmsUrl sends SmsUrl= literally, not "null" or omitted', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ sid: 'PN1' }), { status: 200 });
    }));
    await applyTwilioNumber('ACtest', 'test-token', 'PN1', { SmsUrl: '', SmsMethod: 'POST' });
    expect(calls[0].init.body).toBe('SmsUrl=&SmsMethod=POST');
  });

  it('a non-2xx response throws with only the Twilio error message/code, never the full JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 21211, message: 'Invalid phone number', more_info: 'https://...' }), { status: 400 })));
    await expect(applyTwilioNumber('ACtest', 'test-token', 'PN1', { SmsUrl: 'x', SmsMethod: 'POST' })).rejects.toThrow(
      'Twilio POST PN1 -> 400: Invalid phone number',
    );
  });
});

// ---------------------------------------------------------------------------
// run(argv, deps) — I3 + I4: the whole CLI, deps-injected.
// ---------------------------------------------------------------------------

function fakeTwilio(configBySid, opts = {}) {
  const updateCalls = [];
  const getNumber = vi.fn(async (sid) => {
    const cfg = configBySid.get(sid);
    if (cfg === undefined) throw new Error(`Twilio GET ${sid} -> 500`);
    return cfg;
  });
  const updateNumber = vi.fn(async (sid, fields) => {
    updateCalls.push({ sid, fields });
    if (opts.failSid === sid) throw new Error(`Twilio POST ${sid} -> 500`);
    return { sid };
  });
  return { getNumber, updateNumber, updateCalls };
}

function fakeDb(numbers) {
  return { query: vi.fn(async (_sql) => ({ rows: numbers })) };
}

function outputSink() {
  const lines = [];
  return { stdout: (s) => lines.push(String(s)), stderr: (s) => lines.push(String(s)), lines };
}

function fakeFs(initialFiles = {}) {
  const files = { ...initialFiles };
  const writeFile = vi.fn(async (path, content) => {
    files[path] = content;
  });
  const readFile = vi.fn(async (path) => {
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
    return files[path];
  });
  return { writeFile, readFile, files };
}

const N1 = { id: '1', e164: '+16195550100', twilio_sid: 'PN1', kind: 'agent' };
const N2 = { id: '2', e164: '+16195550101', twilio_sid: 'PN2', kind: 'dialer_pool' };

describe('run — dry run makes ZERO Twilio writes and zero filesystem writes', () => {
  it('a dry run with numbers that would change never calls updateNumber or writeFile', async () => {
    const configBySid = new Map([[N1.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: N1.e164 }]]);
    const twilio = fakeTwilio(configBySid);
    const fs = fakeFs();
    const out = outputSink();
    const result = await run([], { db: fakeDb([N1]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date('2026-09-25T21:05:00Z'), ...fs, ...out });
    expect(result.exitCode).toBe(0);
    expect(twilio.updateNumber).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('--apply actually writes (contrast case, proving the dry-run assertion above is meaningful)', async () => {
    const configBySid = new Map([[N1.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: N1.e164 }]]);
    const twilio = fakeTwilio(configBySid);
    const fs = fakeFs();
    const out = outputSink();
    const result = await run(['--apply'], { db: fakeDb([N1]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date('2026-09-25T21:05:00Z'), ...fs, ...out });
    expect(result.exitCode).toBe(0);
    expect(twilio.updateNumber).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });
});

describe('run — --apply sends EXACTLY SmsUrl=<url>&SmsMethod=POST and nothing else', () => {
  it('the update call carries only SmsUrl and SmsMethod, never VoiceUrl or any Voice* field', async () => {
    const configBySid = new Map([[N1.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: N1.e164 }]]);
    const twilio = fakeTwilio(configBySid);
    const fs = fakeFs();
    await run(['--apply'], { db: fakeDb([N1]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...outputSink() });
    expect(twilio.updateCalls).toEqual([{ sid: 'PN1', fields: { SmsUrl: DESIRED, SmsMethod: 'POST' } }]);
  });
});

describe('run — I4: rollback file is written BEFORE any Twilio write, and records the PREVIOUS value', () => {
  it('writes the rollback file first, then applies — order proven by call sequence', async () => {
    const configBySid = new Map([[N1.twilio_sid, { smsUrl: 'https://old.example.com/sms', smsMethod: 'POST', phoneNumber: N1.e164 }]]);
    const twilio = fakeTwilio(configBySid);
    const fs = fakeFs();
    const order = [];
    fs.writeFile.mockImplementation(async (path, content) => {
      order.push('write-rollback');
      fs.files[path] = content;
    });
    twilio.updateNumber.mockImplementation(async (sid, fields) => {
      order.push('twilio-update');
      twilio.updateCalls.push({ sid, fields });
    });
    await run(['--apply'], { db: fakeDb([N1]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date('2026-09-25T21:05:00Z'), ...fs, ...outputSink() });
    expect(order).toEqual(['write-rollback', 'twilio-update']);
    const [[path, content]] = fs.writeFile.mock.calls;
    expect(path).toBe('./sms-webhooks-rollback-2026-09-25T21-05-00.000Z.json');
    // I2 (2nd review): wrapped in a kind/version envelope, not a bare array —
    // restore refuses anything else (see the "run --restore" describe block).
    expect(JSON.parse(content)).toEqual({
      kind: 'sms-webhooks-rollback',
      version: 1,
      records: [{ sid: 'PN1', e164: '+16195550100', previousSmsUrl: 'https://old.example.com/sms', previousSmsMethod: 'POST' }],
    });
  });

  it('--rollback-file overrides the default path', async () => {
    const configBySid = new Map([[N1.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: N1.e164 }]]);
    const twilio = fakeTwilio(configBySid);
    const fs = fakeFs();
    await run(['--apply', '--rollback-file', './custom.json'], {
      db: fakeDb([N1]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...outputSink(),
    });
    expect(fs.writeFile.mock.calls[0][0]).toBe('./custom.json');
  });

  // Review round 2, S3: an unwritable rollback file must abort the whole run
  // — the rollback file is the ONLY record of what --apply is about to
  // overwrite, so writing it is a precondition for any Twilio write at all.
  it('an unwritable rollback file aborts with 0 Twilio POSTs, exit 1, never throwing out of run()', async () => {
    const configBySid = new Map([[N1.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: N1.e164 }]]);
    const twilio = fakeTwilio(configBySid);
    const fs = fakeFs();
    const err = new Error('ENOENT: no such file or directory, open');
    err.code = 'ENOENT';
    fs.writeFile.mockRejectedValue(err);
    const out = outputSink();
    const result = await run(['--apply'], { db: fakeDb([N1]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...out });
    expect(result.exitCode).toBe(1);
    expect(twilio.updateNumber).not.toHaveBeenCalled();
    expect(out.lines.join('\n')).toContain('ENOENT');
  });
});

describe('run — I4: sms_application_sid numbers are skipped and reported as "not covered"', () => {
  it('never writes a number whose sms_application_sid is set', async () => {
    const configBySid = new Map([[N1.twilio_sid, { smsUrl: null, smsMethod: null, smsApplicationSid: 'AP123', phoneNumber: N1.e164 }]]);
    const twilio = fakeTwilio(configBySid);
    const out = outputSink();
    await run(['--apply'], { db: fakeDb([N1]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fakeFs(), ...out });
    expect(twilio.updateNumber).not.toHaveBeenCalled();
    expect(out.lines.join('\n')).toContain('not covered');
    expect(out.lines.join('\n')).toContain('+16195550100');
  });
});

describe('run — I4: a Twilio phone_number mismatch is skipped and reported', () => {
  it('never writes a number whose Twilio phone_number does not match our e164', async () => {
    const configBySid = new Map([[N1.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: '+19995551234' }]]);
    const twilio = fakeTwilio(configBySid);
    const out = outputSink();
    await run(['--apply'], { db: fakeDb([N1]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fakeFs(), ...out });
    expect(twilio.updateNumber).not.toHaveBeenCalled();
    expect(out.lines.join('\n')).toMatch(/mismatch/i);
  });
});

describe('run — refuses a trailing slash on API_PUBLIC_URL, with a clear message, before touching anything', () => {
  it('never queries the db or Twilio', async () => {
    const twilio = fakeTwilio(new Map());
    const db = fakeDb([]);
    const out = outputSink();
    const result = await run([], { db, twilio, apiPublicUrl: 'https://ctiapi-production.up.railway.app/', now: () => new Date(), ...fakeFs(), ...out });
    expect(result.exitCode).toBe(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(twilio.getNumber).not.toHaveBeenCalled();
    expect(out.lines.join('\n')).toContain('API_PUBLIC_URL');
    expect(out.lines.join('\n')).toMatch(/trailing slash|must not end/i);
  });
});

describe('run — per-number Twilio errors never abort the run, and never print the full response', () => {
  it('one failing update is reported and counted; the others still apply', async () => {
    const configBySid = new Map([
      [N1.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: N1.e164 }],
      [N2.twilio_sid, { smsUrl: null, smsMethod: null, phoneNumber: N2.e164 }],
    ]);
    const twilio = fakeTwilio(configBySid, { failSid: 'PN1' });
    const out = outputSink();
    const result = await run(['--apply'], { db: fakeDb([N1, N2]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fakeFs(), ...out });
    expect(result.exitCode).toBe(1);
    expect(twilio.updateNumber).toHaveBeenCalledTimes(2);
    expect(out.lines.join('\n')).toContain('Updated 1/2');
  });

  it('err.message/.code only — never the whole error object or a Postgres .detail', async () => {
    const err = new Error('unique constraint violated');
    err.code = '23505';
    err.detail = 'a secret detail that must never print';
    const db = { query: vi.fn(async () => { throw err; }) };
    const out = outputSink();
    const result = await run([], { db, twilio: fakeTwilio(new Map()), apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fakeFs(), ...out });
    expect(result.exitCode).toBe(1);
    const joined = out.lines.join('\n');
    expect(joined).toContain('unique constraint violated');
    expect(joined).toContain('23505');
    expect(joined).not.toContain('a secret detail');
  });
});

describe('run --restore — dry run by default, writes only with --apply', () => {
  const rollbackFile = './rollback.json';
  const VALID_SID = 'PN00000000000000000000000000000000';
  const VALID_SID_2 = 'PN00000000000000000000000000000001';
  const validFile = () => ({
    kind: 'sms-webhooks-rollback',
    version: 1,
    records: [{ sid: VALID_SID, e164: '+16195550100', previousSmsUrl: 'https://old.example.com/sms', previousSmsMethod: 'POST' }],
  });

  it('--restore alone (no --apply) makes zero Twilio writes', async () => {
    const twilio = fakeTwilio(new Map());
    const fs = fakeFs({ [rollbackFile]: JSON.stringify(validFile()) });
    const out = outputSink();
    const result = await run(['--restore', rollbackFile], { db: fakeDb([]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...out });
    expect(result.exitCode).toBe(0);
    expect(twilio.updateNumber).not.toHaveBeenCalled();
    expect(out.lines.join('\n')).toContain('DRY RUN');
  });

  it('--restore --apply writes back the EXACT previous values from the file (a valid file restores)', async () => {
    const twilio = fakeTwilio(new Map());
    const fs = fakeFs({ [rollbackFile]: JSON.stringify(validFile()) });
    const out = outputSink();
    const result = await run(['--restore', rollbackFile, '--apply'], { db: fakeDb([]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...out });
    expect(result.exitCode).toBe(0);
    expect(twilio.updateCalls).toEqual([
      { sid: VALID_SID, fields: { SmsUrl: 'https://old.example.com/sms', SmsMethod: 'POST' } },
    ]);
  });

  it('restore never touches the database', async () => {
    const db = fakeDb([]);
    const twilio = fakeTwilio(new Map());
    const fs = fakeFs({ [rollbackFile]: JSON.stringify(validFile()) });
    await run(['--restore', rollbackFile, '--apply'], { db, twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...outputSink() });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('a missing restore file is reported clearly and exits 1, never throwing', async () => {
    const fs = fakeFs({});
    const out = outputSink();
    const result = await run(['--restore', './does-not-exist.json'], { db: fakeDb([]), twilio: fakeTwilio(new Map()), apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...out });
    expect(result.exitCode).toBe(1);
    expect(out.lines.join('\n')).toContain('does-not-exist.json');
  });

  // Review round 2, Important #1: --restore must refuse a malformed file —
  // it used to check only "is this valid JSON" and "is it an array", so a
  // completely wrong file could blank an SmsUrl or crash mid-run.
  describe('malformed files are refused — exit 1, before any Twilio write, with a clear reason', () => {
    async function expectRefused(fileContents) {
      const twilio = fakeTwilio(new Map());
      const fs = fakeFs({ [rollbackFile]: typeof fileContents === 'string' ? fileContents : JSON.stringify(fileContents) });
      const out = outputSink();
      const result = await run(['--restore', rollbackFile, '--apply'], {
        db: fakeDb([]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...out,
      });
      expect(result.exitCode).toBe(1);
      expect(twilio.updateNumber).not.toHaveBeenCalled();
      return out;
    }

    it('a file shaped like fleet-buy.json (the BUY hand-off format, not a rollback file) is refused', async () => {
      // The exact shape buy-agent-numbers.ts / buy-pool-numbers.mjs write: a
      // bare array of {e164, sid, kind, label, assignEmail}, no kind/version
      // envelope at all — this is the review's own reproduction.
      const out = await expectRefused([
        { e164: '+16195550100', sid: VALID_SID, kind: 'agent', label: 'Agent evren LA', assignEmail: 'evren@gghomessd.com' },
      ]);
      expect(out.lines.join('\n')).toMatch(/not a valid rollback file|kind|version/i);
    });

    it('a bare array with no envelope at all is refused, even if shaped like valid records', async () => {
      const out = await expectRefused([{ sid: VALID_SID, e164: '+16195550100', previousSmsUrl: null, previousSmsMethod: null }]);
      expect(out.lines.join('\n')).toMatch(/not a valid rollback file/i);
    });

    it('wrong kind is refused', async () => {
      await expectRefused({ kind: 'something-else', version: 1, records: [] });
    });

    it('wrong version is refused', async () => {
      await expectRefused({ kind: 'sms-webhooks-rollback', version: 2, records: [] });
    });

    it('records is not an array (a single object) is refused', async () => {
      const out = await expectRefused({
        kind: 'sms-webhooks-rollback', version: 1,
        records: { sid: VALID_SID, e164: '+16195550100', previousSmsUrl: null, previousSmsMethod: null },
      });
      expect(out.lines.join('\n')).toMatch(/records/i);
    });

    it('a null entry among the records is refused', async () => {
      await expectRefused({ kind: 'sms-webhooks-rollback', version: 1, records: [null] });
    });

    it('a record with a malformed sid (not PN + 32 hex) is refused', async () => {
      await expectRefused({
        kind: 'sms-webhooks-rollback', version: 1,
        records: [{ sid: 'not-a-real-sid', e164: '+16195550100', previousSmsUrl: null, previousSmsMethod: null }],
      });
    });

    it('a record whose e164 is not a string is refused', async () => {
      await expectRefused({
        kind: 'sms-webhooks-rollback', version: 1,
        records: [{ sid: VALID_SID, e164: 16195550100, previousSmsUrl: null, previousSmsMethod: null }],
      });
    });

    it('a record whose previousSmsUrl is neither a string nor null is refused', async () => {
      await expectRefused({
        kind: 'sms-webhooks-rollback', version: 1,
        records: [{ sid: VALID_SID, e164: '+16195550100', previousSmsUrl: 12345, previousSmsMethod: null }],
      });
    });

    it('a record whose previousSmsMethod is not GET/POST/null is refused', async () => {
      await expectRefused({
        kind: 'sms-webhooks-rollback', version: 1,
        records: [{ sid: VALID_SID, e164: '+16195550100', previousSmsUrl: null, previousSmsMethod: 'PATCH' }],
      });
    });

    it('previousSmsMethod of GET is accepted (not just POST) — a valid file with two records restores both', async () => {
      const fs = fakeFs({
        [rollbackFile]: JSON.stringify({
          kind: 'sms-webhooks-rollback', version: 1,
          records: [
            { sid: VALID_SID, e164: '+16195550100', previousSmsUrl: 'https://old.example.com/a', previousSmsMethod: 'POST' },
            { sid: VALID_SID_2, e164: '+16195550101', previousSmsUrl: 'https://old.example.com/b', previousSmsMethod: 'GET' },
          ],
        }),
      });
      const twilio = fakeTwilio(new Map());
      const result = await run(['--restore', rollbackFile, '--apply'], {
        db: fakeDb([]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...outputSink(),
      });
      expect(result.exitCode).toBe(0);
      expect(twilio.updateCalls).toEqual([
        { sid: VALID_SID, fields: { SmsUrl: 'https://old.example.com/a', SmsMethod: 'POST' } },
        { sid: VALID_SID_2, fields: { SmsUrl: 'https://old.example.com/b', SmsMethod: 'GET' } },
      ]);
    });
  });

  // Review round 2, S10: a null previousSmsUrl restores as an EMPTY SmsUrl,
  // never the literal string "null" (which is what `${null}` would produce).
  it('a null previousSmsUrl restores as an empty SmsUrl, not the string "null"', async () => {
    const fs = fakeFs({
      [rollbackFile]: JSON.stringify({
        kind: 'sms-webhooks-rollback', version: 1,
        records: [{ sid: VALID_SID, e164: '+16195550100', previousSmsUrl: null, previousSmsMethod: null }],
      }),
    });
    const twilio = fakeTwilio(new Map());
    await run(['--restore', rollbackFile, '--apply'], {
      db: fakeDb([]), twilio, apiPublicUrl: API_PUBLIC_URL, now: () => new Date(), ...fs, ...outputSink(),
    });
    expect(twilio.updateCalls).toEqual([{ sid: VALID_SID, fields: { SmsUrl: '', SmsMethod: 'POST' } }]);
    expect(twilio.updateCalls[0].fields.SmsUrl).not.toBe('null');
  });
});
