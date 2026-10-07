import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { parseSalesforceRecordRef, RECORD_REF_ERROR_WORDS, type RecordTestsResponse } from '@cti/contracts';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { StatusBadge, type StatusTone } from '@/components/layout/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { createRecordTest, outreachKeys, recordTests } from '@/lib/outreach-api';
import { errorText, formatDateTime } from '@/lib/outreach-words';
import { RECORD_TEST_STATUS_WORDS, recordTestErrorText } from '@/lib/record-test-words';
import { LeaveGuard } from './record-test-leave-guard';
import { BROWSER_LOCK_WORDS, RecordTestPreview } from './record-test-preview';

const INPUT_LABEL = 'Salesforce Lead or Opportunity Id, or its link';

/**
 * Test a record (admins, plan 1E): paste a Lead or Opportunity Id or its Salesforce link and see how the AI would
 * approach the call, then run it to your phone or in the browser. Nothing is written to Salesforce.
 * `onOpen` shows a test (the route sets `?id=`).
 */
export function RecordTestPage({ id, onOpen }: { id: string | null; onOpen: (id: string) => void }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  // While the browser call is up, nothing here may open another test: that would unmount the call and drop it.
  const [locked, setLocked] = useState(false);
  if (!isAdmin) return <p className="text-sm text-muted-foreground">Only admins can test records.</p>;
  return (
    <div className="space-y-6">
      {locked && <LeaveGuard />}
      <PageHeader
        title="Test a record"
        description="See how the AI would approach a call to any Lead or Opportunity, then try the call yourself. Nothing is written to Salesforce."
      />
      <RecordForm onOpen={onOpen} locked={locked} />
      {id && <RecordTestPreview key={id} id={id} onOpen={onOpen} onBrowserLive={setLocked} />}
      <RecentTests current={id} onOpen={onOpen} locked={locked} />
    </div>
  );
}

function RecordForm({ onOpen, locked }: { onOpen: (id: string) => void; locked: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const ref = text.trim() ? parseSalesforceRecordRef(text) : null;
  const create = useMutation({
    mutationFn: (record: string) => createRecordTest(record),
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: outreachKeys.recordTests });
      onOpen(out.id);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ref?.ok && !locked) create.mutate(ref.sfRecordId);
  };
  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-xl border bg-card px-5 py-5 sm:px-6">
      <Label htmlFor="record-ref">{INPUT_LABEL}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id="record-ref" value={text} autoComplete="off" spellCheck={false} placeholder="00Q… or https://….lightning.force.com/…" onChange={(e) => setText(e.target.value)} />
        <Button type="submit" disabled={!ref?.ok || create.isPending || locked}>Preview the call</Button>
      </div>
      {locked && <p className="text-xs text-muted-foreground">{BROWSER_LOCK_WORDS}</p>}
      {ref && (ref.ok ? <p className="font-mono text-xs text-muted-foreground">{`${ref.sfObject} ${ref.sfRecordId}`}</p> : <p className="text-sm text-destructive">{RECORD_REF_ERROR_WORDS[ref.error]}</p>)}
      {create.error && <p role="alert" className="text-sm text-destructive">{recordTestErrorText(create.error)}</p>}
    </form>
  );
}

function RecentTests({ current, onOpen, locked }: { current: string | null; onOpen: (id: string) => void; locked: boolean }) {
  const list = useQuery({ queryKey: outreachKeys.recordTests, queryFn: recordTests });
  const items = list.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>Recent tests</CardTitle>
        <CardDescription>Your team's latest 20.</CardDescription>
      </CardHeader>
      <CardContent>
        {list.error && <p role="alert" className="text-sm text-destructive">{errorText(list.error)}</p>}
        {list.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {list.isSuccess && items.length === 0 && <p className="text-sm text-muted-foreground">No tests yet.</p>}
        {items.length > 0 && (
          <ul className="-mx-5 divide-y sm:-mx-6">
            {items.map((t) => <RecentRow key={t.id} t={t} current={t.id === current} disabled={locked} onOpen={onOpen} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

type Recent = RecordTestsResponse['items'][number];

const STATUS_TONE: Record<Recent['status'], StatusTone> = { running: 'outline', ready: 'success', failed: 'danger' };

function RecentRow({ t, current, disabled, onOpen }: { t: Recent; current: boolean; disabled: boolean; onOpen: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        aria-current={current || undefined}
        className="group flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-left text-sm transition-colors duration-150 hover:bg-foreground/[0.025] focus-visible:-outline-offset-2 disabled:opacity-60 aria-[current]:bg-foreground/[0.035] sm:flex-nowrap sm:px-6"
        onClick={() => onOpen(t.id)}
      >
        <span className="min-w-0 truncate font-medium sm:flex-1">{t.name ?? t.sfRecordId}</span>
        <span className="text-muted-foreground sm:w-24">{t.sfObject}</span>
        <StatusBadge tone={STATUS_TONE[t.status]}>{RECORD_TEST_STATUS_WORDS[t.status]}</StatusBadge>
        <span className="text-muted-foreground tabular-nums sm:w-40 sm:text-right">{formatDateTime(t.createdAt)}</span>
        {t.requestedByName && <span className="text-muted-foreground sm:w-28 sm:truncate">by {t.requestedByName}</span>}
        <ChevronRight aria-hidden className="ml-auto hidden size-4 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover:translate-x-0.5 sm:block" />
      </button>
    </li>
  );
}
