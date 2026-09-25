import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema, type InboundMessage } from '@cti/db';
import { SalesforceUnauthorizedError } from '../salesforce/client.js';
import {
  BATCH_LIMIT,
  EMAIL_WINDOW_MS,
  LOOP_INTERVAL_MS,
  MAX_TRIES,
  RETRY_DELAYS_MS,
  SF_CALL_TIMEOUT_MS,
  SF_CREATE_TIMEOUT_MS,
  STUCK_AFTER_MS,
  claimInboundText,
  failExhaustedStuckInboundTexts,
  maybeStartInboundTextLoop,
  processInboundText,
  reapStuckInboundTexts,
  runInboundTextTick,
  selectDueInboundTexts,
  selectRecentAlert,
  type InboundTextDeps,
} from './inbound-text-worker.js';

const NOW = new Date('2026-09-25T21:05:00Z');
const BODY = 'Is the house on Elm still available? gate code 4471';
const LEAD = '00Q000000000001AAA';
const CONTACT = '003000000000001AAA';
const ACCOUNT = '001000000000001AAA';
const DEAL = 'a0X000000000001AAA';
const OPP = '006000000000001AAA';
const HOME = 'https://gghomes.my.salesforce.com/lightning/page/home';
const NOT_LOGGED = 'This text could not be logged to Salesforce — there is no Task for it.';
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
    emailSkipReason: null,
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
    alertedRecently: vi.fn(async () => false),
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

function emailInputs(h: ReturnType<typeof harness>): Array<{ emailSubject: string; emailBody: string }> {
  return h
    .calls('/actions/standard/emailSimple')
    .map(([, , init]) => (init!.body as { inputs: Array<{ emailSubject: string; emailBody: string }> }).inputs[0]!);
}

/** Salesforce answers the Task create with `task`; the email succeeds. */
function taskAnswers(h: ReturnType<typeof harness>, task: { status: number; json: unknown }): void {
  (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) => {
    h.order.push(`sf:${path}`);
    return path === '/sobjects/Task' ? task : EMAIL_OK;
  });
}

const VALIDATION_ERROR = { status: 400, json: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Type is required' }] };
const SERVER_BUSY = { status: 503, json: { message: 'busy' } };

/** A body with every character JSON escapes, around a fragment that survives
 *  escaping unchanged — so one `includes(SECRET)` catches the raw, the escaped
 *  and the double-escaped forms alike. */
const SECRET = 'gate code 4471';
const TRICKY = `He said "call me"\nmy ${SECRET}\tat C:\\office`;

/** Every string handed to console.warn / console.error, however deeply nested. */
function loggedStrings(): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (v instanceof Error) out.push(v.message);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  [...warn.mock.calls, ...error.mock.calls].forEach(walk);
  return out.join('\n');
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

  it('matches the sender like an inbound call: the rep connection, preferring a Contact’s open Opportunity', async () => {
    const h = harness();
    await processInboundText(row(), h.deps);
    expect(h.deps.sf.findByPhone).toHaveBeenCalledWith('rep-1', '+16195550100', { preferOpenOpportunity: true });
  });

  it('a Contact with an open Opportunity is the Who, the Opportunity the What', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ whoId: CONTACT, whatId: OPP, name: 'Ann' });
    await processInboundText(row(), h.deps);
    expect(taskBodies(h)[0]).toMatchObject({ WhoId: CONTACT, WhatId: OPP });
  });

  it('a Contact without one falls back to its Account as the What; a Deal__c is the What only', async () => {
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

  it('a Salesforce rejection of the LINK (converted lead, bad cross-reference, no access to the record) also falls back to unlinked', async () => {
    for (const errorCode of [
      'CANNOT_UPDATE_CONVERTED_LEAD',
      'INVALID_CROSS_REFERENCE_KEY',
      'FIELD_INTEGRITY_EXCEPTION',
      'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
    ]) {
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

  it('INVALID_FIELD on an UNLINKED Task gets no unlinked retry (nothing to drop) — it is a permanent failure', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    taskAnswers(h, { status: 400, json: [{ errorCode: 'INVALID_FIELD', message: 'Priority' }] });
    await processInboundText(row(), h.deps);
    expect(taskBodies(h)).toHaveLength(1);
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed', lastError: expect.stringContaining('INVALID_FIELD') });
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
            'Message:',
            `> ${BODY}`,
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
    expect(emailInputs(h)[0]!.emailBody).toContain('https://gghomes.my.salesforce.com/lightning/r/00TNEW000000001/view');
  });

  it("links to the Contact's open Opportunity when there is one, else to the Contact — never the Account", async () => {
    const withOpp = harness();
    (withOpp.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ whoId: CONTACT, whatId: OPP, name: 'Ann' });
    await processInboundText(row(), withOpp.deps);
    expect(emailInputs(withOpp)[0]!.emailBody).toContain(`/lightning/r/${OPP}/view`);

    const noOpp = harness();
    (noOpp.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ whoId: CONTACT, whatId: ACCOUNT, name: 'Ann' });
    await processInboundText(row(), noOpp.deps);
    expect(emailInputs(noOpp)[0]!.emailBody).toContain(`/lightning/r/${CONTACT}/view`);
    expect(emailInputs(noOpp)[0]!.emailBody).not.toContain(ACCOUNT);
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

describe('processInboundText — the alert does not depend on the Task', () => {
  it('a retryable Task error on an early try does NOT email yet — it backs off and retries', async () => {
    for (const attempts of [1, 2]) {
      const h = harness();
      taskAnswers(h, SERVER_BUSY);
      await processInboundText(row({ attempts }), h.deps);
      expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
      expect(h.writes.some((w) => 'emailedAt' in w)).toBe(false);
      expect(h.writes.at(-1)).toMatchObject({ status: 'pending', lastError: expect.stringContaining('503') });
    }
  });

  it('a Task error on the FINAL try still emails once, says it was not logged, and fails the row with the Task error', async () => {
    const h = harness();
    taskAnswers(h, SERVER_BUSY);
    await processInboundText(row({ attempts: MAX_TRIES }), h.deps);
    const emails = emailInputs(h);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.emailSubject).toBe('New text from Jane Doe');
    expect(emails[0]!.emailBody).toContain(NOT_LOGGED);
    // No Task to open: the link is the matched Lead.
    expect(emails[0]!.emailBody).toContain(`/lightning/r/${LEAD}/view`);
    expect(h.order.slice(-3)).toEqual(['sf:/actions/standard/emailSimple', 'write:emailedAt', 'write:lastError,status']);
    expect(h.writes.at(-1)).toEqual({ status: 'failed', lastError: expect.stringContaining('task create failed (503)'), updatedAt: NOW });
    expect(h.writes.at(-1)).not.toHaveProperty('nextAttemptAt');
    expect(h.writes.some((w) => 'sfTaskId' in w)).toBe(false);
  });

  it('a permanent Task error (validation rule) emails at once, on the FIRST try, and fails the row — no retries', async () => {
    const h = harness();
    taskAnswers(h, VALIDATION_ERROR);
    await processInboundText(row({ attempts: 1 }), h.deps);
    expect(emailInputs(h)).toHaveLength(1);
    expect(emailInputs(h)[0]!.emailBody).toContain(NOT_LOGGED);
    expect(h.writes).toContainEqual(expect.objectContaining({ emailedAt: NOW }));
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed', lastError: expect.stringContaining('FIELD_CUSTOM_VALIDATION_EXCEPTION') });
    expect(h.writes.at(-1)).not.toHaveProperty('nextAttemptAt');
  });

  it('a Task that failed for a sender nobody matched links the rep’s Salesforce home', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    taskAnswers(h, VALIDATION_ERROR);
    await processInboundText(row(), h.deps);
    expect(emailInputs(h)[0]!.emailBody).toContain(`Open in Salesforce: ${HOME}`);
  });

  it('once-only still holds: a failed-Task row already emailed never emails again', async () => {
    const h = harness();
    taskAnswers(h, VALIDATION_ERROR);
    await processInboundText(row({ emailedAt: new Date('2026-09-25T21:06:00Z') }), h.deps);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed', lastError: expect.stringContaining('FIELD_CUSTOM_VALIDATION_EXCEPTION') });
  });

  it('a backfill row whose Task fails permanently fails without emailing (the digest covers it)', async () => {
    const h = harness();
    taskAnswers(h, VALIDATION_ERROR);
    await processInboundText(row({ backfill: true }), h.deps);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('when the fallback email itself fails transiently, the row backs off with BOTH errors recorded', async () => {
    const h = harness();
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) =>
      path === '/sobjects/Task' ? VALIDATION_ERROR : SERVER_BUSY,
    );
    await processInboundText(row({ attempts: 1 }), h.deps);
    expect(h.writes.some((w) => 'emailedAt' in w)).toBe(false);
    expect(h.writes.at(-1)).toMatchObject({
      status: 'pending',
      lastError: expect.stringMatching(/FIELD_CUSTOM_VALIDATION_EXCEPTION[\s\S]*email: email failed \(503\)/),
    });
  });

  it('an AUTH failure on the Task stays terminal and sends nothing — we cannot send as the rep', async () => {
    const h = harness();
    taskAnswers(h, { status: 401, json: [{ errorCode: 'INVALID_SESSION_ID' }] });
    await processInboundText(row({ attempts: MAX_TRIES }), h.deps);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed', lastError: 'reconnect Salesforce' });
  });
});

describe('processInboundText — one alert per rep per sender per hour (flood guard)', () => {
  /** A tiny stand-in for inbound_messages' emailed_at stamps: every alert the
   *  worker records lands here, and `alertedRecently` reads it back exactly as
   *  the SQL does — same rep, same sender, emailed_at at or after `since`. */
  function sharedAlerts() {
    const sent: Array<{ userId: string; from: string; at: Date }> = [];
    const alertedRecently = vi.fn(async (userId: string, from: string, since: Date) =>
      sent.some((s) => s.userId === userId && s.from === from && s.at.getTime() >= since.getTime()),
    );
    const run = async (r: InboundMessage, at: Date) => {
      const h = harness({ alertedRecently, now: () => at });
      await processInboundText(r, h.deps);
      const stamp = h.writes.find((w) => w.emailedAt instanceof Date);
      if (stamp) sent.push({ userId: r.userId!, from: r.fromE164, at: stamp.emailedAt as Date });
      return h;
    };
    return { run, alertedRecently };
  }

  it('a second text 10 minutes later gets its Task but NO email, and the row says why; 61 minutes later emails again', async () => {
    expect(EMAIL_WINDOW_MS).toBe(60 * 60_000);
    const { run } = sharedAlerts();
    const first = await run(row({ id: 'row-a' }), NOW);
    expect(first.calls('/actions/standard/emailSimple')).toHaveLength(1);

    const second = await run(row({ id: 'row-b' }), new Date(NOW.getTime() + 10 * 60_000));
    expect(second.calls('/sobjects/Task')).toHaveLength(1);
    expect(second.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(second.writes.some((w) => w.emailedAt instanceof Date)).toBe(false);
    expect(second.writes).toContainEqual(expect.objectContaining({ emailSkipReason: expect.stringMatching(/one alert per sender per hour/) }));
    expect(second.writes.at(-1)).toMatchObject({ status: 'done', lastError: null });

    const third = await run(row({ id: 'row-c' }), new Date(NOW.getTime() + 61 * 60_000));
    expect(third.calls('/actions/standard/emailSimple')).toHaveLength(1);
  });

  it('asks about THIS rep and THIS sender over the last 60 minutes', async () => {
    const { run, alertedRecently } = sharedAlerts();
    await run(row(), NOW);
    expect(alertedRecently).toHaveBeenCalledWith('rep-1', '+16195550100', new Date(NOW.getTime() - EMAIL_WINDOW_MS));
  });

  it('another sender inside the window is still emailed', async () => {
    const { run } = sharedAlerts();
    await run(row({ id: 'row-a' }), NOW);
    const other = await run(row({ id: 'row-b', fromE164: '+16195550111' }), new Date(NOW.getTime() + 60_000));
    expect(other.calls('/actions/standard/emailSimple')).toHaveLength(1);
  });

  it('the decision is once-only: a retried row that was suppressed never asks again or emails', async () => {
    const h = harness();
    await processInboundText(row({ emailSkipReason: 'one alert per sender per hour', sfTaskId: null }), h.deps);
    expect(h.deps.alertedRecently).not.toHaveBeenCalled();
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(h.calls('/sobjects/Task')).toHaveLength(1);
  });

  it('a "could not be logged" alert BYPASSES the guard — it is the only trace of the text — and still sends once', async () => {
    const { run, alertedRecently } = sharedAlerts();
    await run(row({ id: 'row-a' }), NOW); // the hour's normal alert for this sender
    alertedRecently.mockClear();
    const tenMinLater = new Date(NOW.getTime() + 10 * 60_000);
    const h = harness({ alertedRecently, now: () => tenMinLater });
    taskAnswers(h, VALIDATION_ERROR); // the second text's Task fails for good
    await processInboundText(row({ id: 'row-b' }), h.deps);
    expect(emailInputs(h)).toHaveLength(1);
    expect(emailInputs(h)[0]!.emailBody).toContain(NOT_LOGGED);
    expect(h.writes).toContainEqual(expect.objectContaining({ emailedAt: tenMinLater }));
    expect(h.writes.some((w) => 'emailSkipReason' in w)).toBe(false);
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed' });
    expect(alertedRecently).not.toHaveBeenCalled(); // the guard is not even consulted
  });

  it('…but never twice: a not-logged row already emailed does not email again, guard or no guard', async () => {
    const h = harness({ alertedRecently: vi.fn(async () => true) });
    taskAnswers(h, VALIDATION_ERROR);
    await processInboundText(row({ emailedAt: new Date('2026-09-25T21:06:00Z') }), h.deps);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('a normal alert (the Task WAS created) inside the hour is still suppressed', async () => {
    const h = harness({ alertedRecently: vi.fn(async () => true) });
    await processInboundText(row(), h.deps);
    expect(h.calls('/sobjects/Task')).toHaveLength(1);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
    expect(h.writes).toContainEqual(expect.objectContaining({ emailSkipReason: expect.stringMatching(/one alert per sender/) }));
  });

  it('a backfill row never even asks (it never emails individually)', async () => {
    const h = harness();
    await processInboundText(row({ backfill: true }), h.deps);
    expect(h.deps.alertedRecently).not.toHaveBeenCalled();
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
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
  });

  it('a row gets three tries in all (one try plus two retries): backs off 30 s, 2 min — then fails', async () => {
    expect([...RETRY_DELAYS_MS]).toEqual([30_000, 120_000]);
    expect(MAX_TRIES).toBe(3);
    const outcomes: Patch[] = [];
    for (const attempts of [1, 2, 3]) {
      const h = harness();
      // A failure that is not the Task's: resolving the rep's Salesforce id.
      (h.deps.sf.salesforceUserId as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('chatter/users/me 503'));
      await processInboundText(row({ attempts }), h.deps);
      outcomes.push(h.writes.at(-1)!);
    }
    expect(outcomes[0]).toMatchObject({ status: 'pending', nextAttemptAt: new Date(NOW.getTime() + 30_000) });
    expect(outcomes[1]).toMatchObject({ status: 'pending', nextAttemptAt: new Date(NOW.getTime() + 120_000) });
    expect(outcomes[2]).toMatchObject({ status: 'failed', lastError: expect.stringContaining('503') });
    expect(outcomes[2]).not.toHaveProperty('nextAttemptAt');
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

});

/**
 * The message body never reaches a log line — one test per log site, each
 * proving the site FIRED (so the test cannot pass vacuously) and that what it
 * wrote holds no trace of the body in any form: raw, JSON-escaped (Salesforce
 * quoting it back inside a payload we stringify) or double-escaped.
 */
describe('the message body never reaches a log line', () => {
  const quoting = (status: number, errorCode: string) => ({ status, json: [{ errorCode, message: `bad value: ${TRICKY}` }] });

  it('the sender-match warning, when the SOSL error quotes the body', async () => {
    const h = harness();
    (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(`SOSL failed (500): ${JSON.stringify([{ message: TRICKY }])}`),
    );
    await processInboundText(row({ body: TRICKY }), h.deps);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sender match failed'), expect.anything());
    expect(loggedStrings()).not.toContain(SECRET);
  });

  it('the link-rejection warning, when Salesforce quotes the body in the refusal', async () => {
    const h = harness();
    let n = 0;
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) => {
      if (path !== '/sobjects/Task') return EMAIL_OK;
      n++;
      return n === 1 ? quoting(400, 'INVALID_CROSS_REFERENCE_KEY') : { status: 201, json: { id: '00TNEW000000009' } };
    });
    await processInboundText(row({ body: TRICKY }), h.deps);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without WhoId/WhatId'), expect.anything());
    expect(loggedStrings()).not.toContain(SECRET);
  });

  it('the "task given up" failure, after a permanent Task error that quotes the body and a SUCCESSFUL alert', async () => {
    const h = harness();
    taskAnswers(h, quoting(400, 'STRING_TOO_LONG'));
    await processInboundText(row({ body: TRICKY, attempts: 1 }), h.deps);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(1);
    expect(h.writes.at(-1)).toMatchObject({ status: 'failed' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('text failed'), expect.anything());
    expect(loggedStrings()).not.toContain(SECRET);
  });

  it('the final failure, when BOTH the Task and the alert are refused with the body quoted back', async () => {
    const h = harness();
    (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => quoting(400, 'STRING_TOO_LONG'));
    await processInboundText(row({ body: TRICKY, attempts: MAX_TRIES }), h.deps);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('text failed'), expect.anything());
    expect(loggedStrings()).not.toContain(SECRET);
  });
});

describe('the reaper budget', () => {
  it('only presumes a row dead after every Salesforce call it can make has timed out', () => {
    // findByPhone + salesforceUserId + the User.Email read, and the two mutating calls.
    expect(STUCK_AFTER_MS).toBeGreaterThanOrEqual(SF_CALL_TIMEOUT_MS * 3 + SF_CREATE_TIMEOUT_MS * 2);
  });
});

describe('runInboundTextTick', () => {
  interface TickFake {
    due?: InboundMessage[];
    /** What each claim's `.returning()` yields — null = another replica won the row. */
    claim?: () => InboundMessage | null;
    /** What the capped reaper's `.returning()` yields: stuck rows already at MAX_TRIES. */
    exhausted?: InboundMessage[];
    /** Make a processing write reject (never a claim or a reaper write). */
    failWrite?: () => Error | null;
    /** Shared, ordered log of writes (`write:<status or keys>`) for order assertions. */
    log?: string[];
  }

  /** A fake handle for the tick: the reapers and the claim are `update`s (the
   *  capped reaper and the claim await `.returning()`), the scan is a `select`. */
  function tickDb(f: TickFake) {
    const writes: Patch[] = [];
    let exhausted = f.exhausted ?? [];
    const db = {
      update: (_t: unknown) => ({
        set: (patch: Patch) => ({
          where: (_w: unknown) => {
            writes.push(patch);
            const label =
              typeof patch.status === 'string'
                ? `status=${patch.status}`
                : Object.keys(patch).filter((k) => k !== 'updatedAt').sort().join(',');
            f.log?.push(`write:${label}`);
            const reapOrClaim =
              patch.status === 'in_flight' ||
              (patch.status === 'pending' && !('lastError' in patch)) ||
              (patch.status === 'failed' && typeof patch.lastError === 'object');
            const err = reapOrClaim ? null : (f.failWrite?.() ?? null);
            const done = (err ? Promise.reject(err) : Promise.resolve([])) as Promise<unknown> & {
              returning: () => Promise<InboundMessage[]>;
            };
            done.catch(() => {}); // awaited by the caller; this only silences the unhandled-rejection probe
            done.returning = async () => {
              if (patch.status === 'in_flight') {
                const r = f.claim?.() ?? null;
                return r ? [r] : [];
              }
              const out = exhausted;
              exhausted = [];
              return out;
            };
            return done;
          },
        }),
      }),
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => f.due ?? [] }) }) }) }),
    };
    return { writes, db: db as unknown as InboundTextDeps['db'] };
  }

  it('reaps stuck rows, then skips a row whose conditional claim lost to another replica', async () => {
    const t = tickDb({ due: [row({ status: 'pending', attempts: 0 })], claim: () => null });
    const h = harness({ db: t.db });
    const out = await runInboundTextTick(h.deps);
    expect(out.processed).toBe(0);
    expect(t.writes[0]).toMatchObject({ status: 'pending' }); // the reaper
    expect(h.deps.sf.findByPhone).not.toHaveBeenCalled();
    expect(h.calls('/sobjects/Task')).toHaveLength(0);
  });

  it('processes the row AS CLAIMED (fresh stamps, bumped attempts), stamping the claim with a fresh clock', async () => {
    let t0 = NOW.getTime();
    const claimed = row({ status: 'in_flight', attempts: 2, sfTaskId: '00TOLD000000001' });
    const t = tickDb({ due: [row({ status: 'pending', attempts: 1 })], claim: () => claimed });
    const h = harness({ db: t.db, now: () => new Date((t0 += 1_000)) });
    const out = await runInboundTextTick(h.deps);
    expect(out.processed).toBe(1);
    // The claimed row already has its Task: only the email goes out.
    expect(h.calls('/sobjects/Task')).toHaveLength(0);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(1);
    const claimWrite = t.writes.find((w) => w.status === 'in_flight')!;
    const reapWrite = t.writes[0]!;
    expect((claimWrite.updatedAt as Date).getTime()).toBeGreaterThan((reapWrite.updatedAt as Date).getTime());
  });

  it('each claim reads the clock AFTER the previous row finished — a stale claim stamp would be reaped and run twice', async () => {
    // One clock read per tick would stamp row 2's claim with the time row 1 was
    // claimed; in a 25-row batch that stamp can be minutes old the moment it is
    // written, and another replica's reaper takes the row while this one works on it.
    let t0 = NOW.getTime();
    const rows = [row({ id: 'row-1', status: 'pending' }), row({ id: 'row-2', status: 'pending' })];
    let n = 0;
    const t = tickDb({ due: rows, claim: () => rows[n++] ?? null });
    const h = harness({ db: t.db, now: () => new Date((t0 += 1_000)) });
    await runInboundTextTick(h.deps);
    const claims = t.writes.map((w, i) => ({ w, i })).filter(({ w }) => w.status === 'in_flight');
    expect(claims).toHaveLength(2);
    const [c1, c2] = claims as [{ w: Patch; i: number }, { w: Patch; i: number }];
    const row1Writes = t.writes.slice(c1.i + 1, c2.i);
    expect(row1Writes.at(-1)).toMatchObject({ status: 'done' }); // row 1 really finished in between
    const row1Last = Math.max(...row1Writes.map((w) => (w.updatedAt as Date).getTime()));
    expect((c2.w.updatedAt as Date).getTime()).toBeGreaterThan(row1Last);
  });

  it('keeps draining the batch when one row throws out of processing — and the crash log never holds the body', async () => {
    const rows = [row({ id: 'row-1', status: 'pending', body: TRICKY }), row({ id: 'row-2', status: 'pending' })];
    let n = 0;
    let current: InboundMessage | null = null;
    // row-1's writes explode with an error that QUOTES the body (a database error
    // can quote the failing row) — including the backoff write in its catch — so
    // the throw escapes processInboundText. row-2 must still run.
    const t = tickDb({
      due: rows,
      claim: () => (current = rows[n++] ?? null),
      failWrite: () => (current?.id === 'row-1' ? new Error(`write failed for row (${JSON.stringify(TRICKY)})`) : null),
    });
    const h = harness({ db: t.db });
    const out = await runInboundTextTick(h.deps);
    expect(out.processed).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('row crashed'), expect.objectContaining({ rowId: 'row-1' }));
    expect(loggedStrings()).not.toContain(SECRET);
    expect(h.calls('/actions/standard/emailSimple')).toHaveLength(1); // row-2 went all the way through
    expect(t.writes.at(-1)).toMatchObject({ status: 'done' });
  });

  describe('attempts are capped — a row can never loop forever', () => {
    it('a stuck row already on its LAST try is failed by the reaper (not handed back), then its rep is alerted once', async () => {
      const log: string[] = [];
      const stuck = row({ id: 'row-stuck', status: 'failed', attempts: MAX_TRIES });
      const t = tickDb({ exhausted: [stuck], log });
      const h = harness({ db: t.db });
      (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) => {
        log.push(`sf:${path}`);
        return EMAIL_OK;
      });
      const out = await runInboundTextTick(h.deps);
      expect(out.gaveUp).toBe(1);
      // The capped reaper wrote `failed` (in SQL, before any Salesforce call); then the alert, then its stamp.
      expect(log).toEqual(['write:status=pending', 'write:status=failed', 'sf:/actions/standard/emailSimple', 'write:emailedAt']);
      expect(h.calls('/sobjects/Task')).toHaveLength(0);
      expect(emailInputs(h)[0]!.emailBody).toContain(NOT_LOGGED);
    });

    it('no alert for a given-up row already emailed, suppressed, backfilled, or with no rep', async () => {
      const cases: Array<Partial<InboundMessage>> = [
        { emailedAt: NOW },
        { emailSkipReason: 'one alert per sender per hour' },
        { backfill: true },
        { userId: null },
      ];
      for (const o of cases) {
        const t = tickDb({ exhausted: [row({ status: 'failed', attempts: MAX_TRIES, ...o })] });
        const h = harness({ db: t.db });
        await runInboundTextTick(h.deps);
        expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
      }
    });

    it('a given-up row that has its Task links it and does not say "not logged"', async () => {
      const t = tickDb({ exhausted: [row({ status: 'failed', attempts: MAX_TRIES, sfTaskId: '00TOLD000000001' })] });
      const h = harness({ db: t.db });
      (h.deps.sf.findByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await runInboundTextTick(h.deps);
      expect(emailInputs(h)[0]!.emailBody).not.toContain(NOT_LOGGED);
      expect(emailInputs(h)[0]!.emailBody).toContain('/lightning/r/00TOLD000000001/view');
    });

    it('the final alert obeys the flood guard when the row HAS its Task', async () => {
      const t = tickDb({ exhausted: [row({ status: 'failed', attempts: MAX_TRIES, sfTaskId: '00TOLD000000001' })] });
      const h = harness({ db: t.db, alertedRecently: vi.fn(async () => true) });
      await runInboundTextTick(h.deps);
      expect(h.calls('/actions/standard/emailSimple')).toHaveLength(0);
      expect(t.writes).toContainEqual(expect.objectContaining({ emailSkipReason: expect.stringMatching(/one alert per sender/) }));
    });

    it('…and bypasses it when the text was never logged (no Task) — the email is its only trace', async () => {
      const t = tickDb({ exhausted: [row({ status: 'failed', attempts: MAX_TRIES, sfTaskId: null })] });
      const h = harness({ db: t.db, alertedRecently: vi.fn(async () => true) });
      await runInboundTextTick(h.deps);
      expect(emailInputs(h)).toHaveLength(1);
      expect(emailInputs(h)[0]!.emailBody).toContain(NOT_LOGGED);
      expect(t.writes.some((w) => 'emailSkipReason' in w)).toBe(false);
    });

    it('a pending row RE-CLAIMED past its last try is failed at once — no fresh try — then alerted', async () => {
      const log: string[] = [];
      const claimed = row({ status: 'in_flight', attempts: MAX_TRIES + 1, lastError: 'task create failed (503)' });
      const t = tickDb({ due: [row({ status: 'pending', attempts: MAX_TRIES })], claim: () => claimed, log });
      const h = harness({ db: t.db });
      (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_u: string, path: string) => {
        log.push(`sf:${path}`);
        return EMAIL_OK;
      });
      const out = await runInboundTextTick(h.deps);
      expect(out).toEqual({ processed: 0, gaveUp: 1 });
      expect(h.calls('/sobjects/Task')).toHaveLength(0);
      // (The capped reaper also writes `failed`, with a SQL expression; this is the re-claim's own write.)
      const failedWrite = t.writes.find((w) => w.status === 'failed' && typeof w.lastError === 'string')!;
      expect(failedWrite.lastError).toBe(`gave up: already tried ${MAX_TRIES} times; task create failed (503)`);
      // failed BEFORE the email: a crash while emailing must not leave the row claimable.
      expect(log.slice(-4)).toEqual(['write:status=in_flight', 'write:status=failed', 'sf:/actions/standard/emailSimple', 'write:emailedAt']);
    });

    it('a failed final alert is logged (without the body) and never retried — the row is already failed', async () => {
      const t = tickDb({ exhausted: [row({ status: 'failed', attempts: MAX_TRIES, body: TRICKY })] });
      const h = harness({ db: t.db });
      (h.deps.sf.sfFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        status: 400,
        json: [{ errorCode: 'STRING_TOO_LONG', message: `bad: ${TRICKY}` }],
      }));
      await runInboundTextTick(h.deps);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('final alert failed'), expect.anything());
      expect(loggedStrings()).not.toContain(SECRET);
      expect(t.writes.some((w) => w.emailedAt instanceof Date)).toBe(false);
      expect(t.writes.filter((w) => w.status === 'pending')).toHaveLength(1); // only the ordinary reaper's write
    });
  });
});

describe('INBOUND_TEXTS kill switch — the loop', () => {
  it('off → the worker loop is NOT started', () => {
    const start = vi.fn();
    expect(maybeStartInboundTextLoop({ INBOUND_TEXTS: 'off' }, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('on → started at the 5 s interval, and the timer handed back for close()', () => {
    const timer = setTimeout(() => {}, 0);
    clearTimeout(timer);
    const start = vi.fn(() => timer);
    expect(maybeStartInboundTextLoop({ INBOUND_TEXTS: 'on' }, start)).toBe(timer);
    expect(start).toHaveBeenCalledWith(LOOP_INTERVAL_MS);
    expect(LOOP_INTERVAL_MS).toBe(5_000);
  });
});

describe('the worker SQL, rendered', () => {
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
  const RETURNING =
    ' returning "id", "org_id", "message_sid", "from_e164", "to_e164", "body", "num_media", "user_id", "status", "attempts", ' +
    '"next_attempt_at", "last_error", "sf_task_id", "emailed_at", "email_skip_reason", "backfill", "received_at", "created_at", "updated_at"';

  it('the claim is a compare-and-swap pending → in_flight, DUE by the claim time, that bumps attempts and stamps updated_at', () => {
    const { sql, params } = claimInboundText(db, 'row-1', NOW).toSQL();
    expect(sql).toBe(
      'update "inbound_messages" set "status" = $1, "attempts" = "inbound_messages"."attempts" + 1, "updated_at" = $2 ' +
        'where ("inbound_messages"."id" = $3 and "inbound_messages"."status" = $4 and "inbound_messages"."next_attempt_at" <= $5)' +
        RETURNING,
    );
    expect(params).toEqual(['in_flight', NOW.toISOString(), 'row-1', 'pending', NOW.toISOString()]);
  });

  it('the scan takes due pending rows, oldest first, a bounded batch', () => {
    const { sql, params } = selectDueInboundTexts(db, NOW).toSQL();
    expect(sql).toMatch(
      /from "inbound_messages" where \("inbound_messages"\."status" = \$1 and "inbound_messages"\."next_attempt_at" <= \$2\) order by "inbound_messages"\."created_at" asc limit \$3$/,
    );
    expect(params).toEqual(['pending', NOW.toISOString(), BATCH_LIMIT]);
  });

  it('the reaper hands back only stuck in_flight rows with a try LEFT', () => {
    const { sql, params } = reapStuckInboundTexts(db, NOW).toSQL();
    expect(sql).toBe(
      'update "inbound_messages" set "status" = $1, "updated_at" = $2 ' +
        'where ("inbound_messages"."status" = $3 and "inbound_messages"."updated_at" <= $4 and "inbound_messages"."attempts" < $5)',
    );
    expect(params).toEqual(['pending', NOW.toISOString(), 'in_flight', new Date(NOW.getTime() - STUCK_AFTER_MS).toISOString(), MAX_TRIES]);
  });

  it('the capped reaper FAILS stuck rows with no try left, keeping their last error, and returns them for the alert', () => {
    const { sql, params } = failExhaustedStuckInboundTexts(db, NOW).toSQL();
    expect(sql).toBe(
      'update "inbound_messages" set "status" = $1, "last_error" = concat_ws(\'; \', $2::text, "inbound_messages"."last_error"), "updated_at" = $3 ' +
        'where ("inbound_messages"."status" = $4 and "inbound_messages"."updated_at" <= $5 and "inbound_messages"."attempts" >= $6)' +
        RETURNING,
    );
    expect(params).toEqual([
      'failed',
      'gave up: stuck in flight on its last try',
      NOW.toISOString(),
      'in_flight',
      new Date(NOW.getTime() - STUCK_AFTER_MS).toISOString(),
      MAX_TRIES,
    ]);
  });

  it("the flood guard asks: an alert to this rep about this sender since the window's start", () => {
    const since = new Date(NOW.getTime() - EMAIL_WINDOW_MS);
    const { sql, params } = selectRecentAlert(db, 'rep-1', '+16195550100', since).toSQL();
    expect(sql).toBe(
      'select "id" from "inbound_messages" where ("inbound_messages"."user_id" = $1 and "inbound_messages"."from_e164" = $2 ' +
        'and "inbound_messages"."emailed_at" >= $3) limit $4',
    );
    expect(params).toEqual(['rep-1', '+16195550100', since.toISOString(), 1]);
  });
});
