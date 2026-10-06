import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import type { PracticeCall, PracticeCallsResponse } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CALL_STATUS_WORDS, OUTCOME_WORDS, appointmentWords, practiceAnswerWords } from '@/lib/call-words';
import { outreachKeys, practiceCalls } from '@/lib/outreach-api';
import { errorText, formatDateTime } from '@/lib/outreach-words';
import { AiCallTranscriptPanel } from './ai-call-transcript';

export const PRACTICE_POLL_MS = 15_000;
const LIVE_CALL: ReadonlySet<string> = new Set(['queued', 'ringing', 'in_progress', 'transferring']);
const COLUMNS = 4;

/** Read again every 15 seconds while a practice call is still ringing or live. */
export function practicePollInterval(data: PracticeCallsResponse | undefined): number | false {
  return data?.items.some((i) => i.callStatus !== null && LIVE_CALL.has(i.callStatus)) ? PRACTICE_POLL_MS : false;
}

/**
 * "Practice calls" (admins, plan 1D): the campaign's latest practice calls, above the results. Each says what the agent would
 * have booked; nothing of it reached Salesforce. Hidden while there are none.
 */
export function PracticeCalls({ campaignId }: { campaignId: string }) {
  const list = useQuery({
    queryKey: outreachKeys.practiceCalls(campaignId),
    queryFn: () => practiceCalls(campaignId),
    refetchInterval: (q) => practicePollInterval(q.state.data),
  });
  const items = list.data?.items ?? [];
  if (!list.error && items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>Practice calls</CardTitle>
        <CardDescription>Calls to a test phone with a real lead's plan. Nothing was booked, converted or written in Salesforce.</CardDescription>
      </CardHeader>
      <CardContent>
        {list.error && <p role="alert" className="text-sm text-destructive">{errorText(list.error)}</p>}
        {items.length > 0 && <PracticeTable items={items} />}
      </CardContent>
    </Card>
  );
}

function PracticeTable({ items }: { items: PracticeCall[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Lead</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Summary</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((p) => (
          <Fragment key={p.id}>
            <TableRow>
              <TableCell>{formatDateTime(p.createdAt)}</TableCell>
              <TableCell>{p.name ?? p.sfRecordId}<span className="text-xs text-muted-foreground"> · plan v{p.planVersion}</span></TableCell>
              <TableCell className="whitespace-normal"><OutcomeCell p={p} /></TableCell>
              <TableCell className="whitespace-normal space-y-2">
                {p.summary && <p>{p.summary}</p>}
                {p.aiCallId && p.result?.result === 'placed' && (
                  <Button size="sm" variant="outline" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide transcript' : 'Transcript'}</Button>
                )}
              </TableCell>
            </TableRow>
            {open === p.id && p.aiCallId && (
              <TableRow>
                <TableCell colSpan={COLUMNS} className="whitespace-normal"><AiCallTranscriptPanel aiCallId={p.aiCallId} /></TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function OutcomeCell({ p }: { p: PracticeCall }) {
  if (p.result === null) return <p className="text-muted-foreground">No answer from the AI calling service</p>;
  if (p.result.result !== 'placed') return <p>{practiceAnswerWords(p.result)}</p>;
  return (
    <div className="space-y-1">
      <p>{p.outcome ? OUTCOME_WORDS[p.outcome] : p.callStatus ? CALL_STATUS_WORDS[p.callStatus] : 'Placed'}</p>
      {p.appointment && <p className="text-xs">Would have booked: {appointmentWords(p.appointment)}</p>}
    </div>
  );
}
