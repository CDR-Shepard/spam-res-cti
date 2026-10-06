import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { AiCallResult, AiCallResultsResponse } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CALL_STATUS_WORDS, OUTCOME_WORDS, aiExitWords, appointmentWords, notCalledWords, reasonWords } from '@/lib/call-words';
import { getAiCallResults, outreachKeys } from '@/lib/outreach-api';
import { errorText, formatDateTime } from '@/lib/outreach-words';
import { AiCallTranscriptPanel } from './ai-call-transcript';
import { WritebackBadge, WritebackChanges, writebackStatusWords } from './writeback-changes';

export const RESULTS_POLL_MS = 15_000;
const LIVE_CALL: ReadonlySet<string> = new Set(['queued', 'ringing', 'in_progress', 'transferring']);
const COLUMNS = 7;
/** A deep-linked call (`?call=`) not on the pages read so far: read on, at most this many pages. */
const FOCUS_MAX_PAGES = 10;

const isBusy = (i: AiCallResult): boolean =>
  i.touchStatus === 'planned' || i.touchStatus === 'dialing' || (i.callStatus !== null && LIVE_CALL.has(i.callStatus));

/**
 * Read again every 15 seconds while any call is waiting, being placed, or still live. After a deep link read more than one
 * page (final review m12), a poll would re-read every one of them: only the linked call, once found, keeps it going.
 */
export function resultsPollInterval(pages: readonly AiCallResultsResponse[] | undefined, focusCallId: string | null = null): number | false {
  const items = (pages ?? []).flatMap((p) => p.items);
  const watched = focusCallId !== null && (pages?.length ?? 0) > 1 ? items.filter((i) => i.aiCallId === focusCallId) : items;
  return watched.some(isBusy) ? RESULTS_POLL_MS : false;
}

/**
 * `focusCallId` (plan 1D): the call the page was opened for (`?call=`, the link the Chatter post carries). Its row is marked,
 * scrolled to, and opens with its transcript and write-back; later pages are read until it is found.
 */
export function AiCallResults({ campaignId, focusCallId = null }: { campaignId: string; focusCallId?: string | null }) {
  const qc = useQueryClient();
  const results = useInfiniteQuery({
    queryKey: outreachKeys.aiCallResults(campaignId),
    queryFn: ({ pageParam }) => getAiCallResults(campaignId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: (q) => resultsPollInterval(q.state.data?.pages, focusCallId),
  });
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];
  const found = focusCallId !== null && items.some((i) => i.aiCallId === focusCallId);
  const pages = results.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = results;
  useEffect(() => {
    if (focusCallId && !found && hasNextPage && !isFetchingNextPage && pages < FOCUS_MAX_PAGES) void fetchNextPage();
  }, [focusCallId, found, hasNextPage, isFetchingNextPage, pages, fetchNextPage]);
  // P6 M-4: every page there is (or the cap) read and the linked call is not on them: said, never a silent nothing.
  const notFound = focusCallId !== null && results.data !== undefined && !found && !isFetchingNextPage && (!hasNextPage || pages >= FOCUS_MAX_PAGES);
  const refetch = () => void qc.invalidateQueries({ queryKey: outreachKeys.aiCallResults(campaignId) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI calls</CardTitle>
        <CardDescription>Every queued call: when it goes out, how it went, and why a lead was not called.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {results.error && <p role="alert" className="text-sm text-destructive">{errorText(results.error)}</p>}
        {results.isPending && <p className="text-sm text-muted-foreground">Loading AI calls…</p>}
        {notFound && <p role="status" className="text-sm text-muted-foreground">That call isn&apos;t in the latest results.</p>}
        {results.data && items.length === 0 && <p className="text-sm text-muted-foreground">No AI calls yet. Approved leads are queued with Call all approved.</p>}
        {items.length > 0 && <ResultsTable items={items} focusCallId={focusCallId} onRetried={refetch} />}
        {results.hasNextPage && (
          <Button size="sm" variant="outline" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>Load more</Button>
        )}
      </CardContent>
    </Card>
  );
}

type Panel = 'transcript' | 'writeback';

function ResultsTable({ items, focusCallId, onRetried }: { items: AiCallResult[]; focusCallId: string | null; onRetried: () => void }) {
  // Which panels are open, by touch id. The deep-linked call starts with both open (once it is on the page).
  const [open, setOpen] = useState<Record<string, Set<Panel>>>({});
  const focused = items.find((i) => focusCallId !== null && i.aiCallId === focusCallId) ?? null;
  const focusRef = useRef<HTMLTableRowElement | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (!focused || opened.current) return;
    opened.current = true;
    setOpen((o) => ({ ...o, [focused.touchId]: new Set<Panel>([...(focused.mayReadTranscript ? ['transcript' as const] : []), ...(focused.writeback ? ['writeback' as const] : [])]) }));
    focusRef.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);
  const isOpen = (r: AiCallResult, p: Panel): boolean => open[r.touchId]?.has(p) ?? false;
  const toggle = (r: AiCallResult, p: Panel) =>
    setOpen((o) => {
      const next = new Set(o[r.touchId]);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return { ...o, [r.touchId]: next };
    });
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Lead</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead>Appointment</TableHead>
          <TableHead>Salesforce</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((r) => (
          <Fragment key={r.touchId}>
            <TableRow ref={r === focused ? focusRef : undefined} aria-current={r === focused ? 'true' : undefined} className={r === focused ? 'bg-muted' : undefined}>
              <TableCell>{r.recordUrl ? <a href={r.recordUrl} target="_blank" rel="noreferrer" className="underline">{r.name ?? r.sfRecordId}</a> : (r.name ?? r.sfRecordId)}</TableCell>
              <TableCell className="whitespace-normal"><StatusCell r={r} /></TableCell>
              <TableCell className="whitespace-normal"><OutcomeCell r={r} /></TableCell>
              <TableCell className="whitespace-normal">
                <SummaryCell r={r} open={isOpen(r, 'transcript')} onToggle={() => toggle(r, 'transcript')} />
              </TableCell>
              <TableCell className="whitespace-normal">{r.appointment ? appointmentWords(r.appointment) : null}</TableCell>
              <TableCell className="whitespace-normal"><SalesforceCell r={r} open={isOpen(r, 'writeback')} onToggle={() => toggle(r, 'writeback')} /></TableCell>
              <TableCell>{formatDateTime(r.startedAt ?? r.dueAt)}</TableCell>
            </TableRow>
            {isOpen(r, 'writeback') && r.writeback && r.aiCallId && (
              <TableRow>
                <TableCell colSpan={COLUMNS} className="whitespace-normal"><WritebackChanges summary={r.writeback} aiCallId={r.aiCallId} onRetried={onRetried} /></TableCell>
              </TableRow>
            )}
            {isOpen(r, 'transcript') && r.aiCallId && (
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

/** The write-back's status (a button that opens what was written) and, after a Lead conversion, a link to the new record. */
function SalesforceCell({ r, open, onToggle }: { r: AiCallResult; open: boolean; onToggle: () => void }) {
  const w = r.writeback;
  if (!w) return null;
  const oppUrl = w.convertedOpportunityUrl;
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="cursor-pointer"
        aria-expanded={open}
        aria-label={`Salesforce write-back: ${writebackStatusWords(w.status)}, ${open ? 'hide' : 'show'} what was written`}
        onClick={onToggle}
      >
        <WritebackBadge status={w.status} />
      </button>
      {w.convertedOpportunityId && (
        <p className="text-xs">{oppUrl ? <a href={oppUrl} target="_blank" rel="noreferrer" className="underline">Converted to Opportunity</a> : 'Converted to Opportunity'}</p>
      )}
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
        <Button size="sm" variant="outline" aria-expanded={open} onClick={onToggle}>{open ? 'Hide transcript' : 'Transcript'}</Button>
      )}
    </div>
  );
}
