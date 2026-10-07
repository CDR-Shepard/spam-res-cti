import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import type { Campaign } from '@cti/contracts';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/lib/auth';
import { listCampaigns, outreachKeys } from '@/lib/outreach-api';
import { errorText, formatCount, formatDateTime, pauseReasonWords, SF_OBJECT_WORDS } from '@/lib/outreach-words';
import { CampaignStatusBadge } from './campaign-status-badge';

export function CampaignsPage() {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  const archivedId = useId();
  const [showArchived, setShowArchived] = useState(false);
  const campaigns = useQuery({ queryKey: outreachKeys.campaignList(showArchived), queryFn: () => listCampaigns({ archived: showArchived }) });
  const rows = campaigns.data?.campaigns;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        actions={isAdmin && <Button asChild><Link to="/campaigns/new"><Plus aria-hidden />New campaign</Link></Button>}
      />
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <input id={archivedId} type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            <label htmlFor={archivedId} className="cursor-pointer select-none">Include archived</label>
          </div>
          {campaigns.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {campaigns.error && <p role="alert" className="text-sm text-destructive">{errorText(campaigns.error)}</p>}
          {rows && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">No campaigns yet.{isAdmin ? ' Start one from a Salesforce list view or a SOQL query.' : ''}</p>
          )}
          {rows && rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Name</TableHead><TableHead>Records</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Members</TableHead><TableHead>Last refreshed</TableHead></TableRow>
              </TableHeader>
              <TableBody>{rows.map((c) => <CampaignRow key={c.id} campaign={c} />)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CampaignRow({ campaign: c }: { campaign: Campaign }) {
  return (
    <TableRow>
      <TableCell><Link to="/campaigns/$campaignId" params={{ campaignId: c.id }} className="font-medium underline-offset-4 hover:underline">{c.name}</Link></TableCell>
      <TableCell className="text-muted-foreground">{SF_OBJECT_WORDS[c.sfObject]}</TableCell>
      <TableCell className="whitespace-normal">
        <CampaignStatusBadge status={c.status} />
        {c.status === 'paused' && <p className="mt-1 text-xs text-muted-foreground">{pauseReasonWords(c.pauseReason)}</p>}
        {c.lastRefreshError && <p className="mt-1 text-xs text-destructive">Last refresh failed</p>}
      </TableCell>
      <TableCell className="text-right">{formatCount(c.memberCount)}</TableCell>
      <TableCell className="text-muted-foreground">{c.lastRefreshedAt ? formatDateTime(c.lastRefreshedAt) : 'Never'}</TableCell>
    </TableRow>
  );
}
