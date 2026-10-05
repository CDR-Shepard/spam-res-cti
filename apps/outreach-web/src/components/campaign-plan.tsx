import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { EnrollmentStatus, type CampaignPlanResponse, type PlanRow } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getPlan, outreachKeys } from '@/lib/outreach-api';
import {
  CONTACT_CHANNEL_WORDS,
  ENROLLMENT_STATUS_WORDS,
  enrollmentStatusWords,
  errorText,
  formatCount,
  formatDateTime,
  gateStepWords,
  humanize,
  TOUCH_CHANNEL_WORDS,
  TOUCH_STATUS_WORDS,
} from '@/lib/outreach-words';

export function CampaignPlan({ campaignId }: { campaignId: string }) {
  const plan = useInfiniteQuery({
    queryKey: outreachKeys.plan(campaignId),
    queryFn: ({ pageParam }) => getPlan(campaignId, { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = plan.data?.pages.flatMap((p) => p.rows) ?? [];
  const counts = plan.data?.pages[0]?.counts;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan</CardTitle>
        <CardDescription>Everyone in the campaign and what happens next for each person.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {plan.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {plan.error && <p role="alert" className="text-sm text-destructive">{errorText(plan.error)}</p>}
        {counts && <StatusCounts counts={counts} />}
        {plan.data && rows.length === 0 && <p className="text-sm text-muted-foreground">Nobody is enrolled yet. People join on the next refresh.</p>}
        {rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead><span className="sr-only">Details</span></TableHead>
                <TableHead>Name</TableHead><TableHead>Owner</TableHead><TableHead>Status</TableHead><TableHead>Triage</TableHead><TableHead>Next touch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{rows.map((r) => <PlanRowView key={r.enrollmentId} row={r} />)}</TableBody>
          </Table>
        )}
        {plan.hasNextPage && (
          <Button variant="outline" size="sm" disabled={plan.isFetchingNextPage} onClick={() => void plan.fetchNextPage()}>Load more</Button>
        )}
      </CardContent>
    </Card>
  );
}

function StatusCounts({ counts }: { counts: CampaignPlanResponse['counts'] }) {
  return (
    <ul aria-label="People by status" className="flex flex-wrap gap-2">
      {EnrollmentStatus.options.map((s) => (
        <li key={s}><Badge variant="outline">{ENROLLMENT_STATUS_WORDS[s]} {formatCount(counts[s] ?? 0)}</Badge></li>
      ))}
    </ul>
  );
}

function PlanRowView({ row }: { row: PlanRow }) {
  const [open, setOpen] = useState(false);
  const label = row.name ?? row.sfRecordId;
  const touch = row.nextTouch;
  return (
    <>
      <TableRow>
        <TableCell>
          <Button variant="ghost" size="icon-xs" aria-expanded={open} aria-label={`Details for ${label}`} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        </TableCell>
        <TableCell>{label}</TableCell>
        <TableCell>{row.ownerName ?? '—'}</TableCell>
        <TableCell>{enrollmentStatusWords(row.status, row.exitReason)}</TableCell>
        <TableCell className="max-w-xs whitespace-normal">{row.triage?.summary ?? 'Not triaged yet'}</TableCell>
        <TableCell className="whitespace-normal">
          {touch ? `${TOUCH_CHANNEL_WORDS[touch.channel]} · ${formatDateTime(touch.dueAt)} · ${TOUCH_STATUS_WORDS[touch.status]}` : '—'}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/30 whitespace-normal"><PlanRowDetails row={row} label={label} /></TableCell>
        </TableRow>
      )}
    </>
  );
}

function PlanRowDetails({ row, label }: { row: PlanRow; label: string }) {
  const triage = row.triage;
  const audit = row.nextTouch?.gateAudit ?? [];
  return (
    <div className="grid gap-4 py-2 md:grid-cols-2">
      <div className="space-y-2">
        <p className="text-sm font-medium">What the notes say</p>
        {!triage && <p className="text-sm text-muted-foreground">Not triaged yet.</p>}
        {triage && triage.channels.length === 0 && <p className="text-sm text-muted-foreground">No channel preference in the notes, so the campaign's default order is used.</p>}
        {triage && triage.channels.length > 0 && (
          <ul aria-label={`Triage reasons for ${label}`} className="space-y-1 text-sm">
            {triage.channels.map((c, i) => <li key={i}><span className="font-medium">{CONTACT_CHANNEL_WORDS[c.channel]}:</span> {c.reason}</li>)}
          </ul>
        )}
        {triage?.timing && <p className="text-sm">Timing: {triage.timing}</p>}
        {triage && triage.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">{triage.tags.map((t) => <Badge key={t} variant="outline">{humanize(t)}</Badge>)}</div>
        )}
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">How the next touch was chosen</p>
        {audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No checks recorded yet.</p>
        ) : (
          <ol aria-label={`Gate checks for ${label}`} className="list-decimal space-y-1 pl-5 text-sm">
            {audit.map((step, i) => <li key={i}>{gateStepWords(step)}</li>)}
          </ol>
        )}
      </div>
    </div>
  );
}
