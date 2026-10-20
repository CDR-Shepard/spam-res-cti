import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { RecordTestEmailPreview } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { recordTestEmailPreview } from '@/lib/outreach-api';
import { recordTestErrorText } from '@/lib/record-test-words';

const HINT = "The first email Sam would write to this person, so you can read it before turning email on. Nothing is sent. Each press writes a new draft and counts toward today's AI budget.";

/**
 * "Preview Sam's email" (owner, 2026-10-20): the first email Sam would write to this test's record, from the preview's
 * research and plan, with the footer every email ends with. No campaign is needed; nothing is sent or stored, so the
 * draft lives only on this page. Write another keeps the draft on screen until a new one replaces it, so a refused retry
 * (the budget, Sam declining) never loses one already paid for.
 */
export function RecordTestEmail({ testId }: { testId: string }) {
  const [draft, setDraft] = useState<RecordTestEmailPreview | null>(null);
  const write = useMutation({ mutationFn: () => recordTestEmailPreview(testId), onSuccess: setDraft });
  return (
    <section aria-labelledby="sam-email-title" className="space-y-4 rounded-xl border bg-background/70 p-4 text-sm sm:p-5">
      <div className="space-y-1">
        <h3 id="sam-email-title" className="text-[15px] font-semibold tracking-[-0.01em]">Sam's first email</h3>
        <p className="text-[13px] leading-5 text-muted-foreground">{HINT}</p>
      </div>
      <Button size="sm" variant="outline" disabled={write.isPending} onClick={() => write.mutate()}>
        {draft ? 'Write another' : "Preview Sam's email"}
      </Button>
      {write.isPending && <p role="status" className="text-muted-foreground">Sam is writing… (usually under a minute)</p>}
      {write.error && <p role="alert" className="text-destructive">{recordTestErrorText(write.error)}</p>}
      {draft && <Draft d={draft} />}
    </section>
  );
}

function Draft({ d }: { d: RecordTestEmailPreview }) {
  return (
    <div className="space-y-2">
      <p role="status" className="font-medium">Nothing was sent.</p>
      {d.issues.length > 0 && (
        <div role="alert" className="space-y-1 text-destructive">
          <p className="font-medium">A real send would refuse this draft as written:</p>
          <ul className="list-disc pl-5">{d.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
        </div>
      )}
      <article aria-label="Sam's draft" className="space-y-3 rounded-lg border bg-card p-4">
        <p className="break-words"><span className="text-muted-foreground">Subject: </span><span className="font-medium">{d.subject}</span></p>
        <div role="group" aria-label="Body" className="whitespace-pre-wrap break-words leading-6">{d.body}</div>
        <div role="group" aria-label="Footer" className="whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground">{d.footer}</div>
      </article>
    </div>
  );
}
