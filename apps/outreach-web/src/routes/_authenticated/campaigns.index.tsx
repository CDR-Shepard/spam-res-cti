import { createFileRoute } from '@tanstack/react-router';
import { CampaignsPage } from '@/components/campaigns-page';

export const Route = createFileRoute('/_authenticated/campaigns/')({ component: CampaignsPage });
