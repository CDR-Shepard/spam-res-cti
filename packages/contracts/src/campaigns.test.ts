import { describe, expect, it } from 'vitest';
import {
  Campaign,
  CampaignPlanResponse,
  CampaignPreview,
  CampaignSource,
  CampaignStatusChange,
  CreateCampaignRequest,
  PlanRow,
  SkipReason,
  TouchDays,
  UpdateCampaignRequest,
} from './index.js';

const SOQL = "SELECT Id FROM Lead WHERE Status = 'Open'";

describe('campaign contracts', () => {
  it.each([
    ['a 15-char list view id', { kind: 'list_view', listViewId: '00B5f00000ABCDE' }],
    ['an 18-char list view id', { kind: 'list_view', listViewId: '00B5f00000ABCDEFGH' }],
    ['a SOQL query', { kind: 'soql', soql: SOQL }],
  ])('CampaignSource accepts %s', (_label, source) => {
    expect(CampaignSource.parse(source)).toEqual(source);
  });

  it.each([
    ['a 14-char list view id', { kind: 'list_view', listViewId: '00B5f00000ABCD' }],
    ['a 19-char list view id', { kind: 'list_view', listViewId: '00B5f00000ABCDEFGHI' }],
    ['an empty SOQL', { kind: 'soql', soql: '' }],
    ['a 9-char SOQL', { kind: 'soql', soql: 'SELECT Id' }],
    ['a SOQL over 20,000 chars', { kind: 'soql', soql: `${SOQL} ${'x'.repeat(20000)}` }],
    ['an unknown kind', { kind: 'report', reportId: '00O5f00000ABCDE' }],
    ['a list view without its id', { kind: 'list_view' }],
    ['a SOQL source carrying a list view id instead', { kind: 'soql', listViewId: '00B5f00000ABCDE' }],
  ])('CampaignSource rejects %s', (_label, source) => {
    expect(CampaignSource.safeParse(source).success).toBe(false);
  });

  it.each([
    ['the default schedule', [0, 1, 3, 6, 10, 14]],
    ['a single touch', [0]],
    ['twelve touches out to day 60', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 60]],
  ])('TouchDays accepts %s', (_label, days) => {
    expect(TouchDays.parse(days)).toEqual(days);
  });

  it.each([
    ['an empty schedule', []],
    ['a schedule not starting at 0', [1, 3, 6]],
    ['a repeated day', [0, 1, 1, 3]],
    ['a decreasing day', [0, 3, 2]],
    ['a negative day', [-1, 0, 1]],
    ['a day past 60', [0, 61]],
    ['a fractional day', [0, 1.5]],
    ['thirteen touches', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
  ])('TouchDays rejects %s', (_label, days) => {
    expect(TouchDays.safeParse(days).success).toBe(false);
  });

  it('TouchDays explains an out-of-order schedule', () => {
    const r = TouchDays.safeParse([0, 3, 2]);
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual(['Touch days must start at 0 and strictly increase']);
  });

  it('CreateCampaignRequest trims the name and requires an object and a source', () => {
    const req = CreateCampaignRequest.parse({ name: '  Probate leads  ', sfObject: 'Lead', source: { kind: 'soql', soql: SOQL } });
    expect(req.name).toBe('Probate leads');
    expect(CreateCampaignRequest.safeParse({ name: '   ', sfObject: 'Lead', source: { kind: 'soql', soql: SOQL } }).success).toBe(false);
    expect(CreateCampaignRequest.safeParse({ name: 'x'.repeat(121), sfObject: 'Lead', source: { kind: 'soql', soql: SOQL } }).success).toBe(false);
    expect(CreateCampaignRequest.safeParse({ name: 'A', sfObject: 'Contact', source: { kind: 'soql', soql: SOQL } }).success).toBe(false);
  });

  it('UpdateCampaignRequest: every field optional, refresh 60–1440 whole minutes, touch days validated', () => {
    expect(UpdateCampaignRequest.parse({})).toEqual({});
    expect(UpdateCampaignRequest.parse({ refreshMinutes: 60, touchDays: [0, 2] })).toEqual({ refreshMinutes: 60, touchDays: [0, 2] });
    for (const bad of [{ refreshMinutes: 59 }, { refreshMinutes: 1441 }, { refreshMinutes: 90.5 }, { touchDays: [2, 4] }, { name: '' }]) {
      expect(UpdateCampaignRequest.safeParse(bad).success).toBe(false);
    }
  });

  it('CampaignStatusChange never moves a campaign back to draft', () => {
    for (const status of ['dry_run', 'active', 'paused', 'archived']) {
      expect(CampaignStatusChange.parse({ status })).toEqual({ status });
    }
    expect(CampaignStatusChange.safeParse({ status: 'draft' }).success).toBe(false);
  });

  it('Campaign parses a dry-run list-view campaign', () => {
    const campaign = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Open leads',
      sfObject: 'Lead',
      source: { kind: 'list_view', listViewId: '00B5f00000ABCDE' },
      status: 'dry_run',
      pauseReason: null,
      pausedFrom: null,
      refreshMinutes: 240,
      touchDays: [0, 1, 3, 6, 10, 14],
      memberCount: 412,
      lastRefreshedAt: '2026-10-04T12:00:00.000Z',
      lastRefreshError: null,
      createdAt: '2026-10-04T11:00:00.000Z',
    };
    expect(Campaign.parse(campaign)).toEqual(campaign);
    expect(Campaign.safeParse({ ...campaign, status: 'running' }).success).toBe(false);
  });

  it('Campaign carries pausedFrom: what a paused campaign was doing (dry_run or active), else null', () => {
    const base = Campaign.parse({
      id: '33333333-3333-4333-8333-333333333333', name: 'Open leads', sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FROM Lead' },
      status: 'paused', pauseReason: 'ai_budget', pausedFrom: 'dry_run', refreshMinutes: 240, touchDays: [0], memberCount: 1,
      lastRefreshedAt: null, lastRefreshError: null, createdAt: '2026-10-04T11:00:00.000Z',
    });
    expect(base.pausedFrom).toBe('dry_run');
    expect(Campaign.safeParse({ ...base, pausedFrom: 'active' }).success).toBe(true);
    expect(Campaign.safeParse({ ...base, pausedFrom: 'draft' }).success).toBe(false);
    expect(Campaign.safeParse({ ...base, pausedFrom: undefined }).success).toBe(false);
  });

  it('CampaignPreview round-trips, skip counts keyed only by known reasons, sample capped at 20', () => {
    const record = { sfRecordId: '00Q5f000001AbCdEAF', name: 'Pat Doe', ownerName: 'Rep One', channels: ['call', 'sms'], skipReason: null };
    const preview = {
      total: 2412,
      examined: 2000,
      eligible: 1830,
      skipped: { opted_out: 40, dnc: 100, in_other_campaign: 30 },
      sample: [record, { ...record, sfRecordId: '00Q5f000001AbCdEAG', channels: [], skipReason: 'no_contact_point' }],
    };
    expect(CampaignPreview.parse(JSON.parse(JSON.stringify(preview)))).toEqual(preview);
    expect(CampaignPreview.safeParse({ ...preview, skipped: { bored: 1 } }).success).toBe(false);
    expect(CampaignPreview.safeParse({ ...preview, sample: Array.from({ length: 21 }, () => record) }).success).toBe(false);
    expect(CampaignPreview.safeParse({ ...preview, sample: [{ ...record, channels: ['fax'] }] }).success).toBe(false);
    expect(SkipReason.options).toHaveLength(9);
  });

  it('PlanRow shows triage without the do-not-contact flag, and the next touch with its gate audit', () => {
    const row = {
      enrollmentId: '44444444-4444-4444-8444-444444444444',
      sfRecordId: '00Q5f000001AbCdEAF',
      name: 'Pat Doe',
      ownerName: 'Rep One',
      status: 'active',
      exitReason: null,
      triage: {
        summary: 'Wants to sell soon.',
        channels: [{ channel: 'call', reason: '"call me"' }],
        timing: null,
        tags: ['motivated'],
        doNotContact: { category: 'other', quote: 'leaked' },
      },
      nextTouch: {
        seq: 1,
        channel: 'rep_call',
        status: 'planned',
        dueAt: '2026-10-05T15:00:00.000Z',
        gateAudit: [{ rule: 'call_mode', channel: 'call', verdict: 'kept', detail: 'no AI-call consent: rep call' }],
      },
    };
    const parsed = PlanRow.parse(row);
    expect(parsed.triage).not.toHaveProperty('doNotContact');
    expect(parsed.nextTouch?.gateAudit[0]?.verdict).toBe('kept');
    expect(PlanRow.safeParse({ ...row, nextTouch: { ...row.nextTouch, status: 'claimed' } }).success).toBe(false);
    expect(PlanRow.safeParse({ ...row, triage: null, nextTouch: null }).success).toBe(true);
  });

  it('CampaignPlanResponse counts are keyed by enrollment status only', () => {
    expect(CampaignPlanResponse.parse({ rows: [], nextCursor: null, counts: { active: 3, exited: 1 } }).counts).toEqual({ active: 3, exited: 1 });
    expect(CampaignPlanResponse.safeParse({ rows: [], nextCursor: null, counts: { waiting: 1 } }).success).toBe(false);
  });
});
