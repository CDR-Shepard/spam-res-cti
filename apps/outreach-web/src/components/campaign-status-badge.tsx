import type { CampaignStatus } from '@cti/contracts';
import { CAMPAIGN_STATUS_WORDS } from '@/lib/outreach-words';
import { StatusBadge, type StatusTone } from './layout/status-badge';

const TONE: Record<CampaignStatus, StatusTone> = {
  draft: 'neutral',
  dry_run: 'outline',
  active: 'success',
  paused: 'warning',
  archived: 'neutral',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <StatusBadge tone={TONE[status]}>{CAMPAIGN_STATUS_WORDS[status]}</StatusBadge>;
}
