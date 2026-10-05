import { createFileRoute } from '@tanstack/react-router';
import { CampaignDetail } from '@/components/campaign-detail';

export const Route = createFileRoute('/_authenticated/campaigns/$campaignId')({ component: CampaignDetailRoute });

function CampaignDetailRoute() {
  const { campaignId } = Route.useParams();
  // Keyed so moving between campaigns starts each page with fresh local state.
  return <CampaignDetail key={campaignId} campaignId={campaignId} />;
}
