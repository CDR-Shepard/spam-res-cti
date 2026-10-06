import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { RecordTestCall, RecordTestDryRun as DryRun } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { recordTestDryRun } from '@/lib/outreach-api';
import { recordTestErrorText } from '@/lib/record-test-words';
import { ChangeGroups } from './writeback-changes';

/**
 * "What would be written to Salesforce" for one finished test call (plan 1E Task 11, spec §4.5): the write-back a real
 * call ending this way would make, worked out from reads only. The first press asks the server (one mapping-model call);
 * the answer is stored with the call, so later presses only show it.
 */
export function RecordTestDryRun({ call }: { call: RecordTestCall }) {
  const [open, setOpen] = useState(false);
  const ask = useMutation({ mutationFn: () => recordTestDryRun(call.id), onSuccess: () => setOpen(true) });
  const result = ask.data ?? call.dryRun;
  const toggle = () => {
    if (open) setOpen(false);
    else if (result) setOpen(true);
    else ask.mutate();
  };
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={ask.isPending} onClick={toggle}>
        {open ? 'Hide what would be written' : 'What would be written to Salesforce'}
      </Button>
      {ask.isPending && <p className="text-muted-foreground">Working out what a real call would write…</p>}
      {ask.error && <p role="alert" className="text-destructive">{recordTestErrorText(ask.error)}</p>}
      {open && result && <DryRunPanel d={result} />}
    </div>
  );
}

function DryRunPanel({ d }: { d: DryRun }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <p className="font-medium">Nothing was sent to Salesforce.</p>
      {d.note && <p className="text-muted-foreground">{d.note}</p>}
      {d.conversion && <p>{d.conversion}</p>}
      {d.wouldCreate.length > 0 && (
        <div>
          <h4 className="font-medium">Would create</h4>
          <ul aria-label="Would create" className="list-disc pl-5">{d.wouldCreate.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      )}
      <ChangeGroups changes={d.changes} />
      {d.changesText && <Text title="AI Last Call Changes" text={d.changesText} />}
      {d.chatterText && <Text title="Chatter post" text={d.chatterText} />}
    </div>
  );
}

function Text({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h4 className="font-medium">{`${title}, as it would read`}</h4>
      <pre aria-label={title} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-2 font-mono text-xs">{text}</pre>
    </div>
  );
}
