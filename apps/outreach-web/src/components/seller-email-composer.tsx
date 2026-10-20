import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { EMAIL_BODY_MAX, EMAIL_SUBJECT_MAX, type EmailBlock } from '@cti/contracts';
import { Section } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { draftSellerEmail, outreachKeys, sendSellerEmail } from '@/lib/outreach-api';
import { EMAIL_BLOCK_WORDS, emailErrorWords, practiceAllowed, sendAfterWords } from '@/lib/seller-words';
import { cn } from '@/lib/utils';
import { ConfirmAction } from './confirm-action';

interface Draft { subject: string; body: string; to: string; practice: boolean }
interface Queued { to: string; sendAfter: string; practice: boolean }

/** The same test the server's draft guard starts with: something to say, one line of subject, inside the limits. */
const isSendable = (d: Draft): boolean =>
  d.subject.trim() !== '' && d.subject.length <= EMAIL_SUBJECT_MAX && !/[\r\n]/.test(d.subject) && d.body.trim() !== '' && d.body.length <= EMAIL_BODY_MAX;

/**
 * "Email from Sam" (admins): Sam writes a first email, the admin edits it, and Send queues it behind a confirm step.
 * The send does not go out at once: the seller's sending hours decide when, and the answer says when. "Send a practice
 * copy to me" runs the same flow with the draft and the send addressed to the admin's own address (it goes out right away).
 * The Send button is off while a send is in flight, so a double click cannot queue two; a successful or refused send
 * refetches the seller's conversation, since either may have changed the timeline.
 *
 * `emailBlock` is the page's current reason Sam may not email (null = she may), and it can change while the composer is
 * open (a hand-over, the daily cap). The real Write draft and Send follow it; the practice copy goes only to the admin, so
 * only the server setup and the tenant's switch stop it (`practiceAllowed`). A draft already written stays on screen.
 */
export function SellerEmailComposer({ sfRecordId, emailBlock, onClose }: { sfRecordId: string; emailBlock: EmailBlock | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [queued, setQueued] = useState<Queued | null>(null);
  const write = useMutation({
    mutationFn: (practice: boolean) => draftSellerEmail(sfRecordId, practice),
    onSuccess: (r, practice) => setDraft({ subject: r.subject, body: r.body, to: r.to, practice }),
  });
  const send = useMutation({
    mutationFn: (d: Draft) => sendSellerEmail(sfRecordId, { subject: d.subject, body: d.body, practice: d.practice }),
    onSuccess: (r, d) => {
      setDraft(null);
      setQueued({ to: r.to, sendAfter: r.sendAfter, practice: d.practice });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: outreachKeys.sellerConversation(sfRecordId) }),
  });
  const startDraft = (practice: boolean) => {
    setQueued(null);
    write.mutate(practice);
  };
  const discard = () => {
    setDraft(null);
    write.reset();
    send.reset();
  };
  return (
    <Section title="Email from Sam" actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        {queued && <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">{queuedWords(queued)}</p>}
        {draft ? (
          <DraftForm
            draft={draft}
            blockWords={blockWords(emailBlock, draft.practice)}
            sending={send.isPending}
            error={send.error}
            onEdit={(next) => {
              if (send.isError) send.reset();
              setDraft(next);
            }}
            onSend={() => { if (!send.isPending) send.mutate(draft); }}
            onDiscard={discard}
          />
        ) : (
          <StartPanel writing={write.isPending} error={write.error} emailBlock={emailBlock} onWrite={startDraft} />
        )}
      </div>
    </Section>
  );
}

/** Why this kind of email (a practice copy or the real one) may not be sent under `block`, in words; null when it may. */
function blockWords(block: EmailBlock | null, practice: boolean): string | null {
  if (block === null || (practice && practiceAllowed(block))) return null;
  return EMAIL_BLOCK_WORDS[block];
}

const queuedWords = (q: Queued): string => `${q.practice ? 'Practice copy queued' : 'Queued'} for ${q.to}. It goes out ${sendAfterWords(q.sendAfter)}.`;

function StartPanel({ writing, error, emailBlock, onWrite }: { writing: boolean; error: unknown; emailBlock: EmailBlock | null; onWrite: (practice: boolean) => void }) {
  const hintId = useId();
  const realWords = blockWords(emailBlock, false);
  const practiceWords = blockWords(emailBlock, true);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Sam writes a first draft. You can edit it before anything is sent.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={writing || realWords !== null} aria-describedby={realWords ? hintId : undefined} onClick={() => onWrite(false)}>Write draft</Button>
        <Button variant="outline" disabled={writing || practiceWords !== null} aria-describedby={practiceWords ? hintId : undefined} onClick={() => onWrite(true)}>Send a practice copy to me</Button>
      </div>
      {/* One reason is shown: the real draft's, which is also the practice copy's whenever the practice copy is off too. */}
      {realWords && <p id={hintId} className="text-sm text-muted-foreground">{realWords}</p>}
      {writing && <p role="status" className="text-sm text-muted-foreground">Sam is writing a draft…</p>}
      {error !== null && <ErrorBlock error={error} />}
    </div>
  );
}

interface DraftFormProps { draft: Draft; blockWords: string | null; sending: boolean; error: unknown; onEdit: (next: Draft) => void; onSend: () => void; onDiscard: () => void }

function DraftForm({ draft, blockWords: blocked, sending, error, onEdit, onSend, onDiscard }: DraftFormProps) {
  const subjectId = useId();
  const blockId = useId();
  const bodyId = useId();
  const { practice, to } = draft;
  return (
    <div className="space-y-4">
      {practice && <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">Practice copy: it goes to your own address, not to the seller.</p>}
      <p className="text-sm">
        <span className="text-muted-foreground">To </span>
        <span className="font-medium">{to}</span>
      </p>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={subjectId}>Subject</Label>
          <Count length={draft.subject.length} max={EMAIL_SUBJECT_MAX} />
        </div>
        <Input id={subjectId} value={draft.subject} onChange={(e) => onEdit({ ...draft, subject: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={bodyId}>Body</Label>
          <Count length={draft.body.length} max={EMAIL_BODY_MAX} />
        </div>
        <Textarea id={bodyId} className="min-h-48" value={draft.body} onChange={(e) => onEdit({ ...draft, body: e.target.value })} />
        <p className="text-xs text-muted-foreground">The footer with the unsubscribe link is added automatically.</p>
      </div>
      {error !== null && <ErrorBlock error={error} />}
      {blocked && <p id={blockId} className="text-sm text-muted-foreground">{blocked}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmAction
          label={practice ? 'Send practice copy' : 'Send'}
          title={practice ? `Send a practice copy to ${to}?` : `Send this email to ${to}?`}
          description={practice
            ? 'It goes out right away, to you only. Nothing reaches the seller.'
            : "It is queued and goes out in the seller's sending hours; this page says when once it is queued. The footer with the unsubscribe link is added automatically."}
          confirmLabel={practice ? 'Send practice copy' : 'Send'}
          disabled={!isSendable(draft) || sending || blocked !== null}
          triggerDescribedBy={blocked ? blockId : undefined}
          onConfirm={onSend}
        />
        <Button size="sm" variant="ghost" disabled={sending} onClick={onDiscard}>Discard draft</Button>
      </div>
    </div>
  );
}

function Count({ length, max }: { length: number; max: number }) {
  return <span className={cn('text-xs text-muted-foreground', length > max && 'font-medium text-destructive')}>{length.toLocaleString('en-US')}/{max.toLocaleString('en-US')}</span>;
}

function ErrorBlock({ error }: { error: unknown }) {
  const { message, details } = emailErrorWords(error);
  return (
    <div role="alert" className="space-y-1 text-sm text-destructive">
      <p>{message}</p>
      {details.length > 0 && <ul className="list-disc pl-5">{details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
    </div>
  );
}
