import { describe, expect, it } from 'vitest';
import { Campaign, CampaignStatus } from '@cti/contracts';
import type { CampaignRow } from '@cti/db';
import { canTransition, pauseReasonAfter, toCampaignDto } from './state.js';

const ALLOWED: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['dry_run', 'archived'],
  dry_run: ['active', 'paused', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'dry_run', 'archived'],
  archived: [],
};
const pairs = CampaignStatus.options.flatMap((from) => CampaignStatus.options.map((to) => [from, to, ALLOWED[from].includes(to)] as const));

describe('canTransition', () => {
  it.each(pairs)('%s → %s: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });
});

describe('pauseReasonAfter', () => {
  it.each([['paused', 'manual'], ['active', null], ['dry_run', null], ['archived', null]] as const)('%s → %s', (to, reason) => {
    expect(pauseReasonAfter(to)).toBe(reason);
  });
});

const row: CampaignRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: 'O1', name: 'Probate leads', sfObject: 'Lead', sourceKind: 'list_view', listViewId: '00B5f00000ABCDE',
  soql: 'SELECT Id FROM Lead', status: 'paused', pauseReason: 'crm_broken', pausedFrom: 'active', refreshMinutes: 240, touchDays: [0, 1, 3, 6, 10, 14], approvalsRemaining: 50,
  playbook: {}, memberCount: 812, lastRefreshedAt: new Date('2026-10-04T10:00:00Z'), lastRefreshError: null, refreshStartedAt: null, tasksCheckedAt: null, mode: 'sequence', createdBy: 'U1',
  createdAt: new Date('2026-10-01T09:00:00Z'), updatedAt: new Date('2026-10-04T10:00:00Z'),
};

describe('toCampaignDto', () => {
  it('maps a list-view campaign to the Campaign contract', () => {
    expect(Campaign.parse(toCampaignDto(row))).toEqual({
      id: row.id, name: 'Probate leads', sfObject: 'Lead', source: { kind: 'list_view', listViewId: '00B5f00000ABCDE' }, status: 'paused',
      pauseReason: 'crm_broken', pausedFrom: 'active', refreshMinutes: 240, touchDays: [0, 1, 3, 6, 10, 14], memberCount: 812,
      lastRefreshedAt: '2026-10-04T10:00:00.000Z', lastRefreshError: null, createdAt: '2026-10-01T09:00:00.000Z',
    });
  });

  it('maps a SOQL campaign with its query and no refresh yet', () => {
    const dto = toCampaignDto({ ...row, sourceKind: 'soql', listViewId: null, soql: "SELECT Id FROM Lead WHERE Status = 'Open'", lastRefreshedAt: null });
    expect(dto.source).toEqual({ kind: 'soql', soql: "SELECT Id FROM Lead WHERE Status = 'Open'" });
    expect(dto.lastRefreshedAt).toBeNull();
  });

  it('carries pausedFrom (null unless paused), and drops a value outside dry_run/active', () => {
    expect(toCampaignDto({ ...row, pausedFrom: 'dry_run' }).pausedFrom).toBe('dry_run');
    expect(toCampaignDto({ ...row, status: 'active', pauseReason: null, pausedFrom: null }).pausedFrom).toBeNull();
    expect(toCampaignDto({ ...row, pausedFrom: 'bogus' as never }).pausedFrom).toBeNull();
  });
});
