import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Campaign } from '@cti/contracts';
import { getCampaign, outreachKeys } from '@/lib/outreach-api';
import { errorText, formatCount, formatDateTime, SF_OBJECT_WORDS } from '@/lib/outreach-words';
import { CampaignStatusBadge } from './campaign-status-badge';

export function CampaignDetail({ campaignId }: { campaignId: string }) {
  const campaign = useQuery({ queryKey: outreachKeys.campaign(campaignId), queryFn: () => getCampaign(campaignId) });
  if (campaign.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (campaign.error) return <p role="alert" className="text-sm text-destructive">{errorText(campaign.error)}</p>;
  return (
    <div className="space-y-6">
      <CampaignHeader campaign={campaign.data} />
    </div>
  );
}

function CampaignHeader({ campaign: c }: { campaign: Campaign }) {
  return (
    <div className="space-y-2">
      <Link to="/campaigns" className="text-sm text-muted-foreground hover:underline">← Campaigns</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{c.name}</h1>
        <CampaignStatusBadge status={c.status} />
      </div>
      <p className="text-sm text-muted-foreground">
        {SF_OBJECT_WORDS[c.sfObject]} from {c.source.kind === 'list_view' ? 'a Salesforce list view' : 'a SOQL query'} · {formatCount(c.memberCount)} members · last refreshed {c.lastRefreshedAt ? formatDateTime(c.lastRefreshedAt) : 'never'}
      </p>
      {c.source.kind === 'soql' && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Show query</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">{c.source.soql}</pre>
        </details>
      )}
    </div>
  );
}
