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
import { EMAIL_BLOCK_WORDS, sellerStatus } from '@/lib/seller-words';
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
              <Button size="sm" disabled={!view.mayEmail} aria-describedby={block ? blockId : undefined} onClick={() => setComposing(true)}>Email from Sam</Button>
            )}
          </>
        }
      >
        {isAdmin && block && <p id={blockId} className="text-[13px] text-muted-foreground">{EMAIL_BLOCK_WORDS[block]}</p>}
      </PageHeader>
      {conversation.error && <p role="alert" className="text-sm text-destructive">Could not refresh this page. {errorText(conversation.error)}</p>}
      {handover.error && <p role="alert" className="text-sm text-destructive">{errorText(handover.error)}</p>}
      {isAdmin && composing && <SellerEmailComposer sfRecordId={sfRecordId} onClose={() => setComposing(false)} />}
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

function HandoverButton({ view, busy, onChange }: { view: ConversationView; busy: boolean; onChange: (handler: ConversationHandler) => void }) {
  if (view.handler === 'sam') return <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange('person')}>Take over</Button>;
  return <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange('sam')}>{view.flagReason ? 'Clear flag and give back to Sam' : 'Give back to Sam'}</Button>;
}
