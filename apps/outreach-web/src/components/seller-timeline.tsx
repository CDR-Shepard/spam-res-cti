import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { TimelineItem } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OUTCOME_WORDS } from '@/lib/call-words';
import { formatDateTime } from '@/lib/outreach-words';
import { EMAIL_BLOCK_WORDS, EMAIL_STATUS_WORDS, durationWords, noteWords } from '@/lib/seller-words';
import { cn } from '@/lib/utils';
import { AiCallTranscriptPanel } from './ai-call-transcript';

/** How long a row opened from a `#event-<id>` link stays marked. */
export const HIGHLIGHT_MS = 3000;
const NEWEST_PREFIX = 'newest:';

type Of<T extends TimelineItem['type']> = Extract<TimelineItem, { type: T }>;

/**
 * One seller's conversation, oldest at the top. It opens at the newest row, or, when the page was opened from a
 * Salesforce Task (`#event-<id>`) and that row exists, at that row, marked for a moment. Every row carries
 * `id="event-<item id>"` for those links. Seller text (subjects, bodies, summaries) is only ever rendered as text.
 *
 * What the view was last scrolled to is remembered, so a refetch that returns the same rows does not move it, a
 * new newest row scrolls into view, and a linked row that arrives with a later read is still found.
 */
export function SellerTimeline({ items, focusEventId }: { items: readonly TimelineItem[]; focusEventId: string | null }) {
  const rows = useRef(new Map<string, HTMLElement>());
  const scrolledTo = useRef<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const target = focusEventId !== null && items.some((i) => i.id === focusEventId) ? focusEventId : null;
  const newest = items.length > 0 ? items[items.length - 1]!.id : null;
  const goal = target ?? (newest === null ? null : `${NEWEST_PREFIX}${newest}`);

  useEffect(() => {
    if (goal === null || scrolledTo.current === goal) return;
    scrolledTo.current = goal;
    const id = target ?? newest;
    // jsdom (and very old browsers) have no scrollIntoView.
    if (id !== null) rows.current.get(id)?.scrollIntoView?.({ block: target ? 'center' : 'nearest' });
    if (target) setHighlightId(target);
  }, [goal, target, newest]);

  // Its own effect: under StrictMode the scroll effect above runs once, and this timer must survive that.
  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing has happened with this seller yet.</p>;
  return (
    <ol className="max-h-[65vh] space-y-3 overflow-y-auto p-1">
      {items.map((item) => {
        const marked = item.id === highlightId;
        return (
          <li
            key={item.id}
            id={`event-${item.id}`}
            ref={(el) => {
              if (el) rows.current.set(item.id, el);
              else rows.current.delete(item.id);
            }}
            data-highlighted={marked ? 'true' : undefined}
            className={cn('scroll-mt-4 rounded-lg transition-colors duration-700', item.type !== 'note' && 'border bg-card px-4 py-3', marked && 'bg-brand/15 ring-2 ring-brand/60')}
          >
            <Row item={item} />
          </li>
        );
      })}
    </ol>
  );
}

function Row({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case 'call':
      return <CallRow item={item} />;
    case 'email':
      return <EmailRow item={item} />;
    case 'note':
      return <p className="px-1 py-0.5 text-xs text-muted-foreground">{noteWords(item)} · {formatDateTime(item.at)}</p>;
  }
}

function RowHead({ at, children }: { at: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">{children}</div>
      <time dateTime={at} className="text-xs text-muted-foreground">{formatDateTime(at)}</time>
    </div>
  );
}

function CallRow({ item }: { item: Of<'call'> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <RowHead at={item.at}>
        <span className="font-medium">AI call</span>
        {item.outcome && <span>{OUTCOME_WORDS[item.outcome]}</span>}
        {item.durationSeconds !== null && <span className="text-muted-foreground">{durationWords(item.durationSeconds)}</span>}
      </RowHead>
      {item.summary && <p className="text-sm leading-6 break-words">{item.summary}</p>}
      {item.transcriptAvailable && (
        <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide transcript' : 'Transcript'}</Button>
      )}
      {open && <AiCallTranscriptPanel aiCallId={item.id} />}
    </div>
  );
}

const ACTOR_WORDS: Record<Of<'email'>['actor'], string> = { sam: 'Sam', seller: 'the seller', person: 'a person' };

/** Where an email stands: received, why a canceled one did not go, or the send status. */
function emailStatusLine(item: Of<'email'>): string {
  if (item.status === 'canceled' && item.notSentReason) return `${EMAIL_STATUS_WORDS.canceled}: ${EMAIL_BLOCK_WORDS[item.notSentReason]}`;
  return EMAIL_STATUS_WORDS[item.status];
}

function EmailRow({ item }: { item: Of<'email'> }) {
  const Arrow = item.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
  return (
    <div className="space-y-2">
      <RowHead at={item.at}>
        <Arrow aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Email from {ACTOR_WORDS[item.actor]}</span>
        {item.autoReply && <Badge variant="neutral">Auto-reply</Badge>}
      </RowHead>
      {item.subject && <p className="text-sm font-medium break-words">{item.subject}</p>}
      {item.body && <p className="text-sm leading-6 break-words whitespace-pre-wrap">{item.body}</p>}
      <p className="text-xs text-muted-foreground">{emailStatusLine(item)}</p>
    </div>
  );
}
