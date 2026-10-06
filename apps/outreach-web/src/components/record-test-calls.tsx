import { useEffect, useState } from 'react';
import type { AiCallStatus, RecordTestCall } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { appointmentWords, CALL_STATUS_WORDS, OUTCOME_WORDS, practiceAnswerWords } from '@/lib/call-words';
import { formatDateTime, humanize } from '@/lib/outreach-words';
import { AiCallTranscriptPanel } from './ai-call-transcript';
import { RecordTestDryRun } from './record-test-dry-run';

const PT = 'America/Los_Angeles';
const LIVE_STATUS: ReadonlySet<AiCallStatus> = new Set(['queued', 'ringing', 'in_progress', 'transferring']);
/** A call with no answer from cti-api yet counts as live this long (the server's own live-call rule). */
const PENDING_MS = 2 * 60_000;
/**
 * A placed call stops counting as live after this, joined or not: the longest call (cti-api AI_VOICE_MAX_CALL_SECONDS,
 * 10 minutes by default) plus a wide margin. Past it the page stops polling, and a status still "live" reads as unknown.
 */
const PLACED_CAP_MS = 30 * 60_000;
const STUCK_WORDS = 'Status unknown — check the transcript later';

const age = (c: RecordTestCall, now: number): number => now - Date.parse(c.createdAt);

/** Still ringing or talking, or just asked for: the page keeps polling and no new call may start. */
export function isLiveCall(c: RecordTestCall, now: number = Date.now()): boolean {
  if (c.callStatus) return LIVE_STATUS.has(c.callStatus) && age(c, now) < PLACED_CAP_MS;
  if (c.result && c.result.result !== 'placed') return false;
  return age(c, now) < (c.result ? PLACED_CAP_MS : PENDING_MS);
}

const minutes = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The clock, ticking each second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [on]);
  return on ? Math.max(now, Date.now()) : now;
}

/**
 * A record test's calls, newest first (plan 1E, spec §4.4): how each went, what it learned and what it would have
 * booked, and on request what a real call would have written (Task 11). Nothing of it reached Salesforce.
 */
export function RecordTestCalls({ calls }: { calls: readonly RecordTestCall[] }) {
  if (calls.length === 0) return null;
  const newestFirst = [...calls].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    <section aria-label="Test calls" className="space-y-2">
      <h3 className="font-medium">Test calls</h3>
      {newestFirst.map((c) => <CallCard key={c.id} c={c} />)}
    </section>
  );
}

function CallCard({ c }: { c: RecordTestCall }) {
  const [open, setOpen] = useState(false);
  // A call past the live cap offers its transcript ("check the transcript later"); the dry run waits for a real end.
  const finished = c.aiCallId !== null && c.result?.result === 'placed' && !isLiveCall(c);
  const ended = finished && c.callStatus !== null && !LIVE_STATUS.has(c.callStatus);
  return (
    <article className="space-y-2 rounded-md border p-3 text-sm">
      <p className="text-muted-foreground">{`${c.mode === 'phone' ? `Your phone${c.toE164 ? ` (${c.toE164})` : ''}` : 'This browser'} · ${formatDateTime(c.createdAt)}`}</p>
      <CallState c={c} />
      {c.summary && <p>{c.summary}</p>}
      <Learned qualification={c.qualification} />
      {c.callbackAt && <p>{`Asked for a call back: ${formatDateTime(c.callbackAt)}`}</p>}
      {c.appointment && <p className="font-medium">{`Would have booked: ${appointmentWords(c.appointment, PT)} PT`}</p>}
      {finished && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>{open ? 'Hide transcript' : 'Transcript'}</Button>
        </div>
      )}
      {open && c.aiCallId && <AiCallTranscriptPanel aiCallId={c.aiCallId} />}
      {ended && <RecordTestDryRun call={c} />}
    </article>
  );
}

function CallState({ c }: { c: RecordTestCall }) {
  if (c.result === null) {
    return <p className="text-muted-foreground">{isLiveCall(c) ? 'Asking the AI calling service…' : 'No answer from the AI calling service'}</p>;
  }
  if (c.result.result !== 'placed') return <p>{practiceAnswerWords(c.result)}</p>;
  if (c.outcome) return <p className="font-medium">{`${OUTCOME_WORDS[c.outcome]}${c.durationSeconds !== null ? ` · ${minutes(c.durationSeconds)}` : ''}`}</p>;
  return <LiveState c={c} />;
}

/** A placed call with no outcome yet: its status and how long it has been going, or unknown once past the cap. */
function LiveState({ c }: { c: RecordTestCall }) {
  const live = isLiveCall(c);
  const now = useNow(live);
  const status = c.callStatus;
  if (!live && (status === null || LIVE_STATUS.has(status))) return <p className="text-muted-foreground">{STUCK_WORDS}</p>;
  if (!live || status === null) return <p>{status ? CALL_STATUS_WORDS[status] : 'Placed'}</p>;
  return <p role="status">{`${CALL_STATUS_WORDS[status]} · ${minutes(Math.max(0, Math.floor(age(c, now) / 1_000)))}`}</p>;
}

function Learned({ qualification }: { qualification: Record<string, string> }) {
  const entries = Object.entries(qualification);
  if (entries.length === 0) return null;
  return (
    <div>
      <p className="font-medium">What it learned</p>
      <ul aria-label="What it learned" className="text-xs">
        {entries.map(([key, value]) => <li key={key}><span className="text-muted-foreground">{humanize(key)}:</span> {value}</li>)}
      </ul>
    </div>
  );
}
