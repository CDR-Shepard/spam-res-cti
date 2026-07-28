# Inbound Softphone Reliability — Design Spec

**Date:** 2026-07-27
**Status:** Approved (approach A + four components)
**Scope:** `apps/cti-web` only (mirror to `apps/cti-desktop` is a later follow-up)

## Problem

Reps report that returning (inbound) calls are silent on answer "over 70% of the
time," and the caller often doesn't appear in Recents. Forensics on 30 days of
production data (56 inbound calls, GG Homes org) confirmed a real, pre-existing
inbound-delivery reliability problem — **not** the power dialer (0 of 56 failed
inbound calls overlapped a dialer session).

Twilio's own view of the softphone (`<Dial><Client>rep_<id></Client>`) child leg:

| Child-leg outcome | Count | Meaning |
| --- | --- | --- |
| `completed` with real talk time | ~10 | Worked |
| `no-answer` / 0s (incl. voicemail fallthrough) | ~34 | Rang a client, never answered |
| **No child leg at all** | 6 | No live registration to ring |
| `busy` (app rejected) | 2 | Softphone auto-declined |
| answered → died ≤5s | 4 | "Answer to silence" — media never established |
| answered but logged `no_answer` | 3 | Minor logging bug |

### Root cause

Reps keep Salesforce open in **multiple tabs/browsers**. Every tab's softphone
iframe (same origin) registers the **same** Twilio client identity
`rep_<userId>`. Twilio fans each inbound call out to **all** registrations. Then:

- Browser **background-tab throttling** stalls the non-focused tabs' Voice SDK
  (timers, keepalive, token refresh), so their registration goes stale — the ring
  either surfaces in a tab the rep isn't looking at (`no-answer`) or no live
  instance exists at all (no child leg).
- A stale/background instance answering yields **degraded or no media** (the
  "answer to silence" cases).
- A non-idle background tab **auto-rejects** the fork (`busy`).

The fix: make **one authoritative softphone instance** the single place inbound
lands, keep it reliably registered, make its media reliable on answer, and show
the rep whether inbound is actually on.

## Goal

One sentence: **Guarantee exactly one live, foregrounded, registered softphone
per rep, so returning calls ring one predictable place and answer with audio.**

## Approach (chosen: A — client-side leader election)

All of a rep's softphone instances share one origin (every Salesforce tab embeds
the same `cti-web` iframe), so they can coordinate over a `BroadcastChannel`.
Instances gossip presence; a deterministic election picks **one leader**, biased
to a **visible** tab; only the leader creates and registers the Twilio Device.
Non-leaders stay dormant. Leadership follows the tab the rep is looking at.

- No server or schema changes; entirely in `cti-web`.
- Eliminates the fork for the multi-tab-same-browser case (the reported one).
- **Out of scope (documented gap):** two *different browsers* / machines
  (Chrome + Safari) can't coordinate via `BroadcastChannel`; that remains forked.
  A server-side "newest-registration-wins" backstop (approach B) is a future
  follow-up only if cross-browser forking shows up in the data.

## Architecture

Four units, each with one responsibility and a testable pure core where it helps.

```
BroadcastChannel  ── presence gossip ──►  leader-election (PURE)  ──► isLeader
        ▲                                                              │
        │ heartbeat/visibility                                        ▼
 softphone-coordinator (effectful adapter) ──► App: register Device only if leader
                                                     │
 audio-readiness (prewarm mic + resume AudioContext + volume monitor)
                                                     │
 InboundStatusPill (On / Off-reconnecting / Active-in-another-tab)
```

### Unit 1 — `leader-election.ts` (pure, unit-tested)

The whole decision is a pure function so it can be tested without timers or
browser APIs.

```ts
export interface Peer { id: string; visible: boolean; lastSeen: number; }
export interface ElectionInput {
  selfId: string;
  selfVisible: boolean;
  peers: Peer[];        // does NOT include self
  now: number;
  staleMs: number;      // a peer older than now-staleMs is considered gone
}
/**
 * Deterministic winner over the alive set (self + non-stale peers):
 * prefer visible instances; tie-break by lexicographically smallest id.
 * Every instance runs the same function over ~the same set and converges on
 * the same leader with no central coordinator.
 */
export function electLeader(input: ElectionInput): string;      // returns winning id
export function shouldBeLeader(input: ElectionInput): boolean;   // electLeader(input) === selfId
```

Rules: an alive instance = self plus every peer with `lastSeen > now - staleMs`.
Among alive instances, a `visible` one always beats a non-visible one; among
equally-visible, smallest `id` wins. Deterministic, so no split-brain once all
tabs see each other (guaranteed same-origin).

### Unit 2 — `softphone-coordinator.ts` (effectful adapter, thin)

Wraps `BroadcastChannel` + timers around the pure core.

- Generates a random `selfId` per instance.
- Broadcasts `{type:'presence', id, visible}` every `HEARTBEAT_MS` (≈1000ms) and
  immediately on `visibilitychange`.
- Tracks peers in a map (`id -> {visible, lastSeen}`); prunes on a tick.
- On every tick / inbound message, recomputes `shouldBeLeader(...)`; when it
  flips, calls `onLeadershipChange(isLeader)`.
- On `pagehide`/`beforeunload`, broadcasts `{type:'leaving', id}` so peers
  re-elect immediately (no `staleMs` gap when a tab closes cleanly).
- `staleMs ≈ 3 × HEARTBEAT_MS` covers a crash (no clean `leaving`).
- Exposes `getState(): { isLeader, peerCount }` for the status pill.

Public surface:

```ts
export interface SoftphoneCoordinator {
  start(): void;
  stop(): void;
  onLeadershipChange(cb: (isLeader: boolean) => void): void;
  onStateChange(cb: (s: { isLeader: boolean; peerCount: number }) => void): void;
  promoteSelf(): void; // user clicked "Use here" in a dormant tab
}
export function createSoftphoneCoordinator(userId: string): SoftphoneCoordinator;
```

`promoteSelf()` marks self visible + broadcasts, so the election immediately
favors this tab (this is also what focusing a tab does naturally).

### Unit 3 — App.tsx integration (register only when leader)

- Create the coordinator once per signed-in session (keyed on `userId`).
- `onLeadershipChange(true)` → `ensureDevice()` + register (existing path).
- `onLeadershipChange(false)` → `teardownDevice()` (destroy + unregister) so a
  dormant tab holds **no** registration and can never receive a forked call.
- The existing incoming/accept/outbound/dialer paths are unchanged except that
  they only run in the leader tab (the Device only exists there). A user action
  needing the Device in a dormant tab first calls `promoteSelf()`.
- The `d.on('incoming')` auto-reject guard stays, but now only ever fires for the
  single real instance — it no longer sabotages a sibling tab.

### Unit 4 — `audio-readiness.ts` (the "answer to silence" fix)

Prevention first, detection second:

- **Prewarm:** when this tab becomes leader, call
  `navigator.mediaDevices.getUserMedia({ audio: true })` once to prime the mic
  permission/stream so `call.accept()` isn't a cold start. Release the prewarm
  track immediately; the SDK re-acquires on accept.
- **Resume AudioContext:** browsers suspend audio until a user gesture; on
  `acceptIncoming` (a gesture) resume any suspended `AudioContext` so outbound
  audio plays.
- **No-audio detector:** after accept, subscribe to the Twilio Call `volume`
  event; if inbound volume stays 0 for `NO_AUDIO_MS` (≈4s), set a "no audio —
  reconnecting" state on the call screen and surface it (the SDK auto-reconnects
  on ICE loss; we make the failure visible instead of silent). Pure helper:
  `isLikelyDeadAudio(samples): boolean` for unit testing the threshold logic.

### Unit 5 — `InboundStatusPill` (visible on/off)

A persistent pill in the softphone header (replaces the easy-to-miss
`inboundDegraded` toast; the toast on repeated token-refresh failure stays):

- **Inbound on** (green) — this tab is leader AND Device registered.
- **Inbound off · reconnecting** (amber) — leader but unregistered/degraded.
- **Active in another tab** (neutral) — dormant; includes a **Use here** button
  → `promoteSelf()`.

Pure `inboundPillState({ isLeader, registered, degraded }): 'on'|'reconnecting'|'elsewhere'`.

## Data flow (inbound, after the fix)

1. Rep has 3 Salesforce tabs. Coordinators gossip; the visible/focused tab is
   leader and the only one with a registered Device. The other two are dormant
   ("Active in another tab").
2. A returning call hits the DID → inbound TwiML dials `client:rep_<id>` →
   Twilio has exactly **one** registration → rings the leader tab only.
3. Rep answers; mic is prewarmed and AudioContext resumed → audio bridges. The
   no-audio detector is armed as a backstop.
4. Rep switches tabs → the newly-visible tab wins election → it registers, the
   old leader tears down → inbound follows the rep with a brief, idempotent
   overlap.

## Error handling

- Election is idempotent and self-correcting; a brief two-leader overlap during a
  transition at worst forks for ~1 gossip interval and resolves next tick.
- `BroadcastChannel` unsupported (very old browser) → coordinator degrades to
  "always leader" (current behavior); log once. No regression.
- Losing leadership mid-call: do **not** tear down a Device with an active/ringing
  call — defer `teardownDevice()` until the call ends (guard on call phase).
- Prewarm `getUserMedia` rejection (mic denied) → surface once via the pill/toast;
  don't block registration (rep may still hear via output only / fix perms).

## Testing

- `leader-election.test.ts` — pure: visible beats hidden; id tie-break; stale
  peers excluded; self-wins vs not; single-instance trivially leader.
- `softphone-coordinator.test.ts` — with a fake BroadcastChannel + injected clock:
  two instances converge on one leader; leader `leaving` triggers immediate
  re-election; `promoteSelf` flips leadership; no-peer case.
- `audio-readiness.test.ts` — `isLikelyDeadAudio` threshold; AudioContext resume
  is invoked on accept.
- `inboundPillState` — pure state mapping.
- Existing `App.tsx` incoming/accept behavior unchanged when leader (regression).
- Manual/live: with two Salesforce tabs open, confirm only one shows "Inbound on",
  a callback rings only that tab and answers with audio, and switching tabs moves
  the "on" state.

## Out of scope (explicit)

- Cross-browser / cross-machine single registration (approach B, server-side).
- Ringing the rep's cell (declined — softphone-only).
- `cti-desktop` mirroring (separate follow-up; desktop styles already diverged).
- The 3 mis-logged (`child completed` but `no_answer`) calls — a separate small
  dial-result logging fix, tracked independently.
