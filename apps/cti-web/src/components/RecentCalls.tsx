/**
 * Recent calls list. cti-desktop carries a diverged copy of this component
 * (tracked separately) — changes here do not reach it.
 */
import { useEffect, useState, type SVGProps } from 'react';
import { api } from '../api';
import { formatDuration, formatE164, relativeTime } from '../format';
import {
  CheckCircleIcon,
  ClockIcon,
  PhoneIncomingIcon,
  PhoneMissedIcon,
  PhoneOutgoingIcon,
  VoicemailIcon,
} from '../icons';

export interface CallRow {
  id: string;
  toNumber: string;
  normalizedToNumber: string;
  fromNumber: string;
  direction: string;
  status: string;
  disposition: string | null;
  notes: string | null;
  durationSeconds: number | null;
  salesforceTaskId: string | null;
  salesforceWhoId: string | null;
  salesforceWhatId: string | null;
  createdAt: string;
  syncError: string | null;
  // Inbound-only signals. Optional because a server older than the dial-result
  // `answeredAt` stamp omits them; every reader treats undefined as null.
  /** When the rep picked up an inbound call — the one reliable "answered" signal. */
  answeredAt?: string | null;
  /** Set when the caller reached (and usually left) voicemail. */
  inboundVoicemailUrl?: string | null;
}

export type CallKind = 'connected' | 'missed' | 'voicemail' | 'outgoing';

const TERMINAL = ['completed', 'no_answer', 'busy', 'canceled'];

/** Statuses that mean nobody took the call and no voicemail was recorded. */
const INBOUND_MISSED_STATUSES = ['no_answer', 'busy', 'failed', 'canceled'];

/** A short outbound ring is "outgoing"; past this many seconds it counts as connected. */
const CONNECTED_AFTER_SECONDS = 5;

/** Twilio's From for a real caller. Withheld IDs arrive as `anonymous`, `Restricted`, `+266696687`. */
const NANP_E164 = /^\+1\d{10}$/;

/** An outbound call the rep still owes a disposition for (blocks the next dial). */
export function needsDisposition(row: CallRow): boolean {
  return row.direction === 'outbound' && row.disposition == null && TERMINAL.includes(row.status);
}

/**
 * Pure — what the sync status column says. A bare "Local" used to cover three
 * different things: "not synced yet", "the ownership gate blocked this Task
 * from ever being written", and "the sync job gave up". Only the first is a
 * wait; the other two are final, and reading "Local" left the rep expecting a
 * Task that was never coming.
 */
export function recentSyncLabel(row: Pick<CallRow, 'salesforceTaskId' | 'syncError'>): string {
  if (row.salesforceTaskId) return 'Synced';
  if (row.syncError === 'not-owner') return 'Not synced · not owner';
  if (row.syncError === 'failed') return 'Not synced · failed';
  return 'Local';
}

/**
 * Pure — the number the row is about. For an inbound call that is the CALLER:
 * `normalizedToNumber` is our own DID, and headlining it made a missed 858
 * call read as a call to the rep's own 619 line ("can't find it").
 */
export function headlineNumber(row: Pick<CallRow, 'direction' | 'fromNumber' | 'normalizedToNumber'>): string {
  if (row.direction !== 'inbound') return formatE164(row.normalizedToNumber);
  return NANP_E164.test(row.fromNumber) ? formatE164(row.fromNumber) : 'Unknown caller';
}

type ClassifiableRow = Pick<
  CallRow,
  'direction' | 'status' | 'disposition' | 'durationSeconds' | 'answeredAt' | 'inboundVoicemailUrl'
>;

/**
 * Pure — the icon / badge / subtitle family a row belongs to. Inbound and
 * outbound rows carry different evidence: an outbound call has a disposition
 * and a ring-vs-talk duration; an inbound call has the dial-result stamp
 * (`answeredAt`) and whether the caller reached voicemail. Both a rep answer
 * and a finished voicemail end with status `completed`, so status alone cannot
 * separate them.
 */
export function classify(row: ClassifiableRow): CallKind {
  return row.direction === 'inbound' ? classifyInbound(row) : classifyOutbound(row);
}

function classifyInbound(row: ClassifiableRow): CallKind {
  if (row.answeredAt) return 'connected';
  if (row.inboundVoicemailUrl) return 'voicemail';
  if (INBOUND_MISSED_STATUSES.includes(row.status)) return 'missed';
  // Live (ringing, or on the line): `answeredAt` lands only when the leg ends.
  // Rendered as "In progress", never as a miss.
  if (row.status === 'in_progress') return 'connected';
  // Legacy fallback: a `completed` row written before the server stamped
  // `answeredAt`, with no voicemail. Duration is the only evidence left — a
  // few seconds is a hang-up, anything longer was a conversation.
  return (row.durationSeconds ?? 0) > CONNECTED_AFTER_SECONDS ? 'connected' : 'missed';
}

// Exactly the rule the list has always applied to outbound rows.
function classifyOutbound(row: ClassifiableRow): CallKind {
  if (row.disposition === 'Connected' || (row.durationSeconds ?? 0) > CONNECTED_AFTER_SECONDS) return 'connected';
  if (row.status === 'no_answer' || row.status === 'busy' || row.status === 'failed') return 'missed';
  return 'outgoing';
}

const INBOUND_SUBTITLE: Record<Exclude<CallKind, 'outgoing'>, string> = {
  connected: 'Answered',
  voicemail: 'Voicemail',
  missed: 'Missed call',
};

/** The `meta` line after the relative time: what happened, in the rep's words. */
function subtitle(row: CallRow, kind: CallKind): string {
  // Ringing or being talked to right now — either way not yet "Answered".
  if (row.direction === 'inbound' && row.status === 'in_progress') return 'In progress';
  if (row.direction === 'inbound' && kind !== 'outgoing') return INBOUND_SUBTITLE[kind];
  return row.disposition ?? row.status.replace(/_/g, ' ');
}

type IconComponent = (p: SVGProps<SVGSVGElement>) => JSX.Element;

function rowIcon(row: CallRow, kind: CallKind): IconComponent {
  if (kind === 'missed') return PhoneMissedIcon;
  if (kind === 'voicemail') return VoicemailIcon;
  if (kind === 'connected') return row.direction === 'inbound' ? PhoneIncomingIcon : CheckCircleIcon;
  return PhoneOutgoingIcon;
}

interface RecentCallRowProps {
  call: CallRow;
  /** Reopen a still-un-dispositioned call's wrap-up so the rep can finish it. */
  onReopen?: (call: CallRow) => void;
}

/** One row of the list. Exported so the rendering is testable without the fetch. */
export function RecentCallRow({ call, onReopen }: RecentCallRowProps): JSX.Element {
  const kind = classify(call);
  const Icon = rowIcon(call, kind);
  const pending = needsDisposition(call);
  const reopenable = pending && !!onReopen;
  const syncLabel = recentSyncLabel(call);
  const syncClass = syncLabel === 'Synced' ? 'sync ok' : syncLabel === 'Local' ? 'sync' : 'sync warn';
  return (
    <div
      className={`row-item ${kind} ${pending ? 'needs-disp' : ''} ${reopenable ? 'tappable' : ''}`}
      role={reopenable ? 'button' : undefined}
      tabIndex={reopenable ? 0 : undefined}
      onClick={reopenable ? () => onReopen!(call) : undefined}
      onKeyDown={reopenable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onReopen!(call); } : undefined}
      title={reopenable ? 'Finish disposition' : undefined}
    >
      <div className="dir"><Icon /></div>
      <div className="info">
        <div className="num">{headlineNumber(call)}</div>
        <div className="meta">{relativeTime(call.createdAt)} · {subtitle(call, kind)}</div>
      </div>
      <div className="right">
        <span className="dur">{formatDuration(call.durationSeconds)}</span>
        {pending
          ? <span className="sync needs">Finish →</span>
          : <span className={syncClass}>{syncLabel}</span>}
      </div>
    </div>
  );
}

interface RecentCallsProps {
  /** Reopen a still-un-dispositioned call's wrap-up so the rep can finish it. */
  onReopen?: (call: CallRow) => void;
}

export function RecentCalls({ onReopen }: RecentCallsProps): JSX.Element {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ calls: CallRow[] }>('/calls?limit=50');
        setCalls(data.calls);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="empty-state"><span className="spinner lg" /></div>;
  if (err) return <div className="empty-state bad">{err}</div>;
  if (calls.length === 0) {
    return (
      <div className="empty-state">
        <ClockIcon className="empty-icon" />
        No calls yet
        <span className="empty-hint">Your call history and Salesforce sync status will show up here.</span>
      </div>
    );
  }

  return (
    <div className="list">
      {calls.map((c) => <RecentCallRow key={c.id} call={c} onReopen={onReopen} />)}
    </div>
  );
}
