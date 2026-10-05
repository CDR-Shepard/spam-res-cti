import { SkipReason, type CampaignPreview as CampaignPreviewData, type PreviewRecord } from '@cti/contracts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CONTACT_CHANNEL_WORDS, formatCount, SKIP_REASON_WORDS } from '@/lib/outreach-words';

/** The builder's preview: how many match, how many of the checked ones are eligible, why the rest are skipped, and a sample. */
export function CampaignPreview({ preview }: { preview: CampaignPreviewData }) {
  const skipped = SkipReason.options
    .map((reason) => ({ reason, count: preview.skipped[reason] ?? 0 }))
    .filter((s) => s.count > 0);
  return (
    <section aria-label="Preview" className="space-y-4 rounded-md border p-4">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{formatCount(preview.total)} records match.</p>
        <p className="font-medium">Of the first {formatCount(preview.examined)} checked: {formatCount(preview.eligible)} eligible</p>
      </div>
      {skipped.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Skipped</p>
          <ul aria-label="Skipped records by reason" className="grid gap-1 text-sm sm:grid-cols-2">
            {skipped.map((s) => <li key={s.reason}>{SKIP_REASON_WORDS[s.reason]}: {formatCount(s.count)}</li>)}
          </ul>
        </div>
      )}
      {preview.sample.length > 0 && (
        <Table aria-label="Sample records">
          <TableHeader>
            <TableRow><TableHead>Name</TableHead><TableHead>Owner</TableHead><TableHead>Reachable by</TableHead><TableHead>Result</TableHead></TableRow>
          </TableHeader>
          <TableBody>{preview.sample.map((r) => <SampleRow key={r.sfRecordId} record={r} />)}</TableBody>
        </Table>
      )}
    </section>
  );
}

function SampleRow({ record: r }: { record: PreviewRecord }) {
  return (
    <TableRow>
      <TableCell>{r.name ?? r.sfRecordId}</TableCell>
      <TableCell>{r.ownerName ?? '—'}</TableCell>
      <TableCell>{r.channels.length ? r.channels.map((c) => CONTACT_CHANNEL_WORDS[c]).join(', ') : 'None'}</TableCell>
      <TableCell>{r.skipReason ? `Skipped: ${SKIP_REASON_WORDS[r.skipReason]}` : 'Eligible'}</TableCell>
    </TableRow>
  );
}
