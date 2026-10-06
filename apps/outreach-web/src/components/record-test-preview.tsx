import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { RecordTest } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createRecordTest, outreachKeys, recordTest } from '@/lib/outreach-api';
import { errorText, formatDateTime } from '@/lib/outreach-words';
import { RECORD_TEST_ERROR_WORDS, RECORD_TEST_STATUS_WORDS, recordTestErrorText } from '@/lib/record-test-words';
import { RecordTestPlan } from './record-test-sections';

export const RECORD_TEST_POLL_MS = 2_000;

/** Read again every 2 seconds while the preview is still being written. */
export function recordTestPollInterval(t: RecordTest | undefined): number | false {
  return t?.status === 'running' ? RECORD_TEST_POLL_MS : false;
}

/**
 * One record test (plan 1E, spec §4.2): "how I'll approach this call". Polls while the preview runs; Regenerate (or Try
 * again) starts a new preview of the same record and opens it.
 */
export function RecordTestPreview({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const test = useQuery({ queryKey: outreachKeys.recordTest(id), queryFn: () => recordTest(id), refetchInterval: (q) => recordTestPollInterval(q.state.data) });
  const again = useMutation({
    mutationFn: (record: string) => createRecordTest(record),
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: outreachKeys.recordTests, exact: true });
      onOpen(out.id);
    },
  });
  const status = test.data?.status;
  // The recent list shows each test's status: read it again once this one settles.
  useEffect(() => {
    if (status && status !== 'running') void qc.invalidateQueries({ queryKey: outreachKeys.recordTests, exact: true });
  }, [qc, status]);

  if (test.isPending) return <p className="text-sm text-muted-foreground">Loading the test…</p>;
  if (test.error) return <p role="alert" className="text-sm text-destructive">{errorText(test.error)}</p>;
  const t = test.data;
  const rerun = () => again.mutate(t.sfRecordId);
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex flex-wrap items-center gap-2">
          {t.recordUrl ? <a href={t.recordUrl} target="_blank" rel="noreferrer" className="hover:underline">{t.name ?? t.sfRecordId}</a> : (t.name ?? t.sfRecordId)}
          <Badge variant="outline">{t.sfObject}</Badge>
          {t.status !== 'ready' && <Badge variant={t.status === 'failed' ? 'destructive' : 'secondary'}>{RECORD_TEST_STATUS_WORDS[t.status]}</Badge>}
        </CardTitle>
        <CardDescription>
          How I'll approach this call · {formatDateTime(t.createdAt)}{t.requestedByName ? ` · by ${t.requestedByName}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {t.status === 'running' && <p role="status" className="text-muted-foreground">Reading Salesforce and writing the plan… (about a minute)</p>}
        {t.status === 'failed' && (
          <div className="space-y-2">
            <p role="alert" className="text-destructive">{RECORD_TEST_ERROR_WORDS[t.error ?? 'plan_failed']}</p>
            <Button size="sm" disabled={again.isPending} onClick={rerun}>Try again</Button>
          </div>
        )}
        {t.status === 'ready' && (
          <>
            <RecordTestPlan test={t} />
            <Button size="sm" variant="outline" disabled={again.isPending} onClick={rerun}>Regenerate</Button>
          </>
        )}
        {again.error && <p role="alert" className="text-destructive">{recordTestErrorText(again.error)}</p>}
      </CardContent>
    </Card>
  );
}
