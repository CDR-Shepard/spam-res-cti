import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CandidateRecord, SelectionChange } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { changeSelection, getCandidates, outreachKeys } from '@/lib/outreach-api';
import { errorText, formatCount, SKIP_REASON_WORDS } from '@/lib/outreach-words';

const selectable = (r: CandidateRecord): boolean => r.skipReason === null && !r.enrolled;

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
  const addable = (p?.records ?? []).filter((r) => selectable(r) && !r.selected).map((r) => r.sfRecordId);
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
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => change.mutate({ clear: true })}>Clear</Button>
            </div>
            <Table aria-label="Matching records">
              <TableHeader>
                <TableRow><TableHead className="w-10" /><TableHead>Name</TableHead><TableHead>Owner</TableHead><TableHead>AI consent</TableHead><TableHead>Status</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {p.records.map((r) => (
                  <TableRow key={r.sfRecordId}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name ?? r.sfRecordId}`}
                        checked={r.selected || r.enrolled}
                        disabled={busy || !selectable(r)}
                        onChange={(e) => change.mutate(e.target.checked ? { add: [r.sfRecordId] } : { remove: [r.sfRecordId] })}
                      />
                    </TableCell>
                    <TableCell>{r.name ?? r.sfRecordId}</TableCell>
                    <TableCell>{r.ownerName ?? '—'}</TableCell>
                    <TableCell>{r.consentAiCall ? <Badge variant="secondary">AI consent</Badge> : <Badge variant="outline">No AI consent</Badge>}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.enrolled ? 'Enrolled' : r.skipReason ? `Skipped: ${SKIP_REASON_WORDS[r.skipReason]}` : ''}</TableCell>
                  </TableRow>
                ))}
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
