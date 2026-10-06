import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { parseSalesforceRecordRef, RECORD_REF_ERROR_WORDS, type RecordTestsResponse } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { createRecordTest, outreachKeys, recordTests } from '@/lib/outreach-api';
import { errorText, formatDateTime } from '@/lib/outreach-words';
import { RECORD_TEST_STATUS_WORDS, recordTestErrorText } from '@/lib/record-test-words';
import { RecordTestPreview } from './record-test-preview';

const INPUT_LABEL = 'Salesforce Lead or Opportunity Id, or its link';

/**
 * Test a record (admins, plan 1E): paste a Lead or Opportunity Id or its Salesforce link and see how the AI would
 * approach the call, then run it to your phone or in the browser. Nothing is written to Salesforce.
 * `onOpen` shows a test (the route sets `?id=`).
 */
export function RecordTestPage({ id, onOpen }: { id: string | null; onOpen: (id: string) => void }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  if (!isAdmin) return <p className="text-sm text-muted-foreground">Only admins can test records.</p>;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Test a record</h1>
        <p className="text-sm text-muted-foreground">See how the AI would approach a call to any Lead or Opportunity, then try the call yourself. Nothing is written to Salesforce.</p>
      </div>
      <RecordForm onOpen={onOpen} />
      {id && <RecordTestPreview key={id} id={id} onOpen={onOpen} />}
      <RecentTests current={id} onOpen={onOpen} />
    </div>
  );
}

function RecordForm({ onOpen }: { onOpen: (id: string) => void }) {
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
    if (ref?.ok) create.mutate(ref.sfRecordId);
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Label htmlFor="record-ref">{INPUT_LABEL}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id="record-ref" value={text} autoComplete="off" spellCheck={false} placeholder="00Q… or https://….lightning.force.com/…" onChange={(e) => setText(e.target.value)} />
        <Button type="submit" disabled={!ref?.ok || create.isPending}>Preview the call</Button>
      </div>
      {ref && (ref.ok ? <p className="text-sm text-muted-foreground">{`${ref.sfObject} ${ref.sfRecordId}`}</p> : <p className="text-sm text-destructive">{RECORD_REF_ERROR_WORDS[ref.error]}</p>)}
      {create.error && <p role="alert" className="text-sm text-destructive">{recordTestErrorText(create.error)}</p>}
    </form>
  );
}

function RecentTests({ current, onOpen }: { current: string | null; onOpen: (id: string) => void }) {
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
          <ul className="divide-y">
            {items.map((t) => <RecentRow key={t.id} t={t} current={t.id === current} onOpen={onOpen} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

type Recent = RecordTestsResponse['items'][number];

function RecentRow({ t, current, onOpen }: { t: Recent; current: boolean; onOpen: (id: string) => void }) {
  return (
    <li>
      <button type="button" aria-current={current || undefined} className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-left text-sm hover:bg-muted/50 aria-[current]:font-medium" onClick={() => onOpen(t.id)}>
        <span className="font-medium">{t.name ?? t.sfRecordId}</span>
        <span className="text-muted-foreground">{t.sfObject}</span>
        <span>{RECORD_TEST_STATUS_WORDS[t.status]}</span>
        <span className="text-muted-foreground">{formatDateTime(t.createdAt)}</span>
        {t.requestedByName && <span className="text-muted-foreground">by {t.requestedByName}</span>}
      </button>
    </li>
  );
}
