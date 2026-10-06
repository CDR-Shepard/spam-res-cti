import { createFileRoute } from '@tanstack/react-router';
import { CampaignDetail } from '@/components/campaign-detail';
import { callSearch } from '@/lib/call-words';

// `?call=<AI call id>` (plan 1D): the Chatter post's "Call details" link opens that call on the results.
export const Route = createFileRoute('/_authenticated/campaigns/$campaignId')({ component: CampaignDetailRoute, validateSearch: callSearch });

function CampaignDetailRoute() {
  const { campaignId } = Route.useParams();
  const { call } = Route.useSearch();
  // Keyed so moving between campaigns starts each page with fresh local state.
  return <CampaignDetail key={campaignId} campaignId={campaignId} focusCallId={call ?? null} />;
}
