# Inbound Softphone Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee exactly one live, foregrounded, registered softphone per rep so returning calls ring one predictable place and answer with audio.

**Architecture:** All of a rep's `cti-web` softphone instances share one origin, so they coordinate over a `BroadcastChannel`: a deterministic, visible-preferred leader election picks one tab; only the leader creates and registers the Twilio Voice `Device`. Layered on top: media prewarm + AudioContext resume on answer (kills cold-start silence), and a persistent inbound status pill. Pure decision logic is isolated from browser/Twilio side effects so it unit-tests in the node (no-jsdom) test env via injected dependencies.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest (node env, no jsdom — SSR/pure tests only), `@twilio/voice-sdk`, browser `BroadcastChannel` / `document.visibilityState` / `navigator.mediaDevices` / `AudioContext`.

## Global Constraints

- All work is in `apps/cti-web` only. Do NOT touch `apps/cti-desktop` or `services/cti-api`.
- Tests run in the node environment (no jsdom): `npm test` = `vitest run`. Only pure functions and SSR (`renderToStaticMarkup`) are testable. Any unit that touches `BroadcastChannel`, `window`, `document`, `navigator`, timers, or the Twilio `Device` MUST take those as injected dependencies so its logic tests with fakes; the real-browser wiring lives in a thin, untested factory guarded by `typeof` checks.
- Follow the existing codebase idiom: a pure exported function + a thin effect wrapper (see `src/nav.ts`, `src/components/DialerPanel.tsx` `shouldTeardownRun`).
- Default to leader = `true` when there are no peers / `BroadcastChannel` is unsupported, so a single tab (or an old browser) behaves exactly like today (no regression).
- Never tear down a `Device` that has a ringing or active call — defer until the call ends.
- Heartbeat interval `HEARTBEAT_MS = 1000`; stale threshold `STALE_MS = 3000`; no-audio threshold `NO_AUDIO_MS = 4000`. Use these exact constants.
- Verify each task with: `cd apps/cti-web && npm test` and `npm run typecheck`. The final task also runs `npm run build`.

---

### Task 1: Leader-election core (pure)

**Files:**
- Create: `apps/cti-web/src/leader-election.ts`
- Test: `apps/cti-web/src/leader-election.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Peer { id: string; visible: boolean; lastSeen: number }`
  - `interface ElectionInput { selfId: string; selfVisible: boolean; peers: readonly Peer[]; now: number; staleMs: number }`
  - `function electLeader(input: ElectionInput): string`
  - `function shouldBeLeader(input: ElectionInput): boolean`

- [ ] **Step 1: Write the failing test**

Create `apps/cti-web/src/leader-election.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { electLeader, shouldBeLeader, type Peer } from './leader-election';

const peer = (id: string, visible: boolean, lastSeen: number): Peer => ({ id, visible, lastSeen });

describe('electLeader', () => {
  it('a lone instance is always the leader', () => {
    expect(electLeader({ selfId: 'a', selfVisible: false, peers: [], now: 1000, staleMs: 3000 })).toBe('a');
  });

  it('prefers a visible instance over a hidden one, regardless of id order', () => {
    // self is hidden with the smaller id; the visible peer must still win.
    expect(electLeader({ selfId: 'a', selfVisible: false, peers: [peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe('z');
  });

  it('among equally-visible instances, the smallest id wins (deterministic)', () => {
    expect(electLeader({ selfId: 'm', selfVisible: true, peers: [peer('a', true, 1000), peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe('a');
  });

  it('ignores stale peers (older than now - staleMs)', () => {
    // 'a' would win but it was last seen 4s ago with staleMs 3s -> excluded.
    expect(electLeader({ selfId: 'm', selfVisible: true, peers: [peer('a', true, 1000)], now: 5000, staleMs: 3000 })).toBe('m');
  });

  it('shouldBeLeader is electLeader === selfId', () => {
    expect(shouldBeLeader({ selfId: 'a', selfVisible: true, peers: [peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe(true);
    expect(shouldBeLeader({ selfId: 'z', selfVisible: false, peers: [peer('a', true, 1000)], now: 1000, staleMs: 3000 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/leader-election.test.ts`
Expected: FAIL — `Cannot find module './leader-election'` / `electLeader is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cti-web/src/leader-election.ts`:

```ts
/**
 * Deterministic, coordinator-free leader election across a rep's softphone
 * instances. Every instance runs this same pure function over ~the same alive
 * set (self + non-stale peers) and converges on one leader, so exactly one tab
 * holds the Twilio registration and Twilio has a single place to ring.
 *
 * Winner: a VISIBLE instance always beats a hidden one (so the ring lands where
 * the rep is looking); among equally-visible instances the lexicographically
 * smallest id wins (a stable tie-break). All instances see the same set
 * (same-origin BroadcastChannel), so there is no split-brain once presence has
 * propagated.
 */
export interface Peer {
  id: string;
  visible: boolean;
  lastSeen: number;
}

export interface ElectionInput {
  selfId: string;
  selfVisible: boolean;
  peers: readonly Peer[];
  now: number;
  /** A peer last seen before `now - staleMs` is treated as gone. */
  staleMs: number;
}

export function electLeader(input: ElectionInput): string {
  const alive: Array<{ id: string; visible: boolean }> = [{ id: input.selfId, visible: input.selfVisible }];
  for (const p of input.peers) {
    if (p.lastSeen > input.now - input.staleMs) alive.push({ id: p.id, visible: p.visible });
  }
  alive.sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return alive[0]!.id;
}

export function shouldBeLeader(input: ElectionInput): boolean {
  return electLeader(input) === input.selfId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/leader-election.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cti-web/src/leader-election.ts apps/cti-web/src/leader-election.test.ts
git commit -m "feat(cti-web): deterministic visible-preferred leader election (pure)"
```

---

### Task 2: Softphone coordinator (DI adapter over BroadcastChannel)

**Files:**
- Create: `apps/cti-web/src/softphone-coordinator.ts`
- Test: `apps/cti-web/src/softphone-coordinator.test.ts`

**Interfaces:**
- Consumes: `shouldBeLeader`, `Peer` from `./leader-election`.
- Produces:
  - `interface CoordinatorDeps { now: () => number; postMessage: (m: unknown) => void; subscribe: (cb: (m: unknown) => void) => void; getVisible: () => boolean; onVisibilityChange: (cb: () => void) => void; scheduleInterval: (cb: () => void, ms: number) => () => void; randomId: () => string }`
  - `interface CoordinatorState { isLeader: boolean; peerCount: number }`
  - `interface SoftphoneCoordinator { start(): void; stop(): void; onLeadershipChange(cb: (isLeader: boolean) => void): void; onStateChange(cb: (s: CoordinatorState) => void): void; promoteSelf(): void; isLeader(): boolean }`
  - `function createSoftphoneCoordinator(deps: CoordinatorDeps): SoftphoneCoordinator`
  - `function browserCoordinatorDeps(userId: string): CoordinatorDeps`
  - `const HEARTBEAT_MS = 1000`, `const STALE_MS = 3000`

- [ ] **Step 1: Write the failing test**

Create `apps/cti-web/src/softphone-coordinator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSoftphoneCoordinator, type CoordinatorDeps } from './softphone-coordinator';

// A shared in-memory bus so two coordinators can "see" each other, plus a
// controllable clock and a manual interval pump — no DOM needed.
function harness() {
  const subscribers: Array<(m: unknown) => void> = [];
  const intervals: Array<() => void> = [];
  let now = 1000;
  const bus = { post: (m: unknown) => subscribers.forEach((s) => s(m)) };
  const tick = (ms: number) => { now += ms; intervals.forEach((fn) => fn()); };
  const makeDeps = (id: string, visible: boolean): CoordinatorDeps => ({
    now: () => now,
    postMessage: (m) => bus.post(m),
    subscribe: (cb) => { subscribers.push(cb); },
    getVisible: () => visible,
    onVisibilityChange: () => {},
    scheduleInterval: (cb) => { intervals.push(cb); return () => { const i = intervals.indexOf(cb); if (i >= 0) intervals.splice(i, 1); }; },
    randomId: () => id,
  });
  return { tick, makeDeps };
}

describe('createSoftphoneCoordinator', () => {
  it('a single instance becomes leader on start', () => {
    const h = harness();
    const c = createSoftphoneCoordinator(h.makeDeps('a', true));
    let leader = false;
    c.onLeadershipChange((v) => { leader = v; });
    c.start();
    h.tick(1000);
    expect(leader).toBe(true);
    expect(c.isLeader()).toBe(true);
  });

  it('two instances converge on exactly one leader (visible beats hidden)', () => {
    const h = harness();
    const visible = createSoftphoneCoordinator(h.makeDeps('z', true));   // hidden-id-larger but visible
    const hidden = createSoftphoneCoordinator(h.makeDeps('a', false));   // smaller id but hidden
    let vLead = false, hLead = true;
    visible.onLeadershipChange((v) => { vLead = v; });
    hidden.onLeadershipChange((v) => { hLead = v; });
    visible.start(); hidden.start();
    h.tick(1000); // exchange presence
    h.tick(1000); // recompute with peers known
    expect(vLead).toBe(true);
    expect(hLead).toBe(false);
  });

  it('when the leader leaves, the other re-elects immediately (no stale wait)', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    const b = createSoftphoneCoordinator(h.makeDeps('b', true));
    let bLead = false;
    b.onLeadershipChange((v) => { bLead = v; });
    a.start(); b.start();
    h.tick(1000); h.tick(1000);   // 'a' wins (smaller id, both visible)
    expect(bLead).toBe(false);
    a.stop();                     // broadcasts 'leaving'
    h.tick(0);                    // b recomputes on the leaving message (no time passes)
    expect(bLead).toBe(true);
  });

  it('reports peerCount via onStateChange', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    const b = createSoftphoneCoordinator(h.makeDeps('b', true));
    let state = { isLeader: false, peerCount: -1 };
    a.onStateChange((s) => { state = s; });
    a.start(); b.start();
    h.tick(1000); h.tick(1000);
    expect(state.peerCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/softphone-coordinator.test.ts`
Expected: FAIL — `Cannot find module './softphone-coordinator'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cti-web/src/softphone-coordinator.ts`:

```ts
import { shouldBeLeader, type Peer } from './leader-election';

export const HEARTBEAT_MS = 1000;
export const STALE_MS = 3000;

export interface CoordinatorDeps {
  now: () => number;
  postMessage: (m: unknown) => void;
  subscribe: (cb: (m: unknown) => void) => void;
  getVisible: () => boolean;
  onVisibilityChange: (cb: () => void) => void;
  /** Schedule a repeating callback every `ms`; returns a canceller. */
  scheduleInterval: (cb: () => void, ms: number) => () => void;
  randomId: () => string;
}

export interface CoordinatorState {
  isLeader: boolean;
  peerCount: number;
}

export interface SoftphoneCoordinator {
  start(): void;
  stop(): void;
  onLeadershipChange(cb: (isLeader: boolean) => void): void;
  onStateChange(cb: (s: CoordinatorState) => void): void;
  /** Mark self a live, preferred candidate now (user acted in this tab). */
  promoteSelf(): void;
  /** Synchronous leadership read (used to decide whether to re-register a dropped Device). */
  isLeader(): boolean;
}

type Msg = { type: 'presence'; id: string; visible: boolean } | { type: 'leaving'; id: string };

export function createSoftphoneCoordinator(deps: CoordinatorDeps): SoftphoneCoordinator {
  const selfId = deps.randomId();
  const peers = new Map<string, { visible: boolean; lastSeen: number }>();
  let isLeader = false;
  let started = false;
  let cancelInterval: (() => void) | null = null;
  let leadershipCb: ((v: boolean) => void) | null = null;
  let stateCb: ((s: CoordinatorState) => void) | null = null;

  const peerList = (): Peer[] => [...peers].map(([id, p]) => ({ id, visible: p.visible, lastSeen: p.lastSeen }));

  const recompute = (): void => {
    const now = deps.now();
    // prune stale peers so peerCount and election stay honest
    for (const [id, p] of peers) if (p.lastSeen <= now - STALE_MS) peers.delete(id);
    const nextLeader = shouldBeLeader({ selfId, selfVisible: deps.getVisible(), peers: peerList(), now, staleMs: STALE_MS });
    if (nextLeader !== isLeader) {
      isLeader = nextLeader;
      leadershipCb?.(isLeader);
    }
    stateCb?.({ isLeader, peerCount: peers.size });
  };

  const onMessage = (raw: unknown): void => {
    const m = raw as Msg;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'presence' && m.id !== selfId) {
      peers.set(m.id, { visible: m.visible, lastSeen: deps.now() });
      recompute();
    } else if (m.type === 'leaving' && m.id !== selfId) {
      peers.delete(m.id);
      recompute();
    }
  };

  const beat = (): void => {
    deps.postMessage({ type: 'presence', id: selfId, visible: deps.getVisible() } satisfies Msg);
    recompute();
  };

  return {
    start() {
      if (started) return;
      started = true;
      deps.subscribe(onMessage);
      deps.onVisibilityChange(beat);
      cancelInterval = deps.scheduleInterval(beat, HEARTBEAT_MS);
      beat();
    },
    stop() {
      if (!started) return;
      started = false;
      deps.postMessage({ type: 'leaving', id: selfId } satisfies Msg);
      cancelInterval?.();
      cancelInterval = null;
    },
    onLeadershipChange(cb) { leadershipCb = cb; },
    onStateChange(cb) { stateCb = cb; },
    promoteSelf() { beat(); },
    isLeader() { return isLeader; },
  };
}

/**
 * Real-browser dependencies. Thin + untested: if `BroadcastChannel` is missing
 * (very old browser) every hook is a no-op, so the coordinator sees no peers and
 * stays leader — i.e. today's behavior, no regression.
 */
export function browserCoordinatorDeps(userId: string): CoordinatorDeps {
  const supported = typeof BroadcastChannel !== 'undefined';
  const channel = supported ? new BroadcastChannel(`cti-softphone-${userId}`) : null;
  return {
    now: () => Date.now(),
    postMessage: (m) => channel?.postMessage(m),
    subscribe: (cb) => { if (channel) channel.onmessage = (e: MessageEvent) => cb(e.data); },
    getVisible: () => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'),
    onVisibilityChange: (cb) => { if (typeof document !== 'undefined') document.addEventListener('visibilitychange', cb); },
    scheduleInterval: (cb, ms) => { const id = window.setInterval(cb, ms); return () => window.clearInterval(id); },
    randomId: () => `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/softphone-coordinator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cti-web/src/softphone-coordinator.ts apps/cti-web/src/softphone-coordinator.test.ts
git commit -m "feat(cti-web): softphone coordinator (single-registration over BroadcastChannel)"
```

---

### Task 3: Audio-readiness helpers (the "answer to silence" fix)

**Files:**
- Create: `apps/cti-web/src/audio-readiness.ts`
- Test: `apps/cti-web/src/audio-readiness.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function isLikelyDeadAudio(inboundSamples: readonly number[]): boolean`
  - `const NO_AUDIO_MS = 4000`
  - `function prewarmMic(getMedia?: () => Promise<{ getTracks(): Array<{ stop(): void }> }>): Promise<boolean>`
  - `function resumeAudio(ctx?: { state: string; resume(): Promise<void> } | null): void`

- [ ] **Step 1: Write the failing test**

Create `apps/cti-web/src/audio-readiness.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { isLikelyDeadAudio, prewarmMic, resumeAudio } from './audio-readiness';

describe('isLikelyDeadAudio', () => {
  it('true when every sample is silent and we have enough samples', () => {
    expect(isLikelyDeadAudio([0, 0, 0, 0])).toBe(true);
  });
  it('false as soon as any sample carries audio', () => {
    expect(isLikelyDeadAudio([0, 0, 0.02, 0])).toBe(false);
  });
  it('false when we do not yet have enough samples to judge', () => {
    expect(isLikelyDeadAudio([0, 0])).toBe(false);
  });
});

describe('prewarmMic', () => {
  it('resolves true and stops the primed tracks when getUserMedia succeeds', async () => {
    const stop = vi.fn();
    const getMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    await expect(prewarmMic(getMedia)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('resolves false (never throws) when the mic is denied', async () => {
    const getMedia = vi.fn(async () => { throw new Error('NotAllowedError'); });
    await expect(prewarmMic(getMedia)).resolves.toBe(false);
  });
});

describe('resumeAudio', () => {
  it('resumes a suspended AudioContext', () => {
    const resume = vi.fn(async () => {});
    resumeAudio({ state: 'suspended', resume });
    expect(resume).toHaveBeenCalled();
  });
  it('does nothing for a running or null context', () => {
    const resume = vi.fn(async () => {});
    resumeAudio({ state: 'running', resume });
    resumeAudio(null);
    expect(resume).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/audio-readiness.test.ts`
Expected: FAIL — `Cannot find module './audio-readiness'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cti-web/src/audio-readiness.ts`:

```ts
/**
 * Kills the "answer to silence" failure two ways: prevention (prime the mic and
 * resume the AudioContext so accept() isn't a cold start) and detection (flag a
 * call whose inbound audio never arrives so the UI can surface it instead of
 * failing silently).
 */
export const NO_AUDIO_MS = 4000;

/** Need at least this many volume samples before judging a call dead-audio. */
const MIN_SAMPLES = 3;

/** True only when we have enough samples AND every one is pure silence. */
export function isLikelyDeadAudio(inboundSamples: readonly number[]): boolean {
  if (inboundSamples.length < MIN_SAMPLES) return false;
  return inboundSamples.every((v) => v === 0);
}

type MediaStreamish = { getTracks(): Array<{ stop(): void }> };

/**
 * Prime the microphone permission/stream so the Twilio Device's accept() has an
 * already-granted mic. Best-effort: returns false (never throws) if denied.
 * Immediately stops the primed tracks; the SDK re-acquires on accept.
 */
export async function prewarmMic(
  getMedia: () => Promise<MediaStreamish> = () => navigator.mediaDevices.getUserMedia({ audio: true }) as unknown as Promise<MediaStreamish>,
): Promise<boolean> {
  try {
    const stream = await getMedia();
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* already stopped */ }
    }
    return true;
  } catch {
    return false;
  }
}

/** Resume a suspended AudioContext (browsers suspend audio until a user gesture). */
export function resumeAudio(ctx?: { state: string; resume(): Promise<void> } | null): void {
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => { /* best-effort */ });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/audio-readiness.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cti-web/src/audio-readiness.ts apps/cti-web/src/audio-readiness.test.ts
git commit -m "feat(cti-web): audio-readiness helpers (prewarm mic, resume ctx, dead-audio detect)"
```

---

### Task 4: Inbound status pill

**Files:**
- Create: `apps/cti-web/src/components/InboundStatusPill.tsx`
- Test: `apps/cti-web/src/components/InboundStatusPill.test.tsx`
- Modify: `apps/cti-web/src/styles.css` (append pill styles)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type InboundPill = 'on' | 'reconnecting' | 'elsewhere'`
  - `function inboundPillState(input: { isLeader: boolean; registered: boolean; degraded: boolean }): InboundPill`
  - `function InboundStatusPill(props: { state: InboundPill; onUseHere: () => void }): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `apps/cti-web/src/components/InboundStatusPill.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { inboundPillState, InboundStatusPill } from './InboundStatusPill';

describe('inboundPillState', () => {
  it('leader + registered + healthy = on', () => {
    expect(inboundPillState({ isLeader: true, registered: true, degraded: false })).toBe('on');
  });
  it('non-leader = elsewhere (another tab owns inbound)', () => {
    expect(inboundPillState({ isLeader: false, registered: false, degraded: false })).toBe('elsewhere');
  });
  it('leader but not yet registered, or degraded = reconnecting', () => {
    expect(inboundPillState({ isLeader: true, registered: false, degraded: false })).toBe('reconnecting');
    expect(inboundPillState({ isLeader: true, registered: true, degraded: true })).toBe('reconnecting');
  });
});

describe('InboundStatusPill', () => {
  it('shows a Use-here affordance only in the elsewhere state', () => {
    expect(renderToStaticMarkup(<InboundStatusPill state="elsewhere" onUseHere={() => {}} />)).toContain('Use here');
    expect(renderToStaticMarkup(<InboundStatusPill state="on" onUseHere={() => {}} />)).not.toContain('Use here');
  });
  it('labels each state for the rep', () => {
    expect(renderToStaticMarkup(<InboundStatusPill state="on" onUseHere={() => {}} />)).toContain('Inbound on');
    expect(renderToStaticMarkup(<InboundStatusPill state="reconnecting" onUseHere={() => {}} />)).toContain('Reconnecting');
    expect(renderToStaticMarkup(<InboundStatusPill state="elsewhere" onUseHere={() => {}} />)).toContain('another tab');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/components/InboundStatusPill.test.tsx`
Expected: FAIL — `Cannot find module './InboundStatusPill'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cti-web/src/components/InboundStatusPill.tsx`:

```tsx
/**
 * Persistent, at-a-glance indicator of whether returning calls will actually
 * ring THIS softphone. Replaces the easy-to-miss "inbound degraded" toast with
 * a header pill; when another tab owns inbound it offers a one-click takeover.
 */
export type InboundPill = 'on' | 'reconnecting' | 'elsewhere';

export function inboundPillState(input: { isLeader: boolean; registered: boolean; degraded: boolean }): InboundPill {
  if (!input.isLeader) return 'elsewhere';
  if (!input.registered || input.degraded) return 'reconnecting';
  return 'on';
}

const LABEL: Record<InboundPill, string> = {
  on: 'Inbound on',
  reconnecting: 'Reconnecting…',
  elsewhere: 'Active in another tab',
};

export function InboundStatusPill(props: { state: InboundPill; onUseHere: () => void }): JSX.Element {
  return (
    <div className={`inbound-pill ${props.state}`} title="Where returning calls will ring">
      <span className="dot" />
      <span className="label">{LABEL[props.state]}</span>
      {props.state === 'elsewhere' && (
        <button type="button" className="use-here" onClick={props.onUseHere}>Use here</button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/components/InboundStatusPill.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Append pill styles**

Append to `apps/cti-web/src/styles.css`:

```css
/* Inbound status pill — where returning calls will ring */
.inbound-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted); }
.inbound-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); flex: none; }
.inbound-pill.on { color: var(--good); border-color: color-mix(in srgb, var(--good) 35%, transparent); }
.inbound-pill.on .dot { background: var(--good); }
.inbound-pill.reconnecting { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
.inbound-pill.reconnecting .dot { background: var(--warn); }
.inbound-pill .use-here { margin-left: 2px; padding: 1px 6px; font-size: 11px; font-weight: 500; border-radius: 999px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; }
```

Note: `--warn` must exist as a token. Verify with `grep -n -- '--warn:' apps/cti-web/src/styles.css`; if it is absent, use `var(--bad)` in the two `.reconnecting` rules instead.

- [ ] **Step 6: Run test to verify it still passes + commit**

Run: `cd apps/cti-web && npx vitest run src/components/InboundStatusPill.test.tsx`
Expected: PASS.

```bash
git add apps/cti-web/src/components/InboundStatusPill.tsx apps/cti-web/src/components/InboundStatusPill.test.tsx apps/cti-web/src/styles.css
git commit -m "feat(cti-web): inbound status pill (on / reconnecting / active-in-another-tab)"
```

---

### Task 5: Wire the coordinator into App — register only when leader

**Files:**
- Modify: `apps/cti-web/src/App.tsx`

**Interfaces:**
- Consumes: `createSoftphoneCoordinator`, `browserCoordinatorDeps`, `type CoordinatorState`, `type SoftphoneCoordinator` from `./softphone-coordinator`.
- Produces (state available to Task 6/7 in the same file): `coordState: CoordinatorState`, `deviceRegistered: boolean`, `coordinatorRef.current: SoftphoneCoordinator | null`, and a `promoteSelf()` call site.

Read `apps/cti-web/src/App.tsx` first. Key existing anchors: `ensureDevice` (~line 418), the `d.on('registered')`/`d.on('unregistered')` handlers (~487), `teardownDevice` (~260), `deviceRef`/`deviceInitRef` (~232/249), `phaseRef` (~252), `me`/`signedIn` (~87/88), and the `place()` (~688) / `beginRun` (~519) device users.

- [ ] **Step 1: Add imports**

At the top of `App.tsx`, add:

```ts
import { createSoftphoneCoordinator, browserCoordinatorDeps, type CoordinatorState, type SoftphoneCoordinator } from './softphone-coordinator';
```

- [ ] **Step 2: Add coordinator state + refs**

Next to the other `useState`/`useRef` declarations in `App()` (near `inboundDegraded`, ~line 93, and `deviceRef`, ~232), add:

```ts
// Softphone single-registration: exactly one tab is the "leader" that holds the
// Twilio Device. Default isLeader:true so a lone tab / unsupported-BroadcastChannel
// behaves like today (registers immediately, no regression).
const [coordState, setCoordState] = useState<CoordinatorState>({ isLeader: true, peerCount: 0 });
const [deviceRegistered, setDeviceRegistered] = useState(false);
const coordinatorRef = useRef<SoftphoneCoordinator | null>(null);
// Set when leadership is lost mid-call; teardown is deferred until the call ends.
const pendingTeardownRef = useRef(false);
```

- [ ] **Step 3: Reflect real registration state + auto-recover a dropped registration while still leader**

Change the existing registration handlers (~line 487) to drive `deviceRegistered` AND re-register if the Device drops its registration while this tab is still the leader (a spurious unregister that isn't a deliberate teardown would otherwise silently stop inbound):

```ts
d.on('registered', () => { if (deviceRef.current === device) { setInboundDegraded(false); setDeviceRegistered(true); } });
d.on('unregistered', () => {
  if (deviceRef.current !== device) return;
  setDeviceRegistered(false);
  // Deliberate teardown (lost leadership) → leave it down. Still leader → recover.
  if (!pendingTeardownRef.current && coordinatorRef.current?.isLeader()) {
    void (device as unknown as { register: () => Promise<void> }).register().catch(() => setInboundDegraded(true));
  } else {
    setInboundDegraded(true);
  }
});
```

And in `teardownDevice` (~line 260), after clearing the refs, add `setDeviceRegistered(false);`.

- [ ] **Step 4: Create the coordinator effect (leadership drives registration)**

Add this effect in `App()` (place it AFTER `ensureDevice` and `teardownDevice` are defined so they're in scope — e.g. just before the existing handoff-poll effect):

```ts
// One softphone per rep across all their tabs. The elected leader holds the
// Twilio Device (inbound + outbound); non-leaders hold none, so Twilio never
// forks a callback to a stale background tab. Leadership prefers the visible tab
// and follows the rep between tabs.
useEffect(() => {
  const userId = me?.user?.id;
  if (!signedIn || !userId) return;
  const coord = createSoftphoneCoordinator(browserCoordinatorDeps(userId));
  coordinatorRef.current = coord;
  coord.onStateChange((s) => setCoordState(s));
  coord.onLeadershipChange((isLeader) => {
    if (isLeader) {
      pendingTeardownRef.current = false;
      void ensureDevice().catch(() => { /* surfaced via device 'error' */ });
    } else if (phaseRef.current === 'idle' || phaseRef.current === 'preflight') {
      teardownDevice();
    } else {
      // Mid-call: keep the Device until the call ends (see backToIdle guard).
      pendingTeardownRef.current = true;
    }
  });
  coord.start();
  const onHide = () => coord.stop();
  // Network came back → if we're the leader, make sure the Device is registered.
  const onOnline = () => { if (coord.isLeader()) void ensureDevice().catch(() => { /* device 'error' */ }); };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('online', onOnline);
  return () => {
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('online', onOnline);
    coord.stop();
    coordinatorRef.current = null;
  };
}, [signedIn, me?.user?.id, ensureDevice, teardownDevice]);
```

- [ ] **Step 5: Honor a deferred teardown when a call ends**

Find every place a call returns to idle and the Device could now be safely released — the inbound `backToIdle` (~line 806) and the outbound hangup/`backToIdle` path. Immediately after each sets phase back to idle, add:

```ts
if (pendingTeardownRef.current && !coordState.isLeader) { pendingTeardownRef.current = false; teardownDevice(); }
```

If a single shared `backToIdle` helper exists, add it once there; otherwise add it to each idle-return site. (Search: `setPhase('idle')`.)

- [ ] **Step 6: Promote self before on-demand device use in a dormant tab**

So an outbound dial or a power-dial run started in a non-leader tab takes ownership first. At the very start of `place()` (~line 688, before `ensureDevice`) and `beginRun` (~line 519, before `ensureDevice`), add:

```ts
coordinatorRef.current?.promoteSelf();
```

- [ ] **Step 7: Typecheck + tests + commit**

Run: `cd apps/cti-web && npm run typecheck && npm test`
Expected: typecheck clean; existing suite still passes (no unit tests cover App.tsx directly).

```bash
git add apps/cti-web/src/App.tsx
git commit -m "feat(cti-web): register the Twilio Device only in the elected leader tab"
```

---

### Task 6: Media hardening on answer

**Files:**
- Modify: `apps/cti-web/src/App.tsx`

**Interfaces:**
- Consumes: `prewarmMic`, `resumeAudio`, `isLikelyDeadAudio`, `NO_AUDIO_MS` from `./audio-readiness`.
- Produces: a `noAudio` boolean on the active-call screen (passed to `CallScreen` if it accepts one; otherwise a toast).

- [ ] **Step 1: Add import + a shared AudioContext ref**

Add:

```ts
import { prewarmMic, resumeAudio, isLikelyDeadAudio, NO_AUDIO_MS } from './audio-readiness';
```

Add a ref near the other refs:

```ts
const audioCtxRef = useRef<AudioContext | null>(null);
```

- [ ] **Step 2: Prewarm the mic when this tab becomes the leader**

In the coordinator effect from Task 5, inside the `if (isLeader) { ... }` branch (right after the `void ensureDevice()` line), add:

```ts
void prewarmMic();
```

- [ ] **Step 3: Resume audio + arm the no-audio detector on accept**

In `acceptIncoming` (~line 801), immediately after `try { call.accept(); } catch { backToIdle(); return; }`, add:

```ts
// Resume any suspended AudioContext (browsers gate audio until a user gesture;
// the accept tap IS that gesture) so the caller's audio plays.
if (typeof AudioContext !== 'undefined') {
  if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
  resumeAudio(audioCtxRef.current);
}
// No-audio detector: sample the inbound volume; if it never arrives, surface it
// instead of leaving the rep on a silent call.
const samples: number[] = [];
const volCall = call as unknown as { on: (e: string, cb: (i: number, o: number) => void) => void };
volCall.on('volume', (_inputVol: number, outputVol: number) => { samples.push(outputVol); });
const noAudioTimer = window.setTimeout(() => {
  if (isLikelyDeadAudio(samples)) {
    setToast({ text: 'No audio on this call — try reloading the softphone.', type: 'error' });
  }
}, NO_AUDIO_MS);
call.on('disconnect', () => window.clearTimeout(noAudioTimer));
```

(The existing `call.on('disconnect', backToIdle)` and `call.on('error', …)` handlers stay as-is; this adds one more disconnect listener, which the SDK supports.)

- [ ] **Step 4: Typecheck + tests + commit**

Run: `cd apps/cti-web && npm run typecheck && npm test`
Expected: typecheck clean; suite passes.

```bash
git add apps/cti-web/src/App.tsx
git commit -m "feat(cti-web): prewarm mic + resume audio + no-audio detection on answer"
```

---

### Task 7: Render the inbound status pill in the header

**Files:**
- Modify: `apps/cti-web/src/App.tsx`

**Interfaces:**
- Consumes: `InboundStatusPill`, `inboundPillState` from `./components/InboundStatusPill`; `coordState`, `deviceRegistered`, `inboundDegraded`, `coordinatorRef` from Task 5.

- [ ] **Step 1: Add import**

```ts
import { InboundStatusPill, inboundPillState } from './components/InboundStatusPill';
```

- [ ] **Step 2: Render the pill in the header**

In the header's `<div className="right">` block (~line 985, alongside the rep chip / SF-linked icon), add the pill as the FIRST child so it's the leftmost status:

```tsx
<InboundStatusPill
  state={inboundPillState({ isLeader: coordState.isLeader, registered: deviceRegistered, degraded: inboundDegraded })}
  onUseHere={() => coordinatorRef.current?.promoteSelf()}
/>
```

- [ ] **Step 3: Simplify the old presence-dot status line (avoid duplicate messaging)**

The header status line (~line 980) currently reads `inboundDegraded ? 'Inbound unavailable — reload' : …`. Since the pill now owns inbound state, change that line to only reflect the Salesforce connection, not inbound:

```tsx
<div className="status">
  <span className={`presence-dot ${ctiReady ? '' : 'warn'}`} />
  {ctiReady ? 'Salesforce CTI connected' : 'Standalone'}
</div>
```

- [ ] **Step 4: Typecheck + build + tests + commit**

Run: `cd apps/cti-web && npm run typecheck && npm test && npm run build`
Expected: typecheck clean; full suite passes; build succeeds.

```bash
git add apps/cti-web/src/App.tsx
git commit -m "feat(cti-web): show inbound status pill in the softphone header"
```

---

## Manual / live verification (after all tasks)

1. Sign in to the softphone in TWO Salesforce tabs. Exactly one shows **Inbound on**; the other shows **Active in another tab** with **Use here**.
2. Place a test call to that rep's DID → it rings ONLY the "Inbound on" tab, and answering has two-way audio.
3. Click **Use here** in the other tab → the pill flips (that tab becomes "on", the first becomes "elsewhere"); a follow-up test call now rings the new tab.
4. Switch focus between tabs → leadership follows the visible tab within ~1–2s.
5. Close the leader tab → the other tab flips to **Inbound on** within ~1s (clean `leaving`) and receives the next call.

## Notes for the executor

- Do NOT add jsdom or `@testing-library/react`; this package tests pure logic + SSR only (see `DialerPanel.test.tsx`). All new logic is unit-tested through injected deps; App.tsx wiring is verified by typecheck + the live steps above.
- Keep `Date.now()`/`Math.random()` only in `browserCoordinatorDeps` and the acceptIncoming detector — never in the pure modules.
- If `--warn` is not a real CSS token, use `--bad` for the `.reconnecting` pill (see Task 4 Step 5 note).
