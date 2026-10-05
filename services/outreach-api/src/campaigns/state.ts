import type { Campaign, CampaignStatus } from '@cti/contracts';
import type { CampaignRow } from '@cti/db';

/**
 * draft → dry_run → active ⇄ paused → archived (spec §6.4). A paused campaign
 * may also drop back to dry_run, and a draft may be discarded (archived).
 */
const TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ['dry_run', 'archived'],
  dry_run: ['active', 'paused', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'dry_run', 'archived'],
  archived: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** An admin's pause is `manual`; leaving paused (or never entering it) clears the reason. System pauses (crm_broken, ai_budget, kill_switch) are set by jobs, not here. */
export function pauseReasonAfter(to: CampaignStatus): string | null {
  return to === 'paused' ? 'manual' : null;
}

export function toCampaignDto(row: CampaignRow): Campaign {
  const source: Campaign['source'] = row.sourceKind === 'list_view' && row.listViewId
    ? { kind: 'list_view', listViewId: row.listViewId }
    : { kind: 'soql', soql: row.soql };
  return {
    id: row.id,
    name: row.name,
    sfObject: row.sfObject,
    source,
    status: row.status,
    pauseReason: row.pauseReason,
    refreshMinutes: row.refreshMinutes,
    touchDays: row.touchDays,
    memberCount: row.memberCount,
    lastRefreshedAt: row.lastRefreshedAt ? row.lastRefreshedAt.toISOString() : null,
    lastRefreshError: row.lastRefreshError,
    createdAt: row.createdAt.toISOString(),
  };
}
