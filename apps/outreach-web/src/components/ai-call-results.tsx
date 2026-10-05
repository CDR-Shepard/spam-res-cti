import { useInfiniteQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import type { AiCallResult, AiCallResultsResponse } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CALL_STATUS_WORDS, OUTCOME_WORDS, aiExitWords, notCalledWords, reasonWords } from '@/lib/call-words';
import { getAiCallResults, outreachKeys } from '@/lib/outreach-api';
import { errorText, formatDateTime } from '@/lib/outreach-words';
import { AiCallTranscriptPanel } from './ai-call-transcript';

export const RESULTS_POLL_MS = 15_000;
const LIVE_CALL: ReadonlySet<string> = new Set(['queued', 'ringing', 'in_progress', 'transferring']);
const COLUMNS = 5;

/** Read again every 15 seconds while any call is waiting, being placed, or still live. */
export function resultsPollInterval(pages: readonly AiCallResultsResponse[] | undefined): number | false {
  const busy = (pages ?? []).some((p) =>
    p.items.some((i) => i.touchStatus === 'planned' || i.touchStatus === 'dialing' || (i.callStatus !== null && LIVE_CALL.has(i.callStatus))),
  );
  return busy ? RESULTS_POLL_MS : false;
}

export function AiCallResults({ campaignId }: { campaignId: string }) {
  const results = useInfiniteQuery({
    queryKey: outreachKeys.aiCallResults(campaignId),
    queryFn: ({ pageParam }) => getAiCallResults(campaignId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: (q) => resultsPollInterval(q.state.data?.pages),
  });
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI calls</CardTitle>
        <CardDescription>Every queued call: when it goes out, how it went, and why a lead was not called.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {results.error && <p role="alert" className="text-sm text-destructive">{errorText(results.error)}</p>}
        {results.isPending && <p className="text-sm text-muted-foreground">Loading AI calls…</p>}
        {results.data && items.length === 0 && <p className="text-sm text-muted-foreground">No AI calls yet. Approved leads are queued with Call all approved.</p>}
        {items.length > 0 && <ResultsTable items={items} />}
        {results.hasNextPage && (
          <Button size="sm" variant="outline" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>Load more</Button>
        )}
      </CardContent>
    </Card>
  );
}

function ResultsTable({ items }: { items: AiCallResult[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Lead</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((r) => (
          <Fragment key={r.touchId}>
            <TableRow>
              <TableCell>{r.recordUrl ? <a href={r.recordUrl} target="_blank" rel="noreferrer" className="underline">{r.name ?? r.sfRecordId}</a> : (r.name ?? r.sfRecordId)}</TableCell>
              <TableCell className="whitespace-normal"><StatusCell r={r} /></TableCell>
              <TableCell className="whitespace-normal"><OutcomeCell r={r} /></TableCell>
              <TableCell className="whitespace-normal">
                <SummaryCell r={r} open={open === r.touchId} onToggle={() => setOpen(open === r.touchId ? null : r.touchId)} />
              </TableCell>
              <TableCell>{formatDateTime(r.startedAt ?? r.dueAt)}</TableCell>
            </TableRow>
            {open === r.touchId && r.aiCallId && (
              <TableRow>
                <TableCell colSpan={COLUMNS} className="whitespace-normal"><AiCallTranscriptPanel aiCallId={r.aiCallId} /></TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function StatusCell({ r }: { r: AiCallResult }) {
  switch (r.touchStatus) {
    case 'planned':
      return (
        <div className="space-y-1">
          <p>Waiting — next try {formatDateTime(r.dueAt)}</p>
          <p className="text-xs text-muted-foreground">attempt {r.attempts + 1}{r.lastBlockReason ? ` · last try: ${reasonWords(r.lastBlockReason)}` : ''}</p>
        </div>
      );
    case 'dialing':
      return <p>Calling…</p>;
    case 'sent':
      return <p>{r.callStatus ? CALL_STATUS_WORDS[r.callStatus] : 'Placed'}</p>;
    case 'failed':
      return <p>{notCalledWords(r.lastBlockReason)}</p>;
    default:
      return <p>{aiExitWords(r.exitReason) ?? 'Not called'}</p>;
  }
}

function OutcomeCell({ r }: { r: AiCallResult }) {
  // A refused or skipped touch already says why in its status; a placed one may also have ended the lead.
  const ended = r.touchStatus === 'sent' ? aiExitWords(r.exitReason) : null;
  return (
    <div className="space-y-1">
      {r.outcome && <p>{OUTCOME_WORDS[r.outcome]}</p>}
      {ended && <p className="text-xs text-muted-foreground">{ended}</p>}
    </div>
  );
}

const valueText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

function SummaryCell({ r, open, onToggle }: { r: AiCallResult; open: boolean; onToggle: () => void }) {
  return (
    <div className="space-y-2">
      {r.summary && <p>{r.summary}</p>}
      {r.qualification && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
          {Object.entries(r.qualification).map(([key, value]) => (
            <Fragment key={key}>
              <dt className="text-muted-foreground">{key}:</dt>
              <dd>{valueText(value)}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {r.mayReadTranscript && r.aiCallId && (
        <Button size="sm" variant="outline" onClick={onToggle}>{open ? 'Hide transcript' : 'Transcript'}</Button>
      )}
    </div>
  );
}
