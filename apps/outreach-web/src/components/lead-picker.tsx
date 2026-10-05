import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CandidateRecord, SelectionChange } from '@cti/contracts';
import { ConfirmAction } from '@/components/confirm-action';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { changeSelection, getCandidates, outreachKeys } from '@/lib/outreach-api';
import { enrollmentStatusWords, errorText, formatCount, SKIP_REASON_WORDS } from '@/lib/outreach-words';

interface RowView {
  /** The checkbox can be changed. */
  editable: boolean;
  checked: boolean;
  /** What the refresh will do, or why the row is locked. */
  note: string;
}

/**
 * How one candidate shows. A lead still `active` can be unticked (the refresh stops it as
 * `deselected`). One held for review is never exited by a deselection, so it is locked. An
 * exit that was a deselection is a plain candidate again; any other exit is final.
 */
function rowView(r: CandidateRecord): RowView {
  if (!r.enrolled) {
    const note = r.skipReason ? `Skipped: ${SKIP_REASON_WORDS[r.skipReason]}` : r.selected && r.enrollmentStatus === 'exited' ? 'Re-enrolls at the next refresh' : '';
    return { editable: r.skipReason === null, checked: r.selected, note };
  }
  switch (r.enrollmentStatus) {
    case 'active':
      return { editable: true, checked: r.selected, note: r.selected ? 'Enrolled' : 'Stops at the next refresh' };
    case 'needs_review':
      return { editable: false, checked: true, note: 'Held for review' };
    case 'exited':
      return { editable: false, checked: false, note: enrollmentStatusWords('exited', r.exitReason) };
    case null:
      return { editable: false, checked: true, note: 'Enrolled' };
    default:
      return { editable: false, checked: r.selected, note: enrollmentStatusWords(r.enrollmentStatus, null) };
  }
}

const plural = (n: number, one: string, many: string): string => `${formatCount(n)} ${n === 1 ? one : many}`;

export function LeadPicker({ campaignId, canEdit }: { campaignId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const data = useQuery({ queryKey: outreachKeys.candidates(campaignId, page), queryFn: () => getCandidates(campaignId, page) });
  const change = useMutation({
    mutationFn: (c: Partial<SelectionChange>) => changeSelection(campaignId, c),
    onSuccess: () => void qc.invalidateQueries({ queryKey: outreachKeys.candidateLists(campaignId) }),
  });
  const p = data.data;
  const busy = !canEdit || change.isPending;
  const addable = (p?.records ?? []).filter((r) => rowView(r).editable && !rowView(r).checked).map((r) => r.sfRecordId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Leads to call</CardTitle>
        <CardDescription>Tick the people the AI should research and call. Only ticked leads are enrolled.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.error && <p role="alert" className="text-sm text-destructive">{errorText(data.error)}</p>}
        {change.error && <p role="alert" className="text-sm text-destructive">{errorText(change.error)}</p>}
        {data.isPending && <p className="text-sm text-muted-foreground">Reading records from Salesforce…</p>}
        {p && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{formatCount(p.total)} records match · {formatCount(p.selectedCount)} selected</span>
              <Button size="sm" variant="outline" disabled={busy || addable.length === 0} onClick={() => change.mutate({ add: addable })}>Select this page</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => change.mutate({ selectAll: true })}>Select all {formatCount(p.total)}</Button>
              <ConfirmAction
                label="Clear"
                triggerVariant="ghost"
                title="Clear the selection?"
                description={`This unticks all ${formatCount(p.selectedCount)} selected leads. ${plural(p.activeEnrolledCount, 'enrolled lead', 'enrolled leads')} will be stopped at the next refresh (${p.activeEnrolledCount === 1 ? 'it' : 'they'} can be ticked again later). Leads held for review are not stopped.`}
                confirmLabel="Clear selection"
                destructive
                disabled={busy}
                onConfirm={() => change.mutate({ clear: true })}
              />
            </div>
            <Table aria-label="Matching records">
              <TableHeader>
                <TableRow><TableHead className="w-10" /><TableHead>Name</TableHead><TableHead>Owner</TableHead><TableHead>AI consent</TableHead><TableHead>Status</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {p.records.map((r) => {
                  const view = rowView(r);
                  return (
                    <TableRow key={r.sfRecordId}>
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name ?? r.sfRecordId}`}
                          checked={view.checked}
                          disabled={busy || !view.editable}
                          onChange={(e) => change.mutate(e.target.checked ? { add: [r.sfRecordId] } : { remove: [r.sfRecordId] })}
                        />
                      </TableCell>
                      <TableCell>{r.name ?? r.sfRecordId}</TableCell>
                      <TableCell>{r.ownerName ?? '—'}</TableCell>
                      <TableCell>{r.consentAiCall ? <Badge variant="secondary">AI consent</Badge> : <Badge variant="outline">No AI consent</Badge>}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{view.note}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="flex items-center gap-2 text-sm">
              <Button size="sm" variant="outline" disabled={p.page <= 1} onClick={() => setPage(p.page - 1)}>Previous</Button>
              <span>Page {p.page} of {p.pages}</span>
              <Button size="sm" variant="outline" disabled={p.page >= p.pages} onClick={() => setPage(p.page + 1)}>Next</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
