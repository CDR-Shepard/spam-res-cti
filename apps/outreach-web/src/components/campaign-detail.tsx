import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CirclePause, Info, TriangleAlert } from 'lucide-react';
import type { Campaign } from '@cti/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { StatGrid, StatTile } from '@/components/layout/stat-tile';
import { useAuth } from '@/lib/auth';
import { getCampaign, outreachKeys } from '@/lib/outreach-api';
import { errorText, formatCount, formatDateTime, pauseReasonWords, SF_OBJECT_WORDS } from '@/lib/outreach-words';
import { AiCallResults } from './ai-call-results';
import { CallPlanBoard } from './call-plan-board';
import { CampaignPlan } from './campaign-plan';
import { CampaignSettings } from './campaign-settings';
import { CampaignStatusActions } from './campaign-status-actions';
import { CampaignStatusBadge } from './campaign-status-badge';
import { LeadPicker } from './lead-picker';
import { PracticeCalls } from './practice-calls';

const DRY_RUN_WORDS: Record<Campaign['mode'], string> = {
  sequence: 'Dry run: the plan below shows what would happen. Nothing is sent and no calls are queued.',
  ai_call: 'Dry run: picked leads are researched and call plans are written for review. No calls are placed.',
};

/** `focusCallId`: the AI call the page was opened for (`?call=`, the Chatter post's "Call details" link). */
export function CampaignDetail({ campaignId, focusCallId = null }: { campaignId: string; focusCallId?: string | null }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  const campaign = useQuery({ queryKey: outreachKeys.campaign(campaignId), queryFn: () => getCampaign(campaignId) });
  if (campaign.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (campaign.error) return <p role="alert" className="text-sm text-destructive">{errorText(campaign.error)}</p>;
  const c = campaign.data;
  return (
    <div className="space-y-8">
      <CampaignHeader campaign={c} isAdmin={isAdmin} />
      <CampaignBanners campaign={c} />
      <CampaignSettings campaign={c} canEdit={isAdmin && c.status !== 'archived'} />
      {c.mode === 'ai_call' ? <AiCallSections campaign={c} isAdmin={isAdmin} focusCallId={focusCallId} /> : <CampaignPlan campaignId={c.id} />}
    </div>
  );
}

function AiCallSections({ campaign: c, isAdmin, focusCallId }: { campaign: Campaign; isAdmin: boolean; focusCallId: string | null }) {
  return (
    <>
      <LeadPicker campaignId={c.id} canEdit={isAdmin && c.status !== 'archived'} />
      <CallPlanBoard campaign={c} isAdmin={isAdmin} />
      {isAdmin && <PracticeCalls campaignId={c.id} />}
      <AiCallResults campaignId={c.id} focusCallId={focusCallId} />
    </>
  );
}

function CampaignHeader({ campaign: c, isAdmin }: { campaign: Campaign; isAdmin: boolean }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Link to="/campaigns" className="rounded-sm transition-colors duration-150 hover:text-foreground">← Campaigns</Link>}
        title={c.name}
        meta={<CampaignStatusBadge status={c.status} />}
        description={<>{SF_OBJECT_WORDS[c.sfObject]} from {c.source.kind === 'list_view' ? 'a Salesforce list view' : 'a SOQL query'} · {formatCount(c.memberCount)} members · last refreshed {c.lastRefreshedAt ? formatDateTime(c.lastRefreshedAt) : 'never'}</>}
        actions={isAdmin && <CampaignStatusActions campaign={c} />}
      >
        {c.source.kind === 'soql' && (
          <details className="text-[13px]">
            <summary className="text-muted-foreground">Show query</summary>
            <pre className="mt-2 overflow-x-auto rounded-lg border bg-card p-3 font-mono text-xs leading-5">{c.source.soql}</pre>
          </details>
        )}
      </PageHeader>
      <StatGrid>
        <StatTile label="Members" value={formatCount(c.memberCount)} />
        <StatTile label="Records" value={SF_OBJECT_WORDS[c.sfObject]} size="md" />
        <StatTile label="Last refreshed" value={c.lastRefreshedAt ? formatDateTime(c.lastRefreshedAt) : 'Never'} size="md" className="col-span-2 sm:col-span-1" />
      </StatGrid>
    </div>
  );
}

const BANNER = 'flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-6';

function CampaignBanners({ campaign: c }: { campaign: Campaign }) {
  return (
    <>
      {c.status === 'paused' && (
        <div role="status" className={`${BANNER} border-warning/25 bg-warning-soft`}><CirclePause aria-hidden className="mt-1 size-4 shrink-0 text-warning" />{pauseReasonWords(c.pauseReason)}</div>
      )}
      {c.status === 'dry_run' && (
        <div role="status" className={`${BANNER} bg-card`}><Info aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />{DRY_RUN_WORDS[c.mode]}</div>
      )}
      {c.lastRefreshError && (
        <div role="alert" className={`${BANNER} border-destructive/30 bg-danger-soft text-destructive`}><TriangleAlert aria-hidden className="mt-1 size-4 shrink-0" />The last Salesforce refresh failed: {c.lastRefreshError}</div>
      )}
    </>
  );
}
