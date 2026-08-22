import { describe, expect, it, vi } from 'vitest';
import { clientTaskAllowed, syncErrorForCall } from './calls.js';
import type { OwnershipSnapshot } from '../salesforce/ownership.js';

// The raw shape GET /calls gets back from salesforce_sync_jobs.
const SOQL_DUMP = 'SOQL failed (400): [{"message":"No such column","errorCode":"INVALID_FIELD"}]';
const NO_TASK = { salesforceTaskId: null };

describe('syncErrorForCall', () => {
  it('surfaces the deliberate skip once the job is done', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'succeeded', lastError: 'not-owner' })).toBe('not-owner');
  });

  it('reduces a terminal failure to the token, never the Salesforce error text', () => {
    // last_error is a SOQL/HTTP dump: org field names, record ids, API internals.
    // The browser gets a reason code; the operator reads the detail in the job row.
    expect(syncErrorForCall(NO_TASK, { status: 'failed', lastError: SOQL_DUMP })).toBe('failed');
    expect(syncErrorForCall(NO_TASK, { status: 'failed', lastError: null })).toBe('failed');
  });

  it('says nothing while the job is still retrying or in flight', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'pending', lastError: SOQL_DUMP })).toBeNull();
    expect(syncErrorForCall(NO_TASK, { status: 'in_flight', lastError: SOQL_DUMP })).toBeNull();
  });

  it('is null for a clean sync and for a call with no job at all', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'succeeded', lastError: null })).toBeNull();
    expect(syncErrorForCall(NO_TASK, undefined)).toBeNull();
  });

  it('reports nothing for a succeeded job whose lastError is not a known skip reason', () => {
    // A stale attempt error left on a job that later succeeded is not a reason
    // the rep can act on — and it is raw Salesforce text.
    expect(syncErrorForCall(NO_TASK, { status: 'succeeded', lastError: SOQL_DUMP })).toBeNull();
  });

  it('says nothing when the Task exists, however the job got there', () => {
    // Jobs written before the success path started clearing lastError still
    // carry the error of an attempt that later succeeded. The call has its Task.
    expect(syncErrorForCall({ salesforceTaskId: '00T1' }, { status: 'succeeded', lastError: 'not-owner' })).toBeNull();
    expect(syncErrorForCall({ salesforceTaskId: '00T1' }, { status: 'failed', lastError: SOQL_DUMP })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clientTaskAllowed — the `taskAllowed` flag on POST /calls.
// `true` lets the SOFTPHONE write the Salesforce Task itself (Open CTI), which
// then posts `skipSalesforceSync: true` — so a `true` here is the one path that
// runs NO server-side gate at all. Unknown ownership must therefore answer
// `false` (the backend writes it instead, gated and retried), never `true`.
// ---------------------------------------------------------------------------
const ME = '005ME';
const snap = (o: Partial<OwnershipSnapshot> = {}): OwnershipSnapshot => ({ type: 'Lead', ownerId: ME, ...o });

describe('clientTaskAllowed', () => {
  it('is true with no round-trip when there is no gated id', async () => {
    const resolveMe = vi.fn(async () => ME);
    const lookup = vi.fn(async () => snap());
    expect(await clientTaskAllowed(undefined, resolveMe, lookup)).toBe(true);
    // A custom object is allowed by the rule outright — not even /users/me.
    expect(await clientTaskAllowed('a01000000000001', resolveMe, lookup)).toBe(true);
    expect(resolveMe).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('is true on a record the rep owns', async () => {
    expect(await clientTaskAllowed('00Q000000000001', async () => ME, async () => snap())).toBe(true);
  });

  it('is false on a record the rep neither owns nor manages', async () => {
    const r = await clientTaskAllowed('006000000000001', async () => ME,
      async () => snap({ type: 'Opportunity', ownerId: '005OTHER', leadManagerId: '005ALSOOTHER' }));
    expect(r).toBe(false);
  });

  it('fails CLOSED when the ownership lookup throws', async () => {
    const onError = vi.fn();
    const r = await clientTaskAllowed('00Q000000000001', async () => ME, async () => { throw new Error('SOQL 503'); }, onError);
    expect(r).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED when resolving the caller\'s own Salesforce user id throws', async () => {
    const lookup = vi.fn(async () => snap());
    const r = await clientTaskAllowed('00Q000000000001', async () => { throw new Error('no connection'); }, lookup);
    expect(r).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});
