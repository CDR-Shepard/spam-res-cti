import type { CampaignStatus } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { CAMPAIGN_STATUS_WORDS } from '@/lib/outreach-words';

const VARIANT: Record<CampaignStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  draft: 'outline',
  dry_run: 'secondary',
  active: 'default',
  paused: 'destructive',
  archived: 'outline',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge variant={VARIANT[status]}>{CAMPAIGN_STATUS_WORDS[status]}</Badge>;
}
