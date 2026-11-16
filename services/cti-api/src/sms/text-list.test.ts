import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema, type InboundMessage } from '@cti/db';
import {
  countRepTextsSince,
  fetchTaskLinks,
  selectRepTexts,
  textListItem,
  textSalesforceState,
  TASK_LINK_TIMEOUT_MS,
} from './text-list.js';
import { RECONNECT_SALESFORCE } from './inbound-text.js';

const row = (over: Partial<InboundMessage> = {}): InboundMessage => ({
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
  emailedAt: new Date('2026-11-16T18:00:05Z'),
  emailSkipReason: null,
  backfill: false,
  backfillBatch: null,
  receivedAt: new Date('2026-11-16T18:00:00Z'),
  createdAt: new Date('2026-11-16T18:00:00Z'),
  updatedAt: new Date('2026-11-16T18:00:05Z'),
  ...over,
});

describe('textSalesforceState', () => {
  it('is logged once the Task exists, whatever else the row says', () => {
    expect(textSalesforceState(row())).toBe('logged');
    expect(textSalesforceState(row({ status: 'failed', lastError: 'x' }))).toBe('logged');
  });

  it('is pending while the worker has not finished with it', () => {
    expect(textSalesforceState(row({ sfTaskId: null, status: 'pending' }))).toBe('pending');
    expect(textSalesforceState(row({ sfTaskId: null, status: 'in_flight' }))).toBe('pending');
  });

  it('asks the rep to reconnect when Salesforce refused their sign-in', () => {
    expect(textSalesforceState(row({ sfTaskId: null, status: 'failed', lastError: RECONNECT_SALESFORCE }))).toBe('reconnect');
  });

  it('is failed for any other finished row without a Task', () => {
    expect(textSalesforceState(row({ sfTaskId: null, status: 'failed', lastError: 'task create failed (400)' }))).toBe('failed');
    // A Task lost for good still finishes the row as done (the alert went out).
    expect(textSalesforceState(row({ sfTaskId: null, status: 'done' }))).toBe('failed');
  });
});

describe('textListItem', () => {
  const contactWithOpp = { whoId: '003000000000001AAA', whatId: '006000000000001AAA', whoName: 'Pat Seller', whatName: 'Pat Seller - 12 Elm' };

  it('carries the text, an ISO time and the opt-out flag', () => {
    const item = textListItem(row({ body: ' stop ', numMedia: 2 }), undefined, true);
    expect(item).toMatchObject({
      id: 'm-1',
      fromE164: '+16195550100',
      toE164: '+16193507799',
      body: ' stop ',
      numMedia: 2,
      receivedAt: '2026-11-16T18:00:00.000Z',
      optOut: true,
      salesforce: 'logged',
    });
  });

  it('names the person and opens the open Opportunity, as the email link does', () => {
    const item = textListItem(row(), contactWithOpp, true);
    expect(item.senderName).toBe('Pat Seller');
    expect(item.openRecordId).toBe('006000000000001AAA');
  });

  it('opens the Lead for a Lead text', () => {
    const item = textListItem(row(), { whoId: '00Q000000000001AAA', whatId: null, whoName: 'Lee Lead', whatName: null }, true);
    expect(item).toMatchObject({ senderName: 'Lee Lead', openRecordId: '00Q000000000001AAA' });
  });

  it('falls back to the related record name when there is no person', () => {
    const item = textListItem(row(), { whoId: null, whatId: 'a01000000000001AAA', whoName: null, whatName: 'Deal 42' }, true);
    expect(item).toMatchObject({ senderName: 'Deal 42', openRecordId: 'a01000000000001AAA' });
  });

  it('opens the Task itself when the text matched nobody', () => {
    const item = textListItem(row(), { whoId: null, whatId: null, whoName: null, whatName: null }, true);
    expect(item).toMatchObject({ senderName: null, openRecordId: '00T000000000001AAA' });
  });

  it('opens nothing when Salesforce answered and the Task is gone (deleted)', () => {
    expect(textListItem(row(), undefined, true)).toMatchObject({ senderName: null, openRecordId: null });
  });

  it('still opens the Task when the Salesforce lookup itself failed', () => {
    expect(textListItem(row(), undefined, false)).toMatchObject({ senderName: null, openRecordId: '00T000000000001AAA' });
  });

  it('opens nothing for a text that never became a Task', () => {
    expect(textListItem(row({ sfTaskId: null, status: 'failed' }), undefined, false).openRecordId).toBeNull();
  });
});

describe('fetchTaskLinks', () => {
  it('reads every Task in one query, as the rep', async () => {
    const query = vi.fn(async () => [
      { Id: '00T000000000001AAA', WhoId: '003000000000001AAA', WhatId: null, Who: { Name: 'Pat' }, What: null },
    ]);
    const links = await fetchTaskLinks('u-1', ['00T000000000001AAA', '00T000000000002AAA'], query);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'u-1',
      "SELECT Id, WhoId, WhatId, Who.Name, What.Name FROM Task WHERE Id IN ('00T000000000001AAA','00T000000000002AAA')",
    );
    expect(links.get('00T000000000001AAA')).toEqual({ whoId: '003000000000001AAA', whatId: null, whoName: 'Pat', whatName: null });
    expect(links.has('00T000000000002AAA')).toBe(false);
  });

  it('never puts anything but a Salesforce id into the query, and skips the call when none is left', async () => {
    const query = vi.fn(async () => []);
    const links = await fetchTaskLinks('u-1', ["00T' OR Id != '", 'nope'], query);
    expect(query).not.toHaveBeenCalled();
    expect(links.size).toBe(0);
  });

  it('gives up after its timeout so a slow Salesforce cannot hang the list', async () => {
    vi.useFakeTimers();
    try {
      const pending = fetchTaskLinks('u-1', ['00T000000000001AAA'], () => new Promise(() => {}));
      const settled = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(TASK_LINK_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('queries', () => {
  // No connection is opened: .toSQL() only renders the statement.
  const db = drizzle(new pg.Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it("lists only this rep's texts, newest first", () => {
    const q = selectRepTexts(db, 'u-1', 50).toSQL();
    expect(q.sql).toMatch(/from "inbound_messages" where "inbound_messages"\."user_id" = \$1 order by "inbound_messages"\."received_at" desc, "inbound_messages"\."id" desc limit \$2/);
    expect(q.params).toEqual(['u-1', 50]);
  });

  it("counts only this rep's texts that arrived after the given time", () => {
    const since = new Date('2026-11-16T18:00:00Z');
    const q = countRepTextsSince(db, 'u-1', since).toSQL();
    expect(q.sql).toMatch(/count\(\*\).*from "inbound_messages" where \("inbound_messages"\."user_id" = \$1 and "inbound_messages"\."received_at" > \$2\)/);
    expect(q.params).toEqual(['u-1', since.toISOString()]);
  });
});
