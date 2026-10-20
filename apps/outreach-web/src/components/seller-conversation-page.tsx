import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { ConversationHandler, ConversationView } from '@cti/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Section } from '@/components/layout/section';
import { StatusBadge } from '@/components/layout/status-badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { getSellerConversation, outreachKeys, setSellerHandler } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { blockBehindSwitch, EMAIL_BLOCK_WORDS, isSwitchBlock, mayPreview, practiceAllowed, sellerStatus, switchAndSellerWords } from '@/lib/seller-words';
import { SellerEmailComposer } from './seller-email-composer';
import { SellerTimeline } from './seller-timeline';

/**
 * One seller's conversation (plan 2026-10-19): who the seller is, whether Sam is talking with them, and every call,
 * email and hand-over on one timeline. The record's owner or an admin may take the seller over or give them back to
 * Sam; only an admin writes Sam's email. `focusEventId` is the `#event-<id>` a Salesforce Task links to.
 */
export function SellerConversationPage({ sfRecordId, focusEventId = null }: { sfRecordId: string; focusEventId?: string | null }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  const qc = useQueryClient();
  const key = outreachKeys.sellerConversation(sfRecordId);
  const conversation = useQuery({ queryKey: key, queryFn: () => getSellerConversation(sfRecordId) });
  // The handler route answers with the page's new view, so the page shows it without another read.
  const handover = useMutation({ mutationFn: (handler: ConversationHandler) => setSellerHandler(sfRecordId, handler), onSuccess: (view) => qc.setQueryData(key, view) });
  const [composing, setComposing] = useState(false);
  const blockId = useId();

  // A failed refresh keeps what was read (react-query keeps `data`): the page, and a draft being written, stay.
  if (conversation.data === undefined) {
    return conversation.error
      ? <p role="alert" className="text-sm text-destructive">{errorText(conversation.error)}</p>
      : <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  const view = conversation.data;
  const status = sellerStatus(view);
  const block = view.emailBlock;
  // Behind the switch, the seller's own block (which stops the draft too) is said as well.
  const behindSwitch = blockBehindSwitch(block, view.draftBlock);
  const preview = mayPreview(block, view.draftBlock);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={view.sfObject}
        title={<RecordName view={view} />}
        meta={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
        actions={
          <>
            {view.mayChangeHandler && <HandoverButton view={view} busy={handover.isPending} onChange={(handler) => handover.mutate(handler)} />}
            {isAdmin && (
              // With only the switch in the way, the button opens the composer to read Sam's draft; its Send stays off.
              <Button size="sm" disabled={!view.mayEmail && !preview} aria-describedby={block ? blockId : undefined} onClick={() => setComposing(true)}>
                {isSwitchBlock(block) ? "Preview Sam's email" : 'Email from Sam'}
              </Button>
            )}
            {/* A seller block keeps the real email off but not the practice copy (it goes only to the admin); the composer has it too once open. */}
            {isAdmin && block !== null && practiceAllowed(block) && !composing && (
              <Button size="sm" variant="outline" onClick={() => setComposing(true)}>Send a practice copy to me</Button>
            )}
          </>
        }
      >
        {isAdmin && block && (
          <p id={blockId} className="text-[13px] text-muted-foreground">
            {behindSwitch ? switchAndSellerWords(block, behindSwitch) : EMAIL_BLOCK_WORDS[block]}
          </p>
        )}
      </PageHeader>
      {conversation.error && <p role="alert" className="text-sm text-destructive">Could not refresh this page. {errorText(conversation.error)}</p>}
      {handover.error && <p role="alert" className="text-sm text-destructive">{errorText(handover.error)}</p>}
      {isAdmin && composing && <SellerEmailComposer sfRecordId={sfRecordId} emailBlock={block} draftBlock={view.draftBlock ?? null} onClose={() => setComposing(false)} />}
      <Section title="Conversation" description="Calls, emails and hand-overs, oldest first.">
        <SellerTimeline items={view.items} focusEventId={focusEventId} />
      </Section>
    </div>
  );
}

/** The name, linked to the Salesforce record; no link when the tenant has no Salesforce connection (`recordUrl` is ''). */
function RecordName({ view }: { view: ConversationView }) {
  if (!view.recordUrl) return <>{view.name}</>;
  return <a href={view.recordUrl} target="_blank" rel="noreferrer" className="underline decoration-foreground/20 underline-offset-4 hover:decoration-foreground">{view.name}</a>;
}

/**
 * Take over while Sam handles the seller; give back while a person does. A flag (it pauses Sam's calls and emails) is
 * cleared by the give-back whoever handles the seller, so a flagged seller Sam still handles shows both buttons.
 */
function HandoverButton({ view, busy, onChange }: { view: ConversationView; busy: boolean; onChange: (handler: ConversationHandler) => void }) {
  const flagged = Boolean(view.flagReason);
  return (
    <>
      {view.handler === 'sam' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange('person')}>Take over</Button>}
      {(view.handler !== 'sam' || flagged) && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange('sam')}>{flagged ? 'Clear flag and give back to Sam' : 'Give back to Sam'}</Button>
      )}
    </>
  );
}
