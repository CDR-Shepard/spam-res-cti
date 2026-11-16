/**
 * Texts tab: the texts people sent to this rep's numbers, newest first. Each
 * one is also a Salesforce Task; tapping a text opens its record there. Read
 * only — replies go out from the rep's own phone or Salesforce, not from here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatE164, relativeTime } from '../format';
import { MessageIcon } from '../icons';
import { screenPopRecord } from '../opencti';
import {
  attachmentLabel,
  fetchNewTextCount,
  fetchTexts,
  senderHeadline,
  textStatusLabel,
  type TextItem,
} from '../texts';

/** While the tab is open, how often it checks for a new text (a database read only). */
export const TEXTS_PANEL_POLL_MS = 30_000;
/** With an empty list, count from the start: any text at all is new. */
const EPOCH = new Date(0).toISOString();

interface TextTag {
  label: string;
  tone: 'stop' | 'note' | 'warn';
}

function tagsFor(item: TextItem): TextTag[] {
  const tags: TextTag[] = [];
  if (item.optOut) tags.push({ label: 'Asked to STOP', tone: 'stop' });
  const attachments = attachmentLabel(item.numMedia);
  if (attachments) tags.push({ label: attachments, tone: 'note' });
  const status = textStatusLabel(item);
  if (status) tags.push({ label: status, tone: 'warn' });
  return tags;
}

/** One text. Exported so the rendering is testable without the fetch. */
export function TextRow({ item }: { item: TextItem }): JSX.Element {
  const recordId = item.openRecordId;
  const open = (): void => { if (recordId) screenPopRecord(recordId); };
  const tags = tagsFor(item);
  return (
    <div
      className={`row-item text-item ${recordId ? 'tappable' : ''}`}
      role={recordId ? 'button' : undefined}
      tabIndex={recordId ? 0 : undefined}
      onClick={recordId ? open : undefined}
      onKeyDown={recordId ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}
      title={recordId ? 'Open in Salesforce' : undefined}
    >
      <div className="dir"><MessageIcon /></div>
      <div className="info">
        <div className="num">{senderHeadline(item)}</div>
        <div className="meta" title={new Date(item.receivedAt).toLocaleString()}>
          {item.senderName ? `${formatE164(item.fromE164)} · ` : ''}{relativeTime(item.receivedAt)}
        </div>
        {item.body && <div className="text-body">{item.body}</div>}
        {tags.length > 0 && (
          <div className="text-tags">
            {tags.map((t) => <span key={t.label} className={`text-tag ${t.tone}`}>{t.label}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

interface TextsPanelProps {
  /** Called with the newest text's time once the list is on screen. */
  onSeen: (receivedAt: string) => void;
}

export function TextsPanel({ onSeen }: TextsPanelProps): JSX.Element {
  const [items, setItems] = useState<TextItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await fetchTexts();
      if (!mounted.current) return;
      setItems(list);
      setFailed(false);
      if (list[0]) onSeenRef.current(list[0].receivedAt);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const newest = items === null ? null : (items[0]?.receivedAt ?? EPOCH);
  useEffect(() => {
    if (newest === null) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void fetchNewTextCount(newest)
        .then((n) => { if (n > 0) return load(); })
        .catch(() => { /* try again next tick */ });
    }, TEXTS_PANEL_POLL_MS);
    return () => window.clearInterval(id);
  }, [newest, load]);

  if (failed && items === null) {
    return (
      <div className="empty-state bad">
        Couldn&apos;t load your texts.
        <button className="btn ghost compact" onClick={() => { setFailed(false); void load(); }}>Try again</button>
      </div>
    );
  }
  if (items === null) return <div className="empty-state"><span className="spinner lg" /></div>;
  if (items.length === 0) {
    return (
      <div className="empty-state">
        <MessageIcon className="empty-icon" />
        No texts yet
        <span className="empty-hint">Texts to your phone numbers show up here. Each one is also a Task in Salesforce.</span>
      </div>
    );
  }
  return (
    <div className="list">
      {items.map((t) => <TextRow key={t.id} item={t} />)}
    </div>
  );
}
