import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CallStage, type Campaign } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CALL_STAGE_WORDS } from '@/lib/call-words';
import { getCallPlans, outreachKeys, releaseCalls } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { CallPlanCardView } from './call-plan-card';

/** Stages the board lists; `done` leads have left the campaign. */
const BOARD_STAGES = CallStage.options.filter((s) => s !== 'done');
const POLL_MS = 15_000;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** A segmented-control look for the stage filter: the picked stage is a white pill on the gray track. */
const segment = (on: boolean): string => (on ? 'h-7 bg-card font-semibold shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(15_15_14/0.06)] hover:bg-card' : 'h-7 text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground');

export function CallPlanBoard({ campaign, isAdmin }: { campaign: Campaign; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<CallStage | null>(null);
  const board = useInfiniteQuery({
    queryKey: outreachKeys.callPlans(campaign.id, stage),
    queryFn: ({ pageParam }) => getCallPlans(campaign.id, { cursor: pageParam, stage }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Leads still being researched turn into plans on their own: read again until none is left.
    refetchInterval: (q) => ((q.state.data?.pages[0]?.counts.research ?? 0) > 0 ? POLL_MS : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: outreachKeys.callPlanLists(campaign.id) });
    void qc.invalidateQueries({ queryKey: outreachKeys.campaign(campaign.id) });
  };
  const release = useMutation({ mutationFn: () => releaseCalls(campaign.id), onSuccess: refresh });
  const counts = board.data?.pages[0]?.counts;
  const cards = board.data?.pages.flatMap((p) => p.cards) ?? [];
  const approved = counts?.approved ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Call plans</CardTitle>
        <CardDescription>Each lead is researched in Salesforce and given a plan. Read it, edit it if you like, and approve it. Approving does not place a call.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {counts && <p className="text-[13px] text-muted-foreground tabular-nums">{BOARD_STAGES.map((s) => `${counts[s] ?? 0} ${CALL_STAGE_WORDS[s]}`).join(' · ')}</p>}
        <div className="flex max-w-full flex-wrap items-center gap-1 rounded-lg border bg-secondary p-1 sm:w-fit">
          <Button size="sm" variant="ghost" className={segment(stage === null)} onClick={() => setStage(null)}>All</Button>
          {BOARD_STAGES.map((s) => (
            <Button key={s} size="sm" variant="ghost" className={segment(stage === s)} onClick={() => setStage(s)}>{CALL_STAGE_WORDS[s]} <span className="tabular-nums">({counts?.[s] ?? 0})</span></Button>
          ))}
        </div>
        {isAdmin && campaign.status === 'active' && (
          <Button size="sm" disabled={release.isPending || approved === 0} onClick={() => release.mutate()}>Call all approved ({approved})</Button>
        )}
        {isAdmin && campaign.status === 'dry_run' && <p className="text-sm text-muted-foreground">Activate the campaign to place calls.</p>}
        {release.data && <p role="status" className="text-sm">{plural(release.data.released, 'call', 'calls')} queued. {release.data.skipped} skipped.</p>}
        {release.data?.more && <p role="status" className="text-sm text-muted-foreground">More approved leads are waiting. Press Call all approved again.</p>}
        {release.error && <p role="alert" className="text-sm text-destructive">{errorText(release.error)}</p>}
        {board.error && <p role="alert" className="text-sm text-destructive">{errorText(board.error)}</p>}
        {board.isPending && <p className="text-sm text-muted-foreground">Loading call plans…</p>}
        {board.data && cards.length === 0 && <p className="text-sm text-muted-foreground">No leads here yet. Tick leads above; they are researched at the next refresh.</p>}
        <div className="space-y-3">{cards.map((card) => <CallPlanCardView key={card.enrollmentId} card={card} onChanged={refresh} campaignId={campaign.id} />)}</div>
        {board.hasNextPage && <Button size="sm" variant="outline" disabled={board.isFetchingNextPage} onClick={() => void board.fetchNextPage()}>Load more</Button>}
      </CardContent>
    </Card>
  );
}
