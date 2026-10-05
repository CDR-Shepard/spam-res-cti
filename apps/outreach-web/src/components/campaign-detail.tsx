import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Campaign } from '@cti/contracts';
import { useAuth } from '@/lib/auth';
import { getCampaign, outreachKeys } from '@/lib/outreach-api';
import { errorText, formatCount, formatDateTime, pauseReasonWords, SF_OBJECT_WORDS } from '@/lib/outreach-words';
import { CampaignPlan } from './campaign-plan';
import { CampaignSettings } from './campaign-settings';
import { CampaignStatusActions } from './campaign-status-actions';
import { CampaignStatusBadge } from './campaign-status-badge';
import { LeadPicker } from './lead-picker';

const DRY_RUN_WORDS: Record<Campaign['mode'], string> = {
  sequence: 'Dry run: the plan below shows what would happen. Nothing is sent and no calls are queued.',
  ai_call: 'Dry run: picked leads are researched and call plans are written for review. No calls are placed.',
};

export function CampaignDetail({ campaignId }: { campaignId: string }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  const campaign = useQuery({ queryKey: outreachKeys.campaign(campaignId), queryFn: () => getCampaign(campaignId) });
  if (campaign.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (campaign.error) return <p role="alert" className="text-sm text-destructive">{errorText(campaign.error)}</p>;
  const c = campaign.data;
  return (
    <div className="space-y-6">
      <CampaignHeader campaign={c} isAdmin={isAdmin} />
      <CampaignBanners campaign={c} />
      <CampaignSettings campaign={c} canEdit={isAdmin && c.status !== 'archived'} />
      {c.mode === 'ai_call' ? <LeadPicker campaignId={c.id} canEdit={isAdmin && c.status !== 'archived'} /> : <CampaignPlan campaignId={c.id} />}
    </div>
  );
}

function CampaignHeader({ campaign: c, isAdmin }: { campaign: Campaign; isAdmin: boolean }) {
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
      {isAdmin && <CampaignStatusActions campaign={c} />}
    </div>
  );
}

function CampaignBanners({ campaign: c }: { campaign: Campaign }) {
  return (
    <>
      {c.status === 'paused' && (
        <div role="status" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{pauseReasonWords(c.pauseReason)}</div>
      )}
      {c.status === 'dry_run' && (
        <div role="status" className="rounded-md border p-3 text-sm">{DRY_RUN_WORDS[c.mode]}</div>
      )}
      {c.lastRefreshError && (
        <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">The last Salesforce refresh failed: {c.lastRefreshError}</div>
      )}
    </>
  );
}
