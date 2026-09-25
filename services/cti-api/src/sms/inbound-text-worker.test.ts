import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema, type InboundMessage } from '@cti/db';
import { SalesforceUnauthorizedError } from '../salesforce/client.js';
import {
  BATCH_LIMIT,
  RETRY_DELAYS_MS,
  SF_CALL_TIMEOUT_MS,
  SF_CREATE_TIMEOUT_MS,
  STUCK_AFTER_MS,
  claimInboundText,
  processInboundText,
  reapStuckInboundTexts,
  runInboundTextTick,
  selectDueInboundTexts,
  type InboundTextDeps,
} from './inbound-text-worker.js';

const NOW = new Date('2026-09-25T21:05:00Z');
const BODY = 'Is the house on Elm still available? gate code 4471';
const LEAD = '00Q000000000001AAA';
const CONTACT = '003000000000001AAA';
const ACCOUNT = '001000000000001AAA';
const DEAL = 'a0X000000000001AAA';
const EMAIL_OK = { status: 200, json: [{ actionName: 'emailSimple', errors: null, isSuccess: true, outputValues: null }] };

function row(o: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'row-1',
    orgId: 'org-1',
    messageSid: 'SM0123456789abcdef0123456789abcdef',
    fromE164: '+16195550100',
    toE164: '+18585550199',
    body: BODY,
    numMedia: 0,
    userId: 'rep-1',
    status: 'in_flight',
    attempts: 1,
    nextAttemptAt: NOW,
    lastError: null,
    sfTaskId: null,
    emailedAt: null,
    backfill: false,
    // 05:00 UTC on the 26th is still the 25th in Los Angeles.
    receivedAt: new Date('2026-09-26T05:00:00Z'),
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

type Patch = Record<string, unknown>;

/** Records every DB write and every Salesforce call into one ordered log. */
function harness(over: Partial<InboundTextDeps> = {}) {
  const order: string[] = [];
  const writes: Patch[] = [];
  const db = {
    update: (_t: unknown) => ({
      set: (patch: Patch) => ({
        where: async () => {
          writes.push(patch);
          order.push(`write:${Object.keys(patch).filter((k) => k !== 'updatedAt').sort().join(',')}`);
        },
      }),
    }),
  } as unknown as InboundTextDeps['db'];
  const sfFetch = vi.fn(async (_u: string, path: string, _init?: { method?: string; body?: unknown }) => {
    order.push(`sf:${path}`);
    return path === '/sobjects/Task' ? { status: 201, json: { id: '00TNEW000000001', success: true } } : EMAIL_OK;
  });
  const deps: InboundTextDeps = {
    db,
    sf: {
      findByPhone: vi.fn(async () => {
        order.push('sf:findByPhone');
        return { whoId: LEAD, name: 'Jane Doe' };
      }),
      salesforceUserId: vi.fn(async () => {
        order.push('sf:me');
        return '005REP000000001';
      }),
      soqlQuery: vi.fn(async () => {
        order.push('sf:soql');
        return [{ Email: 'garrett@gghomes.org' }];
      }) as unknown as InboundTextDeps['sf']['soqlQuery'],
      sfFetch: sfFetch as unknown as InboundTextDeps['sf']['sfFetch'],
    },
    instanceUrlFor: vi.fn(async () => 'https://gghomes.my.salesforce.com'),
    now: () => NOW,
    ...over,
  };
  const calls = (path: string) =>
    (deps.sf.sfFetch as unknown as typeof sfFetch).mock.calls.filter(([, p]) => p === path);
  return { deps, writes, order, calls };
}

function taskBodies(h: ReturnType<typeof harness>): Array<Record<string, unknown>> {
  return h.calls('/sobjects/Task').map(([, , init]) => init!.body as Record<string, unknown>);
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('processInboundText — the Salesforce Task', () => {
  it('creates the Task with NO Status (org default Open), the rep as Owner, Priority Normal, the Lead as Who', async () => {
    const h = harness();
    await processInboundText(row(), h.deps);
    const [task] = taskBodies(h);
    expect(task).toEqual({
      Subject: 'Text from Jane Doe',
      Description: BODY,
      ActivityDate: '2026-09-25',
      OwnerId: '005REP000000001',
      Priority: 'Normal',
      WhoId: LEAD,
    });
    // The 2026-09-23 lesson: a hard-coded Status hid 203 tasks from reps' views.
    expect(task).not.toHaveProperty('Status');
    // No picklist value exists for texts; the marker would be rejected.
    expect(task).not.toHaveProperty('CTI_Origin__c');
    expect(h.calls('/sobjects/Task')[0]![0]).toBe('rep-1');
  });

  it('a Contact is the Who and its Account the What; a Deal__c is the What only', async () => {
    const contact = harness();
    (contact.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ whoId: CONTACT, whatId: ACCOUNT, name: 'Ann' });
    await processInboundText(row(), contact.deps);
    expect(taskBodies(contact)[0]).toMatchObject({ WhoId: CONTACT, WhatId: ACCOUNT });

    const deal = harness();
    (deal.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ whatId: DEAL, name: '12 Elm St' });
    await processInboundText(row(), deal.deps);
    expect(taskBodies(deal)[0]).toMatchObject({ WhatId: DEAL, Subject: 'Text from 12 Elm St' });
    expect(taskBodies(deal)[0]).not.toHaveProperty('WhoId');
  });

  it('never puts an Account in WhoId', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ whoId: ACCOUNT, name: 'Acme' });
    await processInboundText(row(), h.deps);
    expect(taskBodies(h)[0]).toMatchObject({ WhatId: ACCOUNT });
    expect(taskBodies(h)[0]).not.toHaveProperty('WhoId');
  });

  it('no match → an unlinked Task titled with the formatted number', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await processInboundText(row(), h.deps);
    const [task] = taskBodies(h);
    expect(task!.Subject).toBe('Text from (619) 555-0100');
    expect(task).not.toHaveProperty('WhoId');
    expect(task).not.toHaveProperty('WhatId');
  });

  it('a failed sender match is logged and the Task is still created, unlinked', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SOSL 503'));
    await processInboundText(row(), h.deps);
    expect(taskBodies(h)[0]).not.toHaveProperty('WhoId');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sender match failed'), expect.objectContaining({ rowId: 'row-1' }));
    expect(h.writes.at(-1)).toMatchObject({ status: 'done' });
  });

  it('an opt-out text says "asked to STOP" on the Task', async () => {
    const h = harness();
    await processInboundText(row({ body: ' stop ' }), h.deps);
    expect(taskBodies(h)[0]!.Subject).toBe('Text from Jane Doe — asked to STOP');
  });

  it('notes attachments in the Description', async () => {
    const h = harness();
    await processInboundText(row({ body: 'photo', numMedia: 2 }), h.deps);
    expect(taskBodies(h)[0]!.Description).toBe('photo\n\n(2 attachments — open Twilio to view)');
  });

  it('INVALID_FIELD on a linked Task → retried ONCE without WhoId/WhatId, and logged', async () => {
    const h = harness();
    let n = 0;
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) => {
      if (path !== '/sobjects/Task') return EMAIL_OK;
      n++;
      return n === 1
        ? { status: 400, json: [{ errorCode: 'INVALID_FIELD', message: 'No such column WhoId' }] }
        : { status: 201, json: { id: '00TNEW000000002', success: true } };
    });
    await processInboundText(row(), h.deps);
    const bodies = taskBodies(h);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('WhoId', LEAD);
    expect(bodies[1]).not.toHaveProperty('WhoId');
    expect(bodies[1]).not.toHaveProperty('WhatId');
    expect(bodies[1]).toMatchObject({ Subject: 'Text from Jane Doe', OwnerId: '005REP000000001' });
    expect(h.writes).toContainEqual(expect.objectContaining({ sfTaskId: '00TNEW000000002' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without WhoId/WhatId'), expect.objectContaining({ rowId: 'row-1' }));
  });

  it('a Salesforce rejection of the LINK (converted lead, bad cross-reference) also falls back to unlinked', async () => {
    for (const errorCode of ['CANNOT_UPDATE_CONVERTED_LEAD', 'INVALID_CROSS_REFERENCE_KEY', 'FIELD_INTEGRITY_EXCEPTION']) {
      const h = harness();
      let n = 0;
      (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) => {
        if (path !== '/sobjects/Task') return EMAIL_OK;
        n++;
        return n === 1 ? { status: 400, json: [{ errorCode }] } : { status: 201, json: { id: '00TNEW000000003' } };
      });
      await processInboundText(row(), h.deps);
      expect(taskBodies(h)).toHaveLength(2);
      expect(h.writes.at(-1)).toMatchObject({ status: 'done' });
    }
  });

  it('INVALID_FIELD on an UNLINKED Task is not retried (nothing to drop) — it backs off', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      status: 400,
      json: [{ errorCode: 'INVALID_FIELD', message: 'Priority' }],
    }));
    await processInboundText(row(), h.deps);
    expect(taskBodies(h)).toHaveLength(1);
    expect(h.writes.at(-1)).toMatchObject({ status: 'pending' });
  });
});

describe('processInboundText — the email alert', () => {
  it('sends emailSimple AS THE REP to their own Salesforce User.Email, plain text, with the record link', async () => {
    const h = harness();
    await processInboundText(row(), h.deps);
    expect(h.deps.sf.soqlQuery).toHaveBeenCalledWith('rep-1', "SELECT Email FROM User WHERE Id = '005REP000000001' LIMIT 1");
    const emails = h.calls('/actions/standard/emailSimple');
    expect(emails).toHaveLength(1);
    const [userId, path, init] = emails[0]!;
    expect(userId).toBe('rep-1');
    expect(path).toBe('/actions/standard/emailSimple');
    expect(init!.method).toBe('POST');
    expect(init!.body).toEqual({
      inputs: [
        {
          emailAddresses: 'garrett@gghomes.org',
          emailSubject: 'New text from Jane Doe',
          emailBody: [
            'From: Jane Doe (619) 555-0100',
            'To your number: (858) 555-0199',
            'Received: Fri, Sep 25, 2026, 10:00 PM PDT',
            '',
            BODY,
            '',
            `Open in Salesforce: https://gghomes.my.salesforce.com/lightning/r/${LEAD}/view`,
          ].join('\n'),
          senderType: 'CurrentUser',
        },
      ],
    });
  });

  it('links to the Task when the sender matched nothing', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await processInboundText(row(), h.deps);
    const body = (h.calls('/actions/standard/emailSimple')[0]![2]!.body as { inputs: Array<{ emailBody: string }> }).inputs[0]!.emailBody;
    expect(body).toContain('https://gghomes.my.salesforce.com/lightning/r/00TNEW000000001/view');
  });

  it('carries the STOP suffix on the subject for an opt-out', async () => {
    const h = harness();
    await processInboundText(row({ body: 'QUIT' }), h.deps);
    const input = (h.calls('/actions/standard/emailSimple')[0]![2]!.body as { inputs: Array<{ emailSubject: string }> }).inputs[0]!;
    expect(input.emailSubject).toBe('New text from Jane Doe — asked to STOP');
  });

  it('stamps sf_task_id BEFORE emailing and emailed_at right after, then marks done', async () => {
    const h = harness();
    await processInboundText(row(), h.deps);
    expect(h.order).toEqual([
      'sf:findByPhone',
      'sf:me',
      'sf:/sobjects/Task',
      'write:sfTaskId',
      'sf:soql',
      'sf:/actions/standard/emailSimple',
      'write:emailedAt',
      'write:lastError,status',
    ]);
    expect(h.writes).toContainEqual(expect.objectContaining({ emailedAt: NOW }));
    expect(h.writes.at(-1)).toEqual(expect.objectContaining({ status: 'done', lastError: null }));
  });

  it('an emailSimple answer of isSuccess:false is a failure (not stamped), and backs off', async () => {
    const h = harness();
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) =>
      path === '/sobjects/Task'
        ? { status: 201, json: { id: '00TNEW000000001' } }
        : { status: 200, json: [{ isSuccess: false, errors: [{ statusCode: 'NO_MASS_MAIL_PERMISSION', message: 'no' }] }] },
    );
    await processInboundText(row(), h.deps);
    expect(h.writes.some((w) => 'emailedAt' in w)).toBe(false);
    expect(h.writes).toContainEqual(expect.objectContaining({ sfTaskId: '00TNEW000000001' }));
    expect(h.writes.at(-1)).toMatchObject({ status: 'pending', lastError: expect.stringContaining('NO_MASS_MAIL_PERMISSION') });
  });
});

describe('processInboundText — once-only guards', () => {
  it('a row that already has its Task never creates a second one — it only emails', async () => {
    const h = harness();
    await processInboundText(row({ sfTaskId: '00TOLD000000001' }), h.deps);
    expect(h.calls('/sobjects/Task')).toHaveLength(0);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(1);
    expect(h.writes.some((w) => 'sfTaskId' in w)).toBe(false);
    expect(h.writes.at(-1)).toMatchObject({ status: 'done' });
  });

  it('a row already emailed never emails again — it only creates the Task', async () => {
    const h = harness();
    await processInboundText(row({ emailedAt: new Date('2026-09-25T21:06:00Z') }), h.deps);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(h.deps.sf.soqlQuery).not.toHaveBeenCalled();
    expect(h.calls('/sobjects/Task')).toHaveLength(1);
    expect(h.writes.at(-1)).toMatchObject({ status: 'done' });
  });

  it('a row with both steps done (crash before the final write) touches Salesforce not at all', async () => {
    const h = harness();
    await processInboundText(row({ sfTaskId: '00TOLD000000001', emailedAt: NOW }), h.deps);
    expect(h.order).toEqual(['write:lastError,status']);
  });

  it('a BACKFILL row gets its Task but never an individual email (the digest covers it)', async () => {
    const h = harness();
    await processInboundText(row({ backfill: true }), h.deps);
    expect(h.calls('/sobjects/Task')).toHaveLength(1);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(h.deps.sf.soqlQuery).not.toHaveBeenCalled();
    expect(h.writes.some((w) => 'emailedAt' in w)).toBe(false);
    expect(h.writes.at(-1)).toMatchObject({ status: 'done' });
  });

  it('a retry after the email failed creates no second Task', async () => {
    const h = harness();
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) =>
      path === '/sobjects/Task' ? { status: 201, json: { id: '00TNEW000000001' } } : { status: 503, json: { message: 'busy' } },
    );
    await processInboundText(row(), h.deps);
    const stamped = h.writes.find((w) => 'sfTaskId' in w)!.sfTaskId as string;
    // The tick re-reads the row, so the retry sees the stamp.
    const retry = harness();
    await processInboundText(row({ attempts: 2, sfTaskId: stamped }), retry.deps);
    expect(retry.calls('/sobjects/Task')).toHaveLength(0);
    expect(retry.calls('/actions/standard/emailSimple')).toHaveLength(1);
  });

  it('a row that lost its rep (user deleted) is skipped, not retried', async () => {
    const h = harness();
    await processInboundText(row({ userId: null }), h.deps);
    expect(h.order).toEqual(['write:lastError,status']);
    expect(h.writes[0]).toMatchObject({ status: 'skipped' });
  });
});

describe('processInboundText — failures', () => {
  it('a Salesforce auth failure is terminal: failed, "reconnect Salesforce", no retry scheduled', async () => {
    const h = harness();
    (h.deps.sf.salesforceUserId as ReturnType<typeof vi.fn>).mockRejectedValue(new SalesforceUnauthorizedError());
    await processInboundText(row(), h.deps);
    expect(h.writes.at(-1)).toEqual({ status: 'failed', lastError: 'reconnect Salesforce', updatedAt: NOW });
    expect(h.calls('/sobjects/Task')).toHaveLength(0);
  });

  it('a 401 from the create (refresh failed) is terminal too', async () => {
    const h = harness();
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      status: 401,
      json: [{ errorCode: 'INVALID_SESSION_ID' }],
    }));
    await processInboundText(row({ attempts: 1 }), h.deps);
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed', lastError: 'reconnect Salesforce' });
  });

  it('any other failure backs off 30 s, 2 min, 10 min — then fails', async () => {
    expect([...RETRY_DELAYS_MS]).toEqual([30_000, 120_000, 600_000]);
    const outcomes: Patch[] = [];
    for (const attempts of [1, 2, 3, 4]) {
      const h = harness();
      (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ status: 503, json: { message: 'busy' } }));
      await processInboundText(row({ attempts }), h.deps);
      outcomes.push(h.writes.at(-1)!);
    }
    expect(outcomes[0]).toMatchObject({ status: 'pending', nextAttemptAt: new Date(NOW.getTime() + 30_000) });
    expect(outcomes[1]).toMatchObject({ status: 'pending', nextAttemptAt: new Date(NOW.getTime() + 120_000) });
    expect(outcomes[2]).toMatchObject({ status: 'pending', nextAttemptAt: new Date(NOW.getTime() + 600_000) });
    expect(outcomes[3]).toMatchObject({ status: 'failed', lastError: expect.stringContaining('503') });
    expect(outcomes[3]).not.toHaveProperty('nextAttemptAt');
  });

  it('a hung Salesforce call times out instead of pinning the tick', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      (h.deps.sf.salesforceUserId as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
      const done = processInboundText(row(), h.deps);
      await vi.advanceTimersByTimeAsync(SF_CALL_TIMEOUT_MS + 1);
      await done;
      expect(h.writes.at(-1)).toMatchObject({ status: 'pending', lastError: expect.stringContaining('timed out') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never writes the message body to the log, even when Salesforce echoes it back', async () => {
    const h = harness();
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      status: 400,
      json: [{ errorCode: 'STRING_TOO_LONG', message: `Description: data value too large: ${BODY}` }],
    }));
    await processInboundText(row({ attempts: 4 }), h.deps);
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(error).toHaveBeenCalled();
    expect(logged).not.toContain(BODY);
  });
});

describe('the reaper budget', () => {
  it('only presumes a row dead after every Salesforce call it can make has timed out', () => {
    // findByPhone + salesforceUserId + the User.Email read, and the two mutating calls.
    expect(STUCK_AFTER_MS).toBeGreaterThanOrEqual(SF_CALL_TIMEOUT_MS * 3 + SF_CREATE_TIMEOUT_MS * 2);
  });
});

describe('runInboundTextTick', () => {
  /** A fake handle for the tick: reaper + claim are `update`s (the claim awaits
   *  `.returning()`), the scan is a `select`. Every write lands in `writes`;
   *  `failWrite` makes a processing write (never the claim) reject. */
  function tickDb(due: InboundMessage[], claim: () => InboundMessage | null, failWrite: () => boolean = () => false) {
    const writes: Array<{ patch: Patch }> = [];
    const db = {
      update: (_t: unknown) => ({
        set: (patch: Patch) => ({
          where: (_w: unknown) => {
            writes.push({ patch });
            const fail = patch.status !== 'in_flight' && failWrite();
            const done = (fail ? Promise.reject(new Error('db write exploded')) : Promise.resolve([])) as Promise<unknown> & {
              returning: () => Promise<InboundMessage[]>;
            };
            done.catch(() => {}); // awaited by the caller; this only silences the unhandled-rejection probe
            done.returning = async () => {
              const r = claim();
              return r ? [r] : [];
            };
            return done;
          },
        }),
      }),
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => due }) }) }) }),
    };
    return { writes, db: db as unknown as InboundTextDeps['db'] };
  }

  it('reaps stuck rows, then skips a row whose conditional claim lost to another replica', async () => {
    const t = tickDb([row({ status: 'pending', attempts: 0 })], () => null);
    const h = harness({ db: t.db });
    const out = await runInboundTextTick(h.deps);
    expect(out.processed).toBe(0);
    expect(t.writes[0]!.patch).toMatchObject({ status: 'pending' }); // the reaper
    expect(h.deps.sf.findByPhone).not.toHaveBeenCalled();
    expect(h.calls('/sobjects/Task')).toHaveLength(0);
  });

  it('processes the row AS CLAIMED (fresh stamps, bumped attempts), stamping the claim with a fresh clock', async () => {
    let t0 = NOW.getTime();
    const claimed = row({ status: 'in_flight', attempts: 2, sfTaskId: '00TOLD000000001' });
    const t = tickDb([row({ status: 'pending', attempts: 1 })], () => claimed);
    const h = harness({ db: t.db, now: () => new Date((t0 += 1_000)) });
    const out = await runInboundTextTick(h.deps);
    expect(out.processed).toBe(1);
    // The claimed row already has its Task: only the email goes out.
    expect(h.calls('/sobjects/Task')).toHaveLength(0);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(1);
    const claimWrite = t.writes.find((w) => w.patch.status === 'in_flight')!;
    const reapWrite = t.writes[0]!;
    expect((claimWrite.patch.updatedAt as Date).getTime()).toBeGreaterThan((reapWrite.patch.updatedAt as Date).getTime());
  });

  it('keeps draining the batch when one row throws out of processing', async () => {
    const rows = [row({ id: 'row-1', status: 'pending' }), row({ id: 'row-2', status: 'pending' })];
    let n = 0;
    let current: InboundMessage | null = null;
    // row-1's writes explode (the DB went away mid-row) — including the backoff
    // write in its catch — so the throw escapes processInboundText. row-2 must still run.
    const t = tickDb(
      rows,
      () => (current = rows[n++] ?? null),
      () => current?.id === 'row-1',
    );
    const h = harness({ db: t.db });
    const out = await runInboundTextTick(h.deps);
    expect(out.processed).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('row crashed'), expect.objectContaining({ rowId: 'row-1' }));
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(1); // row-2 went all the way through
    expect(t.writes.at(-1)!.patch).toMatchObject({ status: 'done' });
  });
});

describe('the worker SQL, rendered', () => {
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('the claim is a compare-and-swap pending → in_flight that bumps attempts and stamps updated_at', () => {
    const { sql, params } = claimInboundText(db, 'row-1', NOW).toSQL();
    expect(sql).toBe(
      'update "inbound_messages" set "status" = $1, "attempts" = "inbound_messages"."attempts" + 1, "updated_at" = $2 ' +
        'where ("inbound_messages"."id" = $3 and "inbound_messages"."status" = $4) returning ' +
        '"id", "org_id", "message_sid", "from_e164", "to_e164", "body", "num_media", "user_id", "status", "attempts", ' +
        '"next_attempt_at", "last_error", "sf_task_id", "emailed_at", "backfill", "received_at", "created_at", "updated_at"',
    );
    expect(params).toEqual(['in_flight', NOW.toISOString(), 'row-1', 'pending']);
  });

  it('the scan takes due pending rows, oldest first, a bounded batch', () => {
    const { sql, params } = selectDueInboundTexts(db, NOW).toSQL();
    expect(sql).toMatch(
      /from "inbound_messages" where \("inbound_messages"\."status" = \$1 and "inbound_messages"\."next_attempt_at" <= \$2\) order by "inbound_messages"\."created_at" asc limit \$3$/,
    );
    expect(params).toEqual(['pending', NOW.toISOString(), BATCH_LIMIT]);
  });

  it('the reaper returns only in_flight rows untouched for longer than the worst case', () => {
    const { sql, params } = reapStuckInboundTexts(db, NOW).toSQL();
    expect(sql).toBe(
      'update "inbound_messages" set "status" = $1, "updated_at" = $2 ' +
        'where ("inbound_messages"."status" = $3 and "inbound_messages"."updated_at" <= $4)',
    );
    expect(params).toEqual(['pending', NOW.toISOString(), 'in_flight', new Date(NOW.getTime() - STUCK_AFTER_MS).toISOString()]);
  });
});
