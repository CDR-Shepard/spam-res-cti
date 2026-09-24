/**
 * Power dialer control panel. With no run active it shows the list-view picker
 * (pick an object + one of the rep's Salesforce list views → dial it). During a
 * run it shows progress, the current record, and controls (pause/resume, skip,
 * stop, next), polling the session every ~2 s (1 s while a dial is ringing) — every 1s while a dial is in
 * flight (see pollDelayMs).
 * A run is created READY and shows a confirm block (ConfirmBlock) until the rep
 * presses Start dialing; only then is the engine told to dial and the softphone
 * joins the run's conference (in that order — see startDialingSequence).
 *
 * Screen-pop: the panel calls `onScreenPop(recordId)` once per record the moment
 * it connects to a live human (see `shouldScreenPop`) — never for voicemail.
 * The caller (App) maps that to Open CTI `screenPopRecord`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HoldMusicSetting } from '@cti/contracts';
import {
  dialerControl,
  getDialer,
  getSalesforceListViews,
  OBJECT_LABELS,
  type DialerControlAction,
  type DialerCurrentItem,
  type DialerObjectType,
  type DialerSession,
  type DialerSessionCounts,
  type DialerSessionView,
  type SalesforceListView,
} from '../dialer-api';
import { formatE164 } from '../format';
import { ApiError } from '../api';
import type { LineAudio } from '../line-audio';
import { YouTubeHoldPlayer } from './YouTubeHoldPlayer';

const POLL_INTERVAL_MS = 2000;
/** While a dial is in flight. The panel only LEARNS a record connected by
 *  polling, so the poll cadence is a floor on how late the screen-pop can be —
 *  and a rep hearing "hello?" before the name is the complaint this answers. */
const POLL_INTERVAL_IN_FLIGHT_MS = 1000;
const TERMINAL_STATUSES = new Set(['done', 'stopped']);
/** The current-item statuses during which the NEXT poll can flip the pop. */
/** The fast cadence is for the RING: the pop is decided by the first poll that
 *  sees `connected`, and after that the rep talks for minutes with nothing to
 *  learn until Next (which re-polls on its own). Holding 1 s through the
 *  conversation would double the load for the whole run and buy nothing. */
const FAST_POLL_ITEM_STATUSES = new Set(['dialing']);
/** A poll that never settles — a laptop that slept mid-poll wakes with a
 *  half-open socket Chrome can hold for minutes — must not freeze the loop:
 *  the next poll is armed only when this one settles. Abort it, and let the
 *  usual error path re-arm. */
export const POLL_TIMEOUT_MS = 10_000;

/**
 * Pure — how long to wait before the next poll, given the view the last one
 * fetched. 1s while the current record is dialing; 2s everywhere else (no view
 * yet, idle, connected, a settled miss, a terminal run).
 */
export function pollDelayMs(view: DialerSessionView | null): number {
  const status = view?.currentItem?.status;
  return status !== undefined && FAST_POLL_ITEM_STATUSES.has(status) ? POLL_INTERVAL_IN_FLIGHT_MS : POLL_INTERVAL_MS;
}
/**
 * How long, after a run first goes terminal, we keep polling for its follow-up
 * rollovers to finish. The rollover worker ticks every ~5s and then makes two or
 * three Salesforce round-trips per job, so a rep who reaches the summary screen
 * is always ahead of it. Bounded so a wedged or backed-off queue (retries stretch
 * to ~63 min) can't leave the panel polling forever.
 */
export const ROLLOVER_SETTLE_MS = 60_000;

/**
 * Records that have reached a terminal disposition — dialed-and-dispositioned
 * (`done`), no-answer/busy/machine (`noConnect`), rep-skipped (`skipped`), or
 * no number to dial (`unreachable`). NOT `connected` (rep is on the call) or
 * `pending`/dialing (not finished). This is what "X of N done" should reflect —
 * counting only `done` left the bar at "0 of N" for any run nobody answered.
 */
export function processedCount(counts: DialerSessionCounts): number {
  return counts.done + counts.noConnect + counts.skipped + counts.unreachable;
}

/** Pure — "3 of 20 done · 1 connected · 2 skipped". */
export function progressLabel(counts: DialerSessionCounts): string {
  return `${processedCount(counts)} of ${counts.total} done · ${counts.connected} connected · ${counts.skipped} skipped`;
}

/**
 * Pure — the arithmetic the confirm block and the run line share.
 * `firstPassTotal` counts attempt-1 rows only (an attempt-2 retry row
 * appended mid-run would inflate a live total) and `unreachable` is fixed at
 * creation. Most breakdown keys read here are creation-stamped (the
 * skip-on-dialer flag, consent), so neither line drifts mid-run — an
 * out-of-hours skip the engine stamps at minute 40 adds a key this ignores.
 *
 * `cooldown` folds together TWO keys that are the same 3-hour rule seen from
 * two different code paths: `already_worked` is the queue-build ESTIMATE
 * (the team-wide dedupe read in `already-worked.ts`, using the same
 * `COOLDOWN_MS` window) and `cooldown` is the engine's own dial-time gate
 * (`contact-history.ts`) — one rule, one rep-facing number, never two (fix
 * round 1, finding 1). `daily_cap` similarly folds in the unverified
 * estimate `daily_cap_unverified` — the rep needs one number, not two.
 * `cooldown`/`daily_cap`(+unverified)/`in_progress_elsewhere` are, unlike the
 * rest, NOT purely creation-stamped: the engine can stamp them mid-run too,
 * and the rep is meant to see them the moment they show up (spec §5, skip
 * labels).
 */
export function queueParts(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): {
  total: number; skipOnDialer: number; consent: number; unreachable: number;
  cooldown: number; dailyCap: number; inProgressElsewhere: number; dialing: number;
} {
  const skipOnDialer = breakdown?.skip_on_dialer ?? 0;
  // Consent skips are creation-stamped too (opted out / blocked list / DNC).
  const consent = (breakdown?.opted_out ?? 0) + (breakdown?.blocked ?? 0) + (breakdown?.dnc_blocked ?? 0);
  const cooldown = (breakdown?.already_worked ?? 0) + (breakdown?.cooldown ?? 0);
  const dailyCap = (breakdown?.daily_cap ?? 0) + (breakdown?.daily_cap_unverified ?? 0);
  const inProgressElsewhere = breakdown?.in_progress_elsewhere ?? 0;
  const dialing = firstPassTotal - skipOnDialer - consent - unreachable - cooldown - dailyCap - inProgressElsewhere;
  return { total: firstPassTotal, skipOnDialer, consent, unreachable, cooldown, dailyCap, inProgressElsewhere, dialing };
}

/** Pure — the run line, e.g. "50 records · 18 called in the last 3 h · dialing 32". Zero parts omitted. */
export function queueLine(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): string {
  const q = queueParts(firstPassTotal, unreachable, breakdown);
  const parts = [`${q.total} records`];
  if (q.cooldown > 0) parts.push(`${q.cooldown} called in the last 3 h`);
  if (q.skipOnDialer > 0) parts.push(`${q.skipOnDialer} skipped by flag`);
  if (q.consent > 0) parts.push(`${q.consent} blocked by consent`);
  if (q.dailyCap > 0) parts.push(`${q.dailyCap} daily limit (state law)`);
  if (q.inProgressElsewhere > 0) parts.push(`${q.inProgressElsewhere} in progress in another run`);
  parts.push(`dialing ${q.dialing}`);
  return parts.join(' · ');
}

/**
 * Pure — the confirm block's line, e.g.
 * "187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked".
 * Leads with the figure the rep is deciding on; zero parts omitted.
 */
export function confirmLine(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): string {
  const q = queueParts(firstPassTotal, unreachable, breakdown);
  const parts = [`${q.dialing} will be dialed`];
  if (q.cooldown > 0) parts.push(`${q.cooldown} called in the last 3 h`);
  if (q.skipOnDialer > 0) parts.push(`${q.skipOnDialer} skipped by flag`);
  if (q.unreachable > 0) parts.push(`${q.unreachable} no number`);
  if (q.consent > 0) parts.push(`${q.consent} blocked`);
  if (q.dailyCap > 0) parts.push(`${q.dailyCap} daily limit (state law)`);
  if (q.inProgressElsewhere > 0) parts.push(`${q.inProgressElsewhere} in progress in another run`);
  return parts.join(' · ');
}

/** Pure — "A, B and C" (no Oxford comma); "A and B" for two; the bare name for
 *  one. Shared by `confirmContextLine`'s "who else is on this list" clause. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Pure — the confirm block's "two reps, one list" line (spec §4), e.g.
 * "Garrett is on this list (record 87 of 220) — you'll start from 88." Shown
 * only when a start position exists (`startedFrom > 0` — a wrap to the top,
 * or no list-view run at all, means nothing to say). `startedFrom`/`total`
 * are the 0-based figures the server counts with; the rep-facing copy is
 * 1-based throughout ("record 87" = the 88th record is next).
 */
export function confirmContextLine(
  ctx: { total: number; startedFrom: number; workedBy: string[] } | null | undefined,
): string | null {
  if (!ctx || ctx.startedFrom <= 0) return null;
  const { total, startedFrom, workedBy } = ctx;
  const nextRecord = startedFrom + 1;
  if (workedBy.length === 0) {
    return `You're on this list (record ${startedFrom} of ${total}) — you'll start from ${nextRecord}.`;
  }
  const verb = workedBy.length === 1 ? 'is' : 'are';
  return `${joinNames(workedBy)} ${verb} on this list (record ${startedFrom} of ${total}) — you'll start from ${nextRecord}.`;
}

/** Miss reason → rep-facing words, in the order the miss line lists them.
 *  Keys are the server's `DialOutcome` values (plus the legacy `no_connect`
 *  rows written before reasons existed, and the tally's `other`). */
const MISS_LABELS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['voicemail', 'voicemail'],
  ['no_answer', 'no answer'],
  ['busy', 'busy'],
  ['failed', 'bad number'],
  ['fax', 'fax'],
  ['canceled', 'canceled'],
  ['hangup', 'hung up'],
  ['no_connect', 'no connect'],
  ['other', 'other'],
];

/** Pure — "12 voicemail · 4 no answer · 2 bad number"; '' with no misses.
 *  Known reasons in a fixed order; anything the server adds later trails
 *  under its own key so it is never silently dropped. */
export function missLine(breakdown?: Record<string, number>): string {
  if (!breakdown) return '';
  const known = new Set(MISS_LABELS.map(([k]) => k));
  const named = MISS_LABELS
    .filter(([k]) => (breakdown[k] ?? 0) > 0)
    .map(([k, label]) => `${breakdown[k]} ${label}`);
  const rest = Object.keys(breakdown)
    .filter((k) => !known.has(k) && (breakdown[k] ?? 0) > 0)
    .sort()
    .map((k) => `${breakdown[k]} ${k.replace(/_/g, ' ')}`);
  return [...named, ...rest].join(' · ');
}

const OUTCOME_LABELS: Record<string, string> = {
  voicemail: 'Voicemail', no_answer: 'No answer', busy: 'Busy', failed: 'Bad number',
  fax: 'Fax', canceled: 'Canceled', hangup: 'Hung up',
};
const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued', dialing: 'Dialing', connected: 'Connected', done: 'Done',
  skipped: 'Skipped', unreachable: 'No number', no_connect: 'No connect',
  failed: 'Bad number',
};

/** Pure — the current record's one-phrase state; a miss shows its reason. */
export function itemStatusLabel(item: Pick<DialerCurrentItem, 'status' | 'outcome'>): string {
  const outcomeLabel = item.status === 'no_connect' && item.outcome ? OUTCOME_LABELS[item.outcome] : undefined;
  if (outcomeLabel) return outcomeLabel;
  return STATUS_LABELS[item.status] ?? item.status.replace(/_/g, ' ');
}

/**
 * Pure — the Start-dialing sequence, in this order and no other:
 *  1. `prepare` — the softphone readies its Device and refuses if a call is
 *     up (fails fast, before anything rings);
 *  2. `control('start')` — the engine flips the run active and originates
 *     the first call. A 409 proves the session is still `ready` (the rep's
 *     other run holds the one-active-run index) — nothing was flipped, so
 *     it's left for the confirm block, which offers to stop the other run.
 *     Anything else proves nothing: the server may have flipped this session
 *     `active` before failing (a first originate that threw), leaving no
 *     conference leg joined — that would bridge the next human into an empty
 *     room, so a non-409 failure sends a best-effort `stop` before rethrowing;
 *  3. `join` — the softphone joins the run's conference. Ring + AMD take
 *     seconds; the join takes about one, so the first human still finds the
 *     rep in the room.
 * A `join` that throws after the engine is already dialing stops the run
 * (best effort) and rethrows — prospects must not ring into an empty room.
 * A `join` that resolves false means a stop or newer run superseded it.
 */
export async function startDialingSequence(
  prepare: () => Promise<void>,
  control: (action: DialerControlAction) => Promise<void>,
  join: () => Promise<boolean>,
): Promise<'started' | 'superseded'> {
  await prepare();
  try {
    await control('start');
  } catch (e) {
    // A 409 proves the session is still `ready` (the rep's other run holds
    // the one-active-run index) — leave it for the confirm block, which
    // offers to stop the other run. Anything else proves nothing: the server
    // may have flipped this session active before failing (a first originate
    // that threw), and an active run with no rep leg would bridge every human
    // into an empty room. Stop it, best effort, then surface the error.
    if (!(e instanceof ApiError && e.status === 409)) {
      try { await control('stop'); } catch { /* the poll shows whatever state the run is in */ }
    }
    throw e;
  }
  try {
    return (await join()) ? 'started' : 'superseded';
  } catch (e) {
    try { await control('stop'); } catch { /* the poll shows whatever state the run is in */ }
    throw e;
  }
}

/** The server's `{ error }` sentence when there is one; otherwise the fallback. */
function controlErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.data && typeof e.data === 'object') {
    const msg = (e.data as { error?: unknown }).error;
    if (typeof msg === 'string') return msg;
  }
  return e instanceof Error ? e.message : fallback;
}

/** Pure — the other run's id from a 409 body, if the server named one. */
export function conflictingSessionId(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409 || !e.data || typeof e.data !== 'object') return null;
  const id = (e.data as { activeSessionId?: unknown }).activeSessionId;
  return typeof id === 'string' && id ? id : null;
}

/** Pure — which dialerControl action the toggle button sends next. */
export function pauseResumeAction(status: DialerSession['status']): DialerControlAction {
  return status === 'paused' ? 'resume' : 'pause';
}

/**
 * Pure — which controls the current item's row offers (spec §5). `null`,
 * `pending` or `dialing` (nothing connected yet): Skip, same as always. A
 * live connected call, prospect still on the line: End call or Next. Once
 * the prospect has hung up (`prospectEndedAt` stamped by the engine's
 * `handleDialOutcome`) the item stays `connected` and the run waits on the
 * rep's choice: Redial or Resume (Next, relabeled — see `ItemControls`).
 */
export function controlsFor(item: DialerCurrentItem | null): Array<'skip' | 'end' | 'next' | 'redial'> {
  if (item?.status !== 'connected') return ['skip'];
  return item.prospectEndedAt ? ['redial', 'next'] : ['end', 'next'];
}

/**
 * Pure — which dialerControl actions a control-set button sends, given the
 * run's status. `redialCurrent` and `repNext` both no-op the actual dial on a
 * paused session (the inserted copy, or the closed-out item, just sits
 * `pending` — see engine.ts) so Redial and Next ("Resume") must also send
 * `resume` on a paused run: the rep should never need a second click to get
 * dialing again. Every other button — and these two on an already-active
 * run — is a single action.
 */
export function actionsFor(
  button: 'skip' | 'end' | 'next' | 'redial',
  sessionStatus: DialerSession['status'],
): DialerControlAction[] {
  if (sessionStatus === 'paused' && (button === 'next' || button === 'redial')) {
    return [button, 'resume'];
  }
  return [button];
}

/**
 * Pure — run `actions` through `run` in order, stopping at the first
 * failure: `run` (the panel's `runControl`) already shows that failure's
 * error, so nothing after it should fire. Resolves true only when every
 * action succeeded.
 */
export async function runSequence(
  actions: DialerControlAction[],
  run: (action: DialerControlAction) => Promise<boolean>,
): Promise<boolean> {
  for (const action of actions) {
    if (!(await run(action))) return false;
  }
  return true;
}

/**
 * Pure — a control-set button's whole request, busy included: `setBusy` is
 * called exactly twice — true before `runSequence` starts, false once it
 * settles (success, failure, or a thrown error) — never toggled in between.
 * Fix round 1 (finding 3): the panel used to run each chained action through
 * its own busy true→false window, so a paused-run Redial (send `redial`,
 * then `resume` — see `actionsFor`) had a real false→true gap between the
 * two requests where a second click could double-fire. `send` is the raw
 * per-action network call (`sendControl` in the panel) — it must NOT touch
 * busy itself, or this guarantee breaks.
 */
export async function runControlsSequence(
  actions: DialerControlAction[],
  send: (action: DialerControlAction) => Promise<boolean>,
  setBusy: (busy: boolean) => void,
): Promise<boolean> {
  setBusy(true);
  try {
    return await runSequence(actions, send);
  } finally {
    setBusy(false);
  }
}

/** Pure — pop the record ONLY for a live human. AMD hangs up machines before the
 *  rep is bridged, so `connected` ⇒ a person; voicemail never pops. */
export function shouldScreenPop(item: DialerCurrentItem | null): boolean {
  return item?.status === 'connected';
}

/** Pure — "m:ss" until the next retry; clamps at 0:00. */
export function retryCountdown(nextRetryAt: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(nextRetryAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Pure — the run-summary rollover line; '' when there is nothing to say.
 *
 * Failures are ALWAYS appended, never only reported when nothing else happened:
 * a {moved: 8, failed: 3} run used to read "8 follow-ups moved to tomorrow" and
 * quietly drop the three the rep needs an admin to chase. The noun is carried by
 * whichever clause comes first, so the line reads as one sentence.
 */
export function rolloverLine(r: { moved: number; pushed: number; failed: number }): string {
  const parts: string[] = [];
  if (r.moved) parts.push(`${r.moved} follow-up${r.moved === 1 ? '' : 's'} moved to tomorrow`);
  if (r.pushed) parts.push(`${r.pushed} pushed later (daily limit)`);
  if (r.failed) {
    parts.push(parts.length
      ? `${r.failed} could not be moved — see admin`
      : `${r.failed} follow-up${r.failed === 1 ? '' : 's'} could not be moved — see admin`);
  }
  return parts.join(' · ');
}

/**
 * Pure — should the poll keep running after the run has already ended?
 *
 * The run-summary rollover line was unreachable in practice: polling stopped the
 * instant the session went terminal, which is seconds before the follow-up worker
 * (5s tick + Salesforce round-trips) has processed any of the jobs — so
 * `rollovers` was always `{pending: N}` and `rolloverLine` rendered ''. Teardown
 * (`onComplete`) still fires exactly once at that first terminal poll; only the
 * polling continues, until the rollovers settle or `ROLLOVER_SETTLE_MS` elapses.
 */
export function shouldKeepPollingForRollovers(
  view: DialerSessionView,
  firstTerminalAt: number,
  now: number,
): boolean {
  if (!TERMINAL_STATUSES.has(view.session.status)) return false;
  if (!view.rollovers || view.rollovers.pending <= 0) return false;
  return now - firstTerminalAt < ROLLOVER_SETTLE_MS;
}

export function AttemptBadge({ attempt }: { attempt?: number }): JSX.Element | null {
  return attempt === 2 ? <span className="dp-attempt">Attempt 2 of 2</span> : null;
}

/**
 * Pure — should this poll tick tear the run down? A run tears down exactly once,
 * the moment it first reaches a terminal status (`done` when it finishes on its
 * own, `stopped` when ended remotely), so the rep's long-lived conference leg is
 * released from the single Twilio Device. Without this, a run that ENDS BY ITSELF
 * (nobody presses Stop) leaves that leg connected and the next manual call is
 * rejected — "a call is already in progress." `alreadyTornDown` is the caller's
 * latch (a ref) so repeated terminal polls don't re-fire the teardown.
 */
export function shouldTeardownRun(status: DialerSession['status'], alreadyTornDown: boolean): boolean {
  return !alreadyTornDown && TERMINAL_STATUSES.has(status);
}

/** Status dot color for the current record's dial outcome. */
function dotClassForItemStatus(status: string): string {
  if (status === 'connected') return 'ok';
  if (status === 'no_connect' || status === 'unreachable' || status === 'failed') return 'bad';
  if (status === 'skipped') return 'dim';
  return 'warn';
}

export interface DialerPanelProps {
  /** Active session id, owned by the parent — null means no run in progress. */
  sessionId: string | null;
  /**
   * Called once per record the moment it connects to a human (see
   * shouldScreenPop) — voicemail and no-connects never pop.
   */
  onScreenPop: (recordId: string) => void;
  /** Start a run from a Salesforce list view (parent creates the session). */
  onStartFromListView: (object: DialerObjectType, listViewId: string) => Promise<void>;
  /**
   * The rep pressed Start dialing: ready the softphone's Device, and THROW if
   * the softphone is on or ringing a call. Runs BEFORE `start`, so nothing
   * rings on a softphone that cannot take the run.
   */
  onPrepare: () => Promise<void>;
  /**
   * Join the softphone to the run's Twilio conference; resolves true once the
   * leg is up, false if a stop or a newer run superseded it meanwhile. Runs
   * AFTER `start` succeeded — see startDialingSequence.
   */
  onJoin: () => Promise<boolean>;
  /** Called when the rep stops the run from the Stop control. */
  onStop: () => void;
  /**
   * Called once when the run reaches a terminal status without the rep pressing
   * Stop — it finished on its own (`done`) or was ended remotely (`stopped`).
   * The parent releases the rep's conference leg (freeing the single Twilio Device
   * for the next call) but keeps the session, so this panel's completion summary
   * stays on screen until the rep dismisses it via onDismiss.
   */
  onComplete: (result: { status: DialerSession['status']; counts: DialerSessionCounts }) => void;
  /**
   * Dismiss a finished/stopped run's summary and return to the list-view picker
   * (the summary's "Start another run" CTA). Clears the parent's session id.
   */
  onDismiss: () => void;
  /** The rep's hold-music choice (from `/auth/me`, via `holdMusicFromMe` in
   *  App.tsx) — drives whether the YouTube player mounts (see HoldMusicPlayer). */
  holdMusic?: HoldMusicSetting;
  /** The dialer leg's line-audio tracker (App.tsx's `lineAudio`) — handed
   *  straight through to the YouTube player so it can pause the instant the
   *  line stops being silent (see line-audio.ts). */
  lineAudio?: LineAudio;
}

/**
 * The YouTube hold player, mounted right under the current-record card for a
 * run's whole active/paused stretch — one player per run (`key={session.id}`)
 * so the ~1-2 s poll re-renders never tear it down and restart it. Pulled out
 * as its own prop-only piece (like CurrentRecord/ConfirmBlock above) because
 * DialerPanel's data-fetching effect never runs under `renderToStaticMarkup`,
 * so this mount decision needs to be directly renderable in the SSR tests.
 */
export function HoldMusicPlayer({ view, holdMusic, lineAudio }: {
  view: Pick<DialerSessionView, 'session' | 'currentItem'>;
  holdMusic?: HoldMusicSetting;
  lineAudio?: LineAudio;
}): JSX.Element | null {
  const youtube = holdMusic?.choice === 'youtube' ? holdMusic.youtube : null;
  if (!youtube) return null; // preset choice, off, or YouTube with no stored ids yet
  const { status } = view.session;
  if (status !== 'active' && status !== 'paused') return null; // ready/done/stopped: nothing to hold for
  return (
    <YouTubeHoldPlayer
      key={view.session.id}
      youtube={youtube}
      sessionStatus={status}
      currentItem={view.currentItem}
      lineAudio={lineAudio}
    />
  );
}

export function CurrentRecord({ item, listTotal }: { item: DialerCurrentItem; listTotal?: number | null }): JSX.Element {
  const number = formatE164(item.toNumber) || item.toNumber || 'No number';
  // The name is the headline from the moment the row is dialing — before the
  // record pops on `connected` — so the rep knows who is about to say hello.
  // Without one (a row from before migration 0041, or a record with no Name)
  // the number keeps exactly the layout it always had.
  const name = item.displayName?.trim() || null;
  // Two reps, one list (spec §4): 1-based from the 0-based `listPosition` —
  // shown only when BOTH the item's own position and the run's list total are
  // known (a non-list-view run, or an older server, has neither).
  const listLine = item.listPosition != null && listTotal != null
    ? `record ${item.listPosition + 1} of ${listTotal}`
    : null;
  // The prospect hung up on a connected call (spec §5): name it plainly. A
  // muted-red dot, not the sharp red `dotClassForItemStatus` gives a genuine
  // miss (busy/failed/no_connect) — this isn't a failure, it's a decision
  // (Redial or Resume) waiting on the rep.
  const hungUp = Boolean(item.prospectEndedAt);
  return (
    <div className="section dp-current">
      <div className="kicker">Current record</div>
      {name && <div className="dp-current-name">{name}</div>}
      <div className={name ? 'dp-current-number dp-current-number-sub tnum' : 'dp-current-number tnum'}>{number}</div>
      <div className="dp-current-meta">
        <span className={`cdot ${hungUp ? 'hangup' : dotClassForItemStatus(item.status)}`} />
        {hungUp ? 'They hung up' : `${item.objectType} · ${itemStatusLabel(item)}`}
      </div>
      {listLine && <div className="dp-current-list-position">{listLine}</div>}
      {item.fromNumber && <div className="dp-current-from">from {formatE164(item.fromNumber)}</div>}
      <AttemptBadge attempt={item.attempt} />
    </div>
  );
}

export interface SessionToggleProps {
  status: DialerSession['status'];
  /** True once the prospect has hung up (`prospectEndedAt` stamped) — the
   *  hung-up choice (Redial/Resume, see `ItemControls`) is showing, so this
   *  button must not render (fix round 1, finding 2: no two buttons with the
   *  same label — "Resume" can only mean the rep's choice). */
  hungUp: boolean;
  busy: boolean;
  onClick: () => void;
}

/**
 * The session-level Pause/Resume button — absent (renders nothing) while
 * `hungUp`, on an active OR a paused run: a mutation that always showed it
 * passed the full suite at 80/80 (fix round 1), which is why this is its own
 * directly-testable, prop-only component rather than an inline `{!hungUp &&
 * ...}` in `DialerPanel`'s JSX.
 */
export function SessionToggle({ status, hungUp, busy, onClick }: SessionToggleProps): JSX.Element | null {
  if (hungUp) return null;
  return (
    <button className="btn" disabled={busy} onClick={onClick}>
      {status === 'paused' ? 'Resume' : 'Pause'}
    </button>
  );
}

export interface ItemControlsProps {
  /** The run's current item — null and every non-connected status render Skip. */
  item: DialerCurrentItem | null;
  busy: boolean;
  onSkip: () => void;
  onEnd: () => void;
  onNext: () => void;
  onRedial: () => void;
}

/**
 * The current item's control buttons, chosen by `controlsFor` (spec §5):
 * Skip while nothing is connected; End call + Next on a live call; Redial +
 * Resume (Next, relabeled) once the prospect has hung up. Session-level
 * Pause/Resume and Stop are rendered by the caller (`DialerPanel`), not
 * here — the caller also hides Pause/Resume while the hung-up choice is
 * showing, so "Resume" never appears twice.
 */
export function ItemControls({ item, busy, onSkip, onEnd, onNext, onRedial }: ItemControlsProps): JSX.Element {
  const controls = controlsFor(item);
  const hungUp = Boolean(item?.prospectEndedAt);
  return (
    <>
      {controls.includes('skip') && (
        <button className="btn" disabled={busy} onClick={onSkip}>Skip</button>
      )}
      {controls.includes('end') && (
        <button className="btn" disabled={busy} onClick={onEnd}>End call</button>
      )}
      {controls.includes('redial') && (
        <button className="btn" disabled={busy} onClick={onRedial}>Redial</button>
      )}
      {controls.includes('next') && (
        <button className="btn primary" disabled={busy} onClick={onNext}>{hungUp ? 'Resume' : 'Next'}</button>
      )}
    </>
  );
}

/**
 * The no-run state: pick an object + one of the rep's Salesforce list views and
 * start dialing it. The CTI pulls the list's records via the rep's SF token —
 * no Salesforce list-view button needed (the Lightning Console won't hand a
 * custom button the row selection).
 */
function ListViewPicker({
  onStart,
}: {
  onStart: (object: DialerObjectType, listViewId: string) => Promise<void>;
}): JSX.Element {
  const [object, setObject] = useState<DialerObjectType>('Lead');
  const [listViews, setListViews] = useState<SalesforceListView[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setListViews(null);
    setSelected('');
    getSalesforceListViews(object)
      .then((r) => { if (!cancelled) setListViews(r.listViews); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your list views.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [object]);

  const dial = async (): Promise<void> => {
    if (!selected) return;
    setStarting(true);
    try {
      await onStart(object, selected);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Power dial a list</div>
        <div className="row dp-picker-obj">
          {(['Lead', 'Opportunity', 'Task'] as const).map((o) => (
            <button
              key={o}
              className={`btn ${object === o ? 'active' : ''}`}
              disabled={starting}
              onClick={() => setObject(o)}
            >
              {OBJECT_LABELS[o]}
            </button>
          ))}
        </div>
        {loading && <div className="empty-hint"><span className="spinner" /> Loading your list views…</div>}
        {error && <div className="dp-error">{error}</div>}
        {listViews && listViews.length === 0 && (
          <div className="empty-hint">No {OBJECT_LABELS[object]} list views found.</div>
        )}
        {listViews && listViews.length > 0 && (
          <>
            <select
              className="dp-picker-select"
              value={selected}
              disabled={starting}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choose a list view…</option>
              {listViews.map((lv) => (
                <option key={lv.id} value={lv.id}>{lv.label}</option>
              ))}
            </select>
            <button className="btn primary full" disabled={!selected || starting} onClick={() => void dial()}>
              {starting ? 'Checking records…' : 'Dial this list'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The run was created READY: the queue is built, nothing has dialed. Show the
 * rep what the list came to and let them start it — or back out, which stops
 * the (never-started) session and returns to the picker.
 */
export function ConfirmBlock({
  view,
  busy,
  error,
  onStartDialing,
  onChooseAnother,
  onStopOther,
}: {
  view: DialerSessionView;
  busy: boolean;
  error: string | null;
  onStartDialing: () => void;
  onChooseAnother: () => void;
  /** Present only when a refused Start named the rep's OTHER active run —
   *  renders the way to stop it without leaving this screen. */
  onStopOther?: () => void;
}): JSX.Element {
  const contextLine = confirmContextLine(view.listContext);
  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Ready to dial</div>
        <div className="dp-queue-line">
          {confirmLine(view.firstPassTotal ?? view.counts.total, view.counts.unreachable, view.skipBreakdown)}
        </div>
        {contextLine && <div className="dp-queue-line dp-list-context">{contextLine}</div>}
        {error && <div className="dp-error">{error}</div>}
        <button className="btn primary full" disabled={busy} onClick={onStartDialing}>
          {busy ? 'Starting…' : 'Start dialing'}
        </button>
        {onStopOther && (
          <button className="btn full" disabled={busy} onClick={onStopOther}>
            Stop the other run
          </button>
        )}
        <button className="btn full" disabled={busy} onClick={onChooseAnother}>
          Choose a different list
        </button>
      </div>
    </div>
  );
}

export function DialerPanel(props: DialerPanelProps): JSX.Element {
  const { sessionId, onScreenPop, onStartFromListView, onPrepare, onJoin, onStop, onComplete, onDismiss, holdMusic, lineAudio } = props;
  const [view, setView] = useState<DialerSessionView | null>(null);
  // The poll owns `error` (a failed refresh); control actions own
  // `controlError` (a refused pause/skip/stop/next/start), so a successful
  // poll tick cannot erase what a control action just told the rep.
  const [error, setError] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  // The id a refused Start (409) named as the rep's OTHER active run, or null.
  // Set only by handleStartDialing's catch; cleared by every control action and
  // by the effect's per-session reset, so it can never outlive its 409.
  const [conflictSessionId, setConflictSessionId] = useState<string | null>(null);
  // Ticks every second so the retry countdown re-renders without waiting on
  // the ~2 s (1 s while a dial is ringing) poll.
  const [now, setNow] = useState(() => Date.now());

  // Id of the last currentItem we screen-popped for — pop once per NEW
  // connected item, not on every ~2 s (1 s while a dial is ringing) poll.
  const lastPoppedIdRef = useRef<string | null>(null);
  // Lets a control action (pause/skip/...) trigger an immediate re-poll
  // instead of waiting up to 2s for the next tick.
  const pollNowRef = useRef<() => void>(() => {});
  // Latch so the terminal-status teardown (onComplete) fires exactly once per run.
  const completedRef = useRef(false);
  // When this run FIRST reported a terminal status — the clock the rollover
  // settle window is measured from. Null until then.
  const firstTerminalAtRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    lastPoppedIdRef.current = null;
    pollNowRef.current = () => {};
    completedRef.current = false;
    firstTerminalAtRef.current = null;

    if (!sessionId) {
      setView(null);
      setError(null);
      setControlError(null);
      setConflictSessionId(null);
      return;
    }

    setView(null);
    setError(null);
    setControlError(null);
    setConflictSessionId(null);

    let cancelled = false;
    // ONE slot for the next poll. Self-rescheduled rather than an interval so
    // each tick's delay can follow the view the last tick fetched (see
    // pollDelayMs), and so a control action's immediate re-poll cannot fork a
    // second chain of ticks: arming replaces whatever was pending.
    let timerId: ReturnType<typeof setTimeout> | undefined;
    // Latched by stopPolling: a stopped loop never re-arms — not even from the
    // immediate re-poll a control action fires after the stop.
    let stopped = false;

    const stopPolling = (): void => {
      stopped = true;
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
    };

    const armNextPoll = (delayMs: number): void => {
      if (cancelled || stopped) return;
      if (timerId !== undefined) clearTimeout(timerId);
      timerId = setTimeout(() => { void poll(); }, delayMs);
    };

    /** One poll: fetch and apply the view, and hand it back (null when the
     *  poll failed or the panel went away) so the caller can pace the next. */
    const pollOnce = async (): Promise<DialerSessionView | null> => {
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS);
      try {
        const next = await getDialer(sessionId, { signal: abort.signal });
        if (cancelled) return null;
        setView(next);
        setError(null);

        // Pop the record only for a live human (see shouldScreenPop) — not while
        // it is still ringing, and never for voicemail. Once per item.
        const current = next.currentItem;
        if (shouldScreenPop(current) && current && lastPoppedIdRef.current !== current.id) {
          lastPoppedIdRef.current = current.id;
          onScreenPop(current.recordId);
        }

        // The run reached a terminal status. If it got there WITHOUT the rep
        // pressing Stop (a run that finished on its own, or was ended remotely),
        // release the rep's conference leg via onComplete — the single Twilio
        // Device is otherwise left busy and the next call fails. The latch keeps
        // this to exactly one fire even if a poll is already in flight when the
        // status flips.
        //
        // Polling, unlike the teardown, does NOT stop here: the follow-up
        // rollovers are still being written and the summary's rollover line
        // depends on them (see shouldKeepPollingForRollovers).
        if (TERMINAL_STATUSES.has(next.session.status)) {
          if (firstTerminalAtRef.current === null) firstTerminalAtRef.current = Date.now();
          if (shouldTeardownRun(next.session.status, completedRef.current)) {
            completedRef.current = true;
            onComplete({ status: next.session.status, counts: next.counts });
          }
          if (!shouldKeepPollingForRollovers(next, firstTerminalAtRef.current, Date.now())) stopPolling();
        }
        return next;
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not refresh the dialer session.');
        }
        return null;
      } finally {
        clearTimeout(deadline);
      }
    };

    const poll = async (): Promise<void> => {
      armNextPoll(pollDelayMs(await pollOnce()));
    };

    pollNowRef.current = () => { void poll(); };
    void poll();

    return () => {
      cancelled = true;
      stopPolling();
      pollNowRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // The raw per-action request — reports success/failure (not just void) so
  // a chain (runSequence/runControlsSequence) can stop at the first failure
  // instead of firing the next action into a run that just refused the last.
  // Deliberately does NOT touch controlBusy: that's owned by whichever
  // caller below wraps it (runControl for one action, runControls for a
  // chain that must hold busy across all of them — fix round 1, finding 3).
  const sendControl = useCallback((action: DialerControlAction): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false);
    return dialerControl(sessionId, action)
      .then(() => { pollNowRef.current(); return true; })
      .catch((e: unknown) => {
        setControlError(controlErrorMessage(e, `Could not ${action} the run.`));
        return false;
      });
  }, [sessionId]);

  // A single control action — Pause/Resume (session), Stop — owns its own
  // busy window: true for the one request, false once it settles.
  const runControl = useCallback((action: DialerControlAction): Promise<boolean> => {
    setControlBusy(true);
    setControlError(null);
    setConflictSessionId(null);
    return sendControl(action).finally(() => setControlBusy(false));
  }, [sendControl]);

  // A control-set button that may need more than one request on a paused run
  // (Redial/Resume — see actionsFor): busy is held for the WHOLE chain via
  // runControlsSequence, not toggled between the two requests — a real
  // false→true gap there let a second click double-fire mid-chain (fix
  // round 1, finding 3). A refused first action shows its error and the
  // chain never fires the second (runSequence stops at the first failure).
  const runControls = useCallback((actions: DialerControlAction[]): Promise<boolean> => {
    setControlError(null);
    setConflictSessionId(null);
    return runControlsSequence(actions, sendControl, setControlBusy);
  }, [sendControl]);

  // Await the stop control request BEFORE tearing down the parent's conference
  // leg (onStop) — calling onStop first would drop the rep's conference leg
  // even if the backend stop request hasn't gone out (or fails) yet. The Stop
  // button stays disabled (controlBusy) for the duration of the await.
  const handleStop = useCallback(() => {
    void (async () => {
      await runControl('stop');
      onStop();
    })();
  }, [runControl, onStop]);

  // Start dialing: ready the softphone (onPrepare), send `start`, THEN join the
  // conference (onJoin) — see startDialingSequence for why that order and no
  // other. busy covers the whole sequence so the button cannot double-fire; a
  // superseded join sends nothing and shows nothing — the rep chose to leave.
  const handleStartDialing = useCallback(() => {
    if (!sessionId) return;
    void (async () => {
      setControlBusy(true);
      setControlError(null);
      setConflictSessionId(null);
      try {
        // On success ('started' or 'superseded') there is nothing to show here —
        // the run screen takes over on the next poll, or the rep already left.
        await startDialingSequence(onPrepare, async (action) => {
          await dialerControl(sessionId, action);
          pollNowRef.current();
        }, onJoin);
      } catch (e: unknown) {
        setControlError(controlErrorMessage(e, 'Could not start the run.'));
        setConflictSessionId(conflictingSessionId(e));
      } finally {
        setControlBusy(false);
      }
    })();
  }, [onPrepare, onJoin, sessionId]);

  // The 409 named the rep's other active run (another tab, or a run wedged
  // by a closed tab). Stop THAT run, then the rep presses Start dialing again.
  const handleStopOther = useCallback(() => {
    if (!conflictSessionId) return;
    const other = conflictSessionId;
    void (async () => {
      setControlBusy(true);
      try {
        await dialerControl(other, 'stop');
        setConflictSessionId(null);
        setControlError(null);
      } catch (e: unknown) {
        setControlError(controlErrorMessage(e, 'Could not stop the other run.'));
      } finally {
        setControlBusy(false);
      }
    })();
  }, [conflictSessionId]);

  if (!sessionId) {
    return <ListViewPicker onStart={onStartFromListView} />;
  }

  if (!view) {
    return (
      <div className="empty-state">
        <span className="spinner lg" />
        {error && <span className="empty-hint">{error}</span>}
      </div>
    );
  }

  // A successful poll tick cannot erase what a control action just told the
  // rep — see the `error`/`controlError` split above.
  const shownError = controlError ?? error;
  const miss = missLine(view.missBreakdown);

  if (view.session.status === 'ready') {
    return (
      <ConfirmBlock
        view={view}
        busy={controlBusy}
        error={shownError}
        onStartDialing={handleStartDialing}
        onChooseAnother={handleStop}
        onStopOther={conflictSessionId ? handleStopOther : undefined}
      />
    );
  }

  const isTerminal = TERMINAL_STATUSES.has(view.session.status);
  const pct = view.counts.total > 0 ? Math.round((processedCount(view.counts) / view.counts.total) * 100) : 0;
  // The hung-up choice is showing (spec §5): SessionToggle hides itself
  // (decision — no two buttons with the same label) so "Resume" can only
  // mean the rep's choice, never a second, redundant control.
  const hungUp = Boolean(view.currentItem?.prospectEndedAt);

  return (
    <div className="dialer-panel">
      <div className="section dp-progress">
        <div className="kicker">Power dialer</div>
        <div className="dp-queue-line">
          {queueLine(view.firstPassTotal ?? view.counts.total, view.counts.unreachable, view.skipBreakdown)}
        </div>
        {miss && <div className="dp-queue-line">{miss}</div>}
        <div className="dp-progress-label">{progressLabel(view.counts)}</div>
        <div className="meterbar tall">
          <div className="meterfill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {view.currentItem && <CurrentRecord item={view.currentItem} listTotal={view.listContext?.total ?? null} />}

      <HoldMusicPlayer view={view} holdMusic={holdMusic} lineAudio={lineAudio} />

      {shownError && <div className="dp-error">{shownError}</div>}

      {isTerminal ? (
        <div className="dp-summary">
          <div className="dp-summary-title">
            Run {view.session.status === 'done' ? 'complete' : 'stopped'}
          </div>
          <div className="dp-summary-meta">{progressLabel(view.counts)}</div>
          {miss && <div className="dp-summary-meta">{miss}</div>}
          {view.rollovers && view.rollovers.pending > 0 ? (
            // The worker hasn't finished writing the rollovers yet; the poll is
            // still running (bounded by ROLLOVER_SETTLE_MS) and will replace this
            // with the real line the moment they settle.
            <div className="dp-summary-meta">Finishing follow-ups…</div>
          ) : view.rollovers && rolloverLine(view.rollovers) ? (
            <div className="dp-summary-meta">{rolloverLine(view.rollovers)}</div>
          ) : null}
          <button className="btn primary full dp-summary-cta" onClick={onDismiss}>
            Start another run
          </button>
        </div>
      ) : (
        <>
          {view.waitingRetry && (
            <div className="dp-waiting">Next retry in {retryCountdown(view.waitingRetry.nextRetryAt, now)}</div>
          )}
          <div className="row dp-controls">
            <SessionToggle
              status={view.session.status}
              hungUp={hungUp}
              busy={controlBusy}
              onClick={() => runControl(pauseResumeAction(view.session.status))}
            />
            <ItemControls
              item={view.currentItem}
              busy={controlBusy}
              onSkip={() => runControls(actionsFor('skip', view.session.status))}
              onEnd={() => runControls(actionsFor('end', view.session.status))}
              onNext={() => runControls(actionsFor('next', view.session.status))}
              onRedial={() => runControls(actionsFor('redial', view.session.status))}
            />
            <button className="btn danger" disabled={controlBusy} onClick={handleStop}>
              Stop
            </button>
          </div>
        </>
      )}
    </div>
  );
}
