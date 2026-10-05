import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { CampaignBuilder } from '@/components/campaign-builder';

export const Route = createFileRoute('/_authenticated/campaigns/new')({ component: NewCampaignRoute });

function NewCampaignRoute() {
  const navigate = useNavigate();
  return <CampaignBuilder onCreated={(c) => void navigate({ to: '/campaigns/$campaignId', params: { campaignId: c.id } })} />;
}
