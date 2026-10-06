import { useMutation } from '@tanstack/react-query';
import type { WritebackChange, WritebackStatus, WritebackSummary } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { retryWriteback } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const STATUS_WORDS: Readonly<Record<WritebackStatus, string>> = {
  pending: 'Pending',
  running: 'Writing',
  done: 'Done',
  partial: 'Partial',
  failed: 'Failed',
  skipped: 'Skipped',
};
const STATUS_VARIANT: Readonly<Record<WritebackStatus, 'secondary' | 'outline' | 'destructive'>> = {
  pending: 'outline',
  running: 'outline',
  done: 'secondary',
  partial: 'destructive',
  failed: 'destructive',
  skipped: 'outline',
};

/** The badge's words, for a control that names the status. */
export const writebackStatusWords = (status: WritebackStatus): string => STATUS_WORDS[status];

export function WritebackBadge({ status }: { status: WritebackStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_WORDS[status]}</Badge>;
}

/** The groups in the order a rep reads them, with the heading each list is named by. */
const GROUPS: ReadonlyArray<[WritebackChange['kind'], string]> = [
  ['converted', 'Converted'],
  ['created', 'Created in Salesforce'],
  ['changed', 'Changed'],
  ['kept', 'Kept as it was in Salesforce'],
  ['not_written', 'Not written'],
];

const blank = (v: string | null): string => v ?? '(blank)';

/** With no changes listed: still to come (or to retry), finished with nothing to change, or ended without writing. */
const NOTHING_WORDS: Readonly<Record<WritebackStatus, string>> = {
  pending: 'Nothing was written yet.',
  running: 'Nothing was written yet.',
  failed: 'Nothing was written yet.',
  done: 'Nothing in Salesforce needed changing.',
  partial: 'Nothing was written.',
  skipped: 'Nothing was written.',
};

/** One change in words. A not_written entry carries its reason in `after`; a kept one the seller's answer (or null: changed since the call). */
function changeWords(c: WritebackChange): string {
  switch (c.kind) {
    case 'changed':
      return `${c.label}: ${blank(c.before)} → ${blank(c.after)}`;
    case 'kept':
      return c.after === null ? `${c.label}: kept ${blank(c.before)} (changed in Salesforce since the call)` : `${c.label}: kept ${blank(c.before)} (the seller's answer was ${c.after})`;
    case 'not_written':
      return c.after ? `${c.label}: ${c.after}` : c.label;
    default:
      return c.label;
  }
}

/** The changes grouped by kind, each list named by its heading (also the Test a record dry run's, plan 1E). */
export function ChangeGroups({ changes }: { changes: readonly WritebackChange[] }) {
  const groups = GROUPS.map(([kind, title]) => [title, changes.filter((c) => c.kind === kind)] as const).filter(([, items]) => items.length > 0);
  return (
    <>
      {groups.map(([title, items]) => (
        <div key={title}>
          <h4 className="font-medium">{title}</h4>
          <ul aria-label={title} className="list-disc pl-5">
            {items.map((c, i) => <li key={i}>{changeWords(c)}</li>)}
          </ul>
        </div>
      ))}
    </>
  );
}

/**
 * What one AI call's Salesforce write-back did: grouped by kind with old → new, its last error, and Retry for an admin when
 * the round failed (the server keeps the finished steps, so nothing is done twice).
 */
export function WritebackChanges({ summary, aiCallId, onRetried }: { summary: WritebackSummary; aiCallId: string; onRetried: () => void }) {
  const retry = useMutation({ mutationFn: () => retryWriteback(aiCallId), onSuccess: onRetried });
  return (
    <div className="space-y-2 text-sm">
      {summary.changes.length === 0 && <p className="text-muted-foreground">{NOTHING_WORDS[summary.status]}</p>}
      <ChangeGroups changes={summary.changes} />
      {/* A skipped row's "error" is why it was skipped (write-back is off, a test call), not a failure. */}
      {summary.error && <p className="text-muted-foreground">{summary.status === 'skipped' ? 'Why' : 'Last error'}: {summary.error}</p>}
      {summary.mayRetry && (
        <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry</Button>
      )}
      {retry.error && <p role="alert" className="text-destructive">{errorText(retry.error)}</p>}
    </div>
  );
}
