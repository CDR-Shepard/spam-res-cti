# AI voice natural turn-taking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AI phone agent keeps talking through "mm-hmm"/"yeah", stops on real interruptions, checks in after silence, and every call records its response times.

**Architecture:** The cti-api bridge (`services/cti-api/src/ai-voice/bridge.ts`) takes turn-taking back from OpenAI (`create_response: false`, `interrupt_response: false`) and decides barge-in from the caller's streamed words (`gpt-live-transcribe`). Small pure modules hold the rules (word classifier, overlap gate, silence check, turn stats); the bridge wires them. Stats land in `ai_calls.turn_stats` and show as one line above each transcript in outreach-web. `AI_VOICE_BARGE_IN=instant` restores today's behaviour.

**Tech Stack:** TypeScript 5.6 strict ESM (`.js` import suffixes), Fastify 4, Drizzle 0.36.4, zod 3, vitest 2 (Node) / vitest 4 + jsdom (web), React 18, OpenAI Realtime GA over WebSocket, Twilio Media Streams.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md` (read §3 for the live API evidence and §4 for every rule).

## Global Constraints

- Work only in worktree `/Users/cdrshepard/spam-res-cti/.worktrees/ai-voice-natural`, branch `feat/ai-voice-natural`. Never git checkout/switch/reset/stash/rebase; never push; never touch `main`.
- Setup once: `npm ci` (or `npm install`), then `npm run build:packages` before any typecheck/test (packages build to `dist/`). Rebuild packages after changing `packages/*`.
- Stage explicit paths only. Never stage `.claude/launch.json` or `apps/cti-ios/App/CTICallerID.entitlements`.
- Commit format `<type>(<scope>): <description>`, **no** `Co-Authored-By` or any attribution trailer.
- The disclosure opener ("…an AI assistant calling for … on a recorded line…") must always be said in full; the agent never claims to be human.
- Immutability: never mutate shared objects; reassign private state with spreads (existing bridge style: `this.truncated = new Set([...this.truncated, id])`).
- Any whole-module `vi.mock` of a `@cti/*` package must spread `importOriginal`.
- Never log audio payloads or secrets.
- Constants, exactly: `INTERRUPT_WORD_COUNT = 2`, `NO_WORDS_INTERRUPT_MS = 2000`, `LATE_OVERLAP_MS = 1500`, `SILENCE_CHECK_MS = 8000`, `HOLD_CHECK_MS = 30000`, `MAX_SILENCE_CHECKS = 2`.
- Config defaults, exactly: `AI_VOICE_BARGE_IN` = `gate`, `AI_VOICE_TRANSCRIBE_MODEL` = `gpt-live-transcribe`. The **bridge's own** option defaults stay legacy (`bargeIn: 'instant'`, `transcribeModel: 'gpt-4o-mini-transcribe'`) so every existing `bridge.test.ts` case keeps passing unchanged; the service passes the config values.
- Migration number: `0059` (origin/main ends at 0058). If another 0059 appears on main before merge, renumber.

## Commands

| What | Command (from the worktree root) |
|---|---|
| cti-api tests (one file) | `npx vitest run --root services/cti-api src/ai-voice/<file>.test.ts` |
| cti-api all tests | `npm test -w services/cti-api` (check `services/cti-api/package.json` for the exact script name) |
| cti-api typecheck | `npm run typecheck -w services/cti-api` |
| outreach-api / outreach-web / contracts / db | same pattern with `-w services/outreach-api`, `-w apps/outreach-web`, `-w packages/contracts`, `-w packages/db` |

If a script name differs, read that workspace's `package.json` and use its `test` / `typecheck` scripts. The pg (real Postgres) test lane, if present, follows `packages/db`'s README or existing `*.pg.test.ts` setup.

---

### Task 1: Listening-sound classifier

**Files:**
- Create: `services/cti-api/src/ai-voice/bridge-listening.ts`
- Test: `services/cti-api/src/ai-voice/bridge-listening.test.ts`

**Interfaces:**
- Produces: `type OverlapVerdict = 'empty' | 'listening' | 'interrupt'`; `overlapVerdict(text: string): OverlapVerdict`; `words(text: string): string[]`; `INTERRUPT_WORD_COUNT = 2`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { overlapVerdict, words } from './bridge-listening.js';

describe('words', () => {
  it('folds listening phrases into one token and drops punctuation and apostrophes', () => {
    expect(words('Mm-hmm.')).toEqual(['mmhmm']);
    expect(words('mm hmm')).toEqual(['mmhmm']);
    expect(words('Mhm')).toEqual(['mmhmm']);
    expect(words('Uh-huh, uh huh')).toEqual(['uhhuh', 'uhhuh']);
    expect(words('I see. Got it! All right')).toEqual(['isee', 'gotit', 'alright']);
    expect(words("I've been thinking")).toEqual(['ive', 'been', 'thinking']);
    expect(words('  ')).toEqual([]);
  });
});

describe('overlapVerdict', () => {
  it.each([
    ['', 'empty'],
    ['...', 'empty'],
    ['Mm-hmm.', 'listening'],
    ['Uh-huh', 'listening'],
    ['Yeah.', 'listening'],
    ['Yeah, sure.', 'listening'],
    ['Okay okay', 'listening'],
    ['Oh wow, really?', 'listening'],
    ['Right, I see.', 'listening'],
    ['Hmm', 'listening'],
    ['Um', 'listening'],
    ['Hello?', 'listening'],
    ['Wait', 'interrupt'],
    ['Hold on', 'interrupt'],
    ['Hang on a sec', 'interrupt'],
    ['No', 'interrupt'],
    ['Sorry?', 'interrupt'],
    ['Huh?', 'interrupt'],
    ['What?', 'interrupt'],
    ['Yeah but', 'interrupt'],
    ['Actually', 'interrupt'],
    ["I'm interested", 'interrupt'],
    ['Who is this', 'interrupt'],
    ['Hello? Hello?', 'interrupt'],
    ['Yeah, the roof', 'interrupt'],
  ] as const)('%j → %s', (text, verdict) => {
    expect(overlapVerdict(text)).toBe(verdict);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --root services/cti-api src/ai-voice/bridge-listening.test.ts`
Expected: FAIL — cannot find module `./bridge-listening.js`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Is the caller's speech over the agent a listening sound ("mm-hmm", "yeah", "okay") or a real
 * interruption? Used by the overlap gate (bridge-overlap.ts) on the words `gpt-live-transcribe`
 * streams while the caller is still talking.
 * Spec: docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.1.
 */
export type OverlapVerdict = 'empty' | 'listening' | 'interrupt';

/** This many words that are not listening sounds = they are saying something. */
export const INTERRUPT_WORD_COUNT = 2;

/** Multi-word listening sounds, folded into one token before splitting (order matters). */
const PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\buh[\s-]*huh\b/g, 'uhhuh'],
  [/\bm+[\s-]*h+m+\b/g, 'mmhmm'],
  [/\bi see\b/g, 'isee'],
  [/\bgot it\b/g, 'gotit'],
  [/\ball right\b/g, 'alright'],
  [/\bmakes sense\b/g, 'makessense'],
  [/\bfor sure\b/g, 'forsure'],
];

/** "I'm listening", not "my turn" — never stop the agent on these alone. */
const LISTENING: ReadonlySet<string> = new Set([
  'mmhmm', 'uhhuh', 'hmm', 'mm', 'um', 'uh', 'yeah', 'yea', 'ya', 'yep', 'yup', 'yes', 'ok', 'okay',
  'right', 'sure', 'alright', 'gotit', 'gotcha', 'isee', 'oh', 'ah', 'wow', 'cool', 'nice', 'great',
  'true', 'totally', 'exactly', 'really', 'interesting', 'makessense', 'forsure', 'hello',
]);

/** One of these is enough to stop the agent ("hold" on/up, "hang" on). */
const STOP: ReadonlySet<string> = new Set([
  'wait', 'hold', 'hang', 'stop', 'no', 'nope', 'sorry', 'excuse', 'what', 'huh', 'pardon', 'actually', 'but',
]);

/** Lower-case word tokens, with listening phrases folded into one token each. */
export function words(text: string): string[] {
  const folded = PHRASES.reduce((t, [re, token]) => t.replace(re, token), text.toLowerCase().replace(/['’]/g, ''));
  return folded.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
}

/**
 * `hello` alone is a listening sound (a "Hello?" over the agent's opener is the greeting), but a
 * repeated "Hello? Hello?" means "can you hear me?" — an interruption.
 */
export function overlapVerdict(text: string): OverlapVerdict {
  const ws = words(text);
  if (ws.length === 0) return 'empty';
  if (ws.some((w) => STOP.has(w))) return 'interrupt';
  const talking = ws.filter((w) => !LISTENING.has(w)).length;
  const hellos = ws.filter((w) => w === 'hello').length;
  return talking >= INTERRUPT_WORD_COUNT || hellos >= 2 ? 'interrupt' : 'listening';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --root services/cti-api src/ai-voice/bridge-listening.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/ai-voice/bridge-listening.ts services/cti-api/src/ai-voice/bridge-listening.test.ts
git commit -m "feat(ai-voice): tell listening sounds (mm-hmm, yeah) from real interruptions"
```

---

### Task 2: Overlap gate

**Files:**
- Create: `services/cti-api/src/ai-voice/bridge-overlap.ts`
- Test: `services/cti-api/src/ai-voice/bridge-overlap.test.ts`

**Interfaces:**
- Consumes: `overlapVerdict` (Task 1); `SetTimer`, `ClearTimer` from `./bridge-playback.js` (exist).
- Produces:
  - `NO_WORDS_INTERRUPT_MS = 2000`, `LATE_OVERLAP_MS = 1500`
  - `type OverlapEnd = 'interrupted' | 'answer' | 'ignore'`
  - `class OverlapGate` with `constructor(deps: { setTimer: SetTimer; clearTimer: ClearTimer; onInterrupt(why: 'words' | 'no words'): void })`, `get itemId(): string | null`, `open(itemId: string, opts: { cuttable: boolean; late: boolean }): void`, `onDelta(itemId: string, delta: string): void`, `finish(itemId: string, finalText: string): OverlapEnd`, `close(): void`.

Behaviour (spec §4.1): one overlap at a time. Words stream in via `onDelta`; a stop word, 2 real words, or 2 s with no word at all → `onInterrupt` (only when `cuttable`), and the gate closes itself. `finish` settles an undecided overlap on the final transcript: interrupt verdict → `'interrupted'` (cuttable; fires `onInterrupt`) or `'answer'` (not cuttable — said over the opener, answer once it has played); otherwise `'answer'` if `late`, else `'ignore'`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_WORDS_INTERRUPT_MS, OverlapGate } from './bridge-overlap.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function gate() {
  const onInterrupt = vi.fn();
  const g = new OverlapGate({ setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (h) => clearTimeout(h), onInterrupt });
  return { g, onInterrupt };
}

describe('OverlapGate', () => {
  it('keeps quiet through listening sounds and ignores them at the end', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', ' Mm');
    g.onDelta('c1', '-hmm');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c1', 'Mm-hmm.')).toBe('ignore');
    expect(g.itemId).toBeNull();
  });

  it('interrupts on a stop word as soon as it streams in, and closes', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', ' Wait');
    expect(onInterrupt).toHaveBeenCalledWith('words');
    expect(g.itemId).toBeNull();
    g.onDelta('c1', ' hold on');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('interrupts on the second real word', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', " I'm");
    expect(onInterrupt).not.toHaveBeenCalled();
    g.onDelta('c1', ' interested');
    expect(onInterrupt).toHaveBeenCalledWith('words');
  });

  it('interrupts after 2 s of talk with no word at all', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS - 1);
    expect(onInterrupt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onInterrupt).toHaveBeenCalledWith('no words');
    expect(g.itemId).toBeNull();
  });

  it('ignores deltas for other items', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c2', ' Wait');
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.itemId).toBe('c1');
  });

  it('a late listening sound is an answer', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: true });
    g.onDelta('c1', ' Yeah sure');
    expect(g.finish('c1', 'Yeah, sure.')).toBe('answer');
  });

  it('settles on the final text when the words arrived late', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    expect(g.finish('c1', 'Who is this?')).toBe('interrupted');
    expect(onInterrupt).toHaveBeenCalledWith('words');
  });

  it('never cuts an uncuttable overlap (the opener) — a real interruption becomes an answer', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: false, late: false });
    g.onDelta('c1', ' Wait who is this');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c1', 'Wait, who is this?')).toBe('answer');
  });

  it('an uncuttable listening sound that is not late is ignored', () => {
    const { g } = gate();
    g.open('c1', { cuttable: false, late: false });
    expect(g.finish('c1', 'Hello?')).toBe('ignore');
  });

  it('opening a new overlap or close() cancels the no-words timer', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.open('c2', { cuttable: true, late: false });
    g.close();
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c2', 'Wait')).toBe('ignore');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --root services/cti-api src/ai-voice/bridge-overlap.test.ts`
Expected: FAIL — cannot find module `./bridge-overlap.js`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * One caller "overlap" at a time: the caller started talking while the agent was talking. The gate
 * keeps the agent talking through listening sounds ("mm-hmm", "yeah") and cuts it on a real
 * interruption: a stop word, two real words, or NO_WORDS_INTERRUPT_MS of talk with no word
 * transcribed (a transcriber hiccup, another language). The opener is uncuttable (disclosure).
 * Spec: docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.1.
 */
import { overlapVerdict } from './bridge-listening.js';
import type { ClearTimer, SetTimer } from './bridge-playback.js';

/** Caller talking this long over the agent with no word transcribed: treat it as an interruption. */
export const NO_WORDS_INTERRUPT_MS = 2000;
/** Caller started with at most this much (fully generated) agent audio left: an early answer. */
export const LATE_OVERLAP_MS = 1500;

/** How an undecided overlap ends: the agent was cut, the bridge should answer it, or it was just listening. */
export type OverlapEnd = 'interrupted' | 'answer' | 'ignore';

export type InterruptWhy = 'words' | 'no words';

interface Overlap {
  readonly itemId: string;
  readonly text: string;
  /** May the gate cut the agent? False over the opener (the disclosure line). */
  readonly cuttable: boolean;
  /** Began near the end of the agent's turn ("…got a quick minute?" / "yeah sure"). */
  readonly late: boolean;
}

export interface OverlapGateDeps {
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  /** Cut the agent now. */
  onInterrupt(why: InterruptWhy): void;
}

export class OverlapGate {
  private current: Overlap | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OverlapGateDeps) {}

  /** The caller item being judged, or null. */
  get itemId(): string | null {
    return this.current?.itemId ?? null;
  }

  open(itemId: string, opts: { cuttable: boolean; late: boolean }): void {
    this.close();
    this.current = { itemId, text: '', cuttable: opts.cuttable, late: opts.late };
    if (opts.cuttable) this.timer = this.deps.setTimer(() => this.interrupt('no words'), NO_WORDS_INTERRUPT_MS);
  }

  /** Words streamed for a caller item (`conversation.item.input_audio_transcription.delta`). */
  onDelta(itemId: string, delta: string): void {
    const o = this.current;
    if (o === null || o.itemId !== itemId || delta.length === 0) return;
    const next: Overlap = { ...o, text: o.text + delta };
    this.current = next;
    const verdict = overlapVerdict(next.text);
    if (verdict !== 'empty') this.clearNoWordsTimer();
    if (verdict === 'interrupt' && next.cuttable) this.interrupt('words');
  }

  /** The item's final transcript (or '' when transcription failed): settle the overlap. */
  finish(itemId: string, finalText: string): OverlapEnd {
    const o = this.current;
    if (o === null || o.itemId !== itemId) return 'ignore';
    const verdict = overlapVerdict(finalText.trim().length > 0 ? finalText : o.text);
    if (verdict === 'interrupt' && o.cuttable) {
      this.interrupt('words');
      return 'interrupted';
    }
    this.close();
    if (verdict === 'interrupt') return 'answer';
    return o.late ? 'answer' : 'ignore';
  }

  close(): void {
    this.clearNoWordsTimer();
    this.current = null;
  }

  private interrupt(why: InterruptWhy): void {
    this.close();
    this.deps.onInterrupt(why);
  }

  private clearNoWordsTimer(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --root services/cti-api src/ai-voice/bridge-overlap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/ai-voice/bridge-overlap.ts services/cti-api/src/ai-voice/bridge-overlap.test.ts
git commit -m "feat(ai-voice): overlap gate decides when the caller is really interrupting"
```

---

### Task 3: Turn-stats contract, stats collector, and silence check

**Files:**
- Modify: `packages/contracts/src/ai-calls.ts` (add `AiCallTurnStats`; add `turnStats` to `AiCallTranscript`)
- Test: `packages/contracts/src/ai-calls.test.ts` (add cases)
- Create: `services/cti-api/src/ai-voice/bridge-turn-stats.ts`, `services/cti-api/src/ai-voice/bridge-turn-stats.test.ts`
- Create: `services/cti-api/src/ai-voice/bridge-silence.ts`, `services/cti-api/src/ai-voice/bridge-silence.test.ts`

**Interfaces:**
- Produces (contracts): `AiCallTurnStats` zod schema + type; `AiCallTranscript` gains `turnStats: AiCallTurnStats.nullable()`.
- Produces (cti-api):
  - `type BargeInMode = 'gate' | 'instant'` (exported from `bridge-turn-stats.ts`)
  - `percentile(sorted: readonly number[], p: number): number`
  - `class TurnStatsCollector` — `constructor(bargeIn: BargeInMode)`, `callerStopped(endpointMs: number, atMs: number): void`, `agentAudio(atMs: number): void`, `dropPending(): void`, `interruption(): void`, `listeningSound(): void`, `silenceCheck(): void`, `summary(): AiCallTurnStats`
  - `SILENCE_CHECK_MS = 8000`, `HOLD_CHECK_MS = 30000`, `MAX_SILENCE_CHECKS = 2`, `silenceNoteItem(seconds: number): object`, `class SilenceCheck` — `constructor(deps: { setTimer; clearTimer; onSilence(seconds: number): void })`, `arm(ms: number): void`, `cancel(): void`, `heard(): void`

- [ ] **Step 1: Add the contract (test first)**

Append to `packages/contracts/src/ai-calls.test.ts` (follow the file's existing import style):

```ts
describe('AiCallTurnStats', () => {
  const stats = {
    v: 1, bargeIn: 'gate', turns: 3,
    totalMs: { p50: 1900, p90: 2600, max: 3100 }, endpointMs: { p50: 1100 }, answerMs: { p50: 800 },
    interruptions: 1, listening: 4, silenceChecks: 0,
  };

  it('parses a stats object and a transcript that carries it', () => {
    expect(AiCallTurnStats.parse(stats)).toEqual(stats);
    const id = '00000000-0000-4000-8000-000000000001';
    expect(AiCallTranscript.parse({ aiCallId: id, lines: [], turnStats: stats }).turnStats).toEqual(stats);
    expect(AiCallTranscript.parse({ aiCallId: id, lines: [], turnStats: null }).turnStats).toBeNull();
  });

  it('accepts a call with no answered turns', () => {
    expect(AiCallTurnStats.parse({ ...stats, turns: 0, totalMs: null, endpointMs: null, answerMs: null }).turns).toBe(0);
  });

  it('rejects another version', () => {
    expect(AiCallTurnStats.safeParse({ ...stats, v: 2 }).success).toBe(false);
  });
});
```

Run: `npm test -w packages/contracts` → FAIL (`AiCallTurnStats` not exported).

In `packages/contracts/src/ai-calls.ts`, just above `export const AiCallTranscript`, add:

```ts
/**
 * One AI call's turn-taking numbers (cti-api bridge, spec 2026-10-09 §4.3), stored in
 * `ai_calls.turn_stats`. totalMs = endpointMs (how long after the caller stopped the turn was
 * declared over) + answerMs (turn over → first agent audio). Null blocks: no answered turn.
 */
export const AiCallTurnStats = z.object({
  v: z.literal(1),
  bargeIn: z.enum(['gate', 'instant']),
  turns: z.number().int().nonnegative(),
  totalMs: z.object({ p50: z.number(), p90: z.number(), max: z.number() }).nullable(),
  endpointMs: z.object({ p50: z.number() }).nullable(),
  answerMs: z.object({ p50: z.number() }).nullable(),
  interruptions: z.number().int().nonnegative(),
  listening: z.number().int().nonnegative(),
  silenceChecks: z.number().int().nonnegative(),
});
export type AiCallTurnStats = z.infer<typeof AiCallTurnStats>;
```

and change `AiCallTranscript` to:

```ts
export const AiCallTranscript = z.object({
  aiCallId: z.string().uuid(),
  lines: z.array(TranscriptLine),
  /** Null for calls made before turn stats existed. */
  turnStats: AiCallTurnStats.nullable(),
});
```

If `packages/contracts/src/index.ts` re-exports names explicitly (not `export *`), add `AiCallTurnStats`.

Run: `npm test -w packages/contracts` → PASS. Then `npm run build:packages`.

Then fix every place that now fails to typecheck because `AiCallTranscript` requires `turnStats` — at this point only producers in `services/outreach-api/src/ai-calls/results-query.ts` (`loadTranscript`, `loadPracticeTranscript`) and test fixtures. For now make both return `turnStats: null` (Task 11 reads the column). Run `npm run typecheck -w services/outreach-api` and `-w apps/outreach-web`; fix fixtures that build an `AiCallTranscript` by adding `turnStats: null`.

- [ ] **Step 2: Write the failing stats test**

`services/cti-api/src/ai-voice/bridge-turn-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { percentile, TurnStatsCollector } from './bridge-turn-stats.js';

describe('percentile (nearest rank)', () => {
  it('picks the nearest-rank value', () => {
    const xs = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(xs, 50)).toBe(500);
    expect(percentile(xs, 90)).toBe(900);
    expect(percentile(xs, 100)).toBe(1000);
    expect(percentile([42], 90)).toBe(42);
  });
});

describe('TurnStatsCollector', () => {
  it('pairs each caller stop with the next agent audio', () => {
    const s = new TurnStatsCollector('gate');
    s.callerStopped(1000, 10_000);
    s.agentAudio(10_800); // total 1800
    s.agentAudio(11_000); // no caller stop pending: ignored
    s.callerStopped(500, 20_000);
    s.agentAudio(20_700); // total 1200
    expect(s.summary()).toEqual({
      v: 1, bargeIn: 'gate', turns: 2,
      totalMs: { p50: 1200, p90: 1800, max: 1800 },
      endpointMs: { p50: 500 }, answerMs: { p50: 700 },
      interruptions: 0, listening: 0, silenceChecks: 0,
    });
  });

  it('clamps a negative endpoint to 0 and drops a pending stop on request', () => {
    const s = new TurnStatsCollector('instant');
    s.callerStopped(-40, 1000);
    s.agentAudio(1500);
    s.callerStopped(300, 5000);
    s.dropPending();
    s.agentAudio(9000);
    expect(s.summary()).toMatchObject({ turns: 1, totalMs: { p50: 500, p90: 500, max: 500 }, endpointMs: { p50: 0 } });
  });

  it('counts interruptions, listening sounds and silence checks; null blocks with no turns', () => {
    const s = new TurnStatsCollector('gate');
    s.interruption();
    s.listeningSound();
    s.listeningSound();
    s.silenceCheck();
    expect(s.summary()).toEqual({
      v: 1, bargeIn: 'gate', turns: 0, totalMs: null, endpointMs: null, answerMs: null,
      interruptions: 1, listening: 2, silenceChecks: 1,
    });
  });
});
```

Run: `npx vitest run --root services/cti-api src/ai-voice/bridge-turn-stats.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the collector**

`services/cti-api/src/ai-voice/bridge-turn-stats.ts`:

```ts
/**
 * Per-call turn-taking numbers (spec 2026-10-09 §4.3). A sample is one caller turn the agent
 * answered: endpointMs (caller stopped → turn declared over, from the audio clock) + answerMs
 * (turn declared over → first agent audio forwarded, wall clock). Twilio playout is not included.
 */
import type { AiCallTurnStats } from '@cti/contracts';

export type BargeInMode = 'gate' | 'instant';

interface Sample {
  readonly endpointMs: number;
  readonly answerMs: number;
}

/** Nearest-rank percentile of an ascending, non-empty list. */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

const ascending = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

export class TurnStatsCollector {
  private pending: { endpointMs: number; stoppedAt: number } | null = null;
  private samples: readonly Sample[] = [];
  private interruptions = 0;
  private listening = 0;
  private silenceChecks = 0;

  constructor(private readonly bargeIn: BargeInMode) {}

  /** The caller's turn was declared over at `atMs`, `endpointMs` after they actually stopped. */
  callerStopped(endpointMs: number, atMs: number): void {
    this.pending = { endpointMs: Math.max(0, Math.round(endpointMs)), stoppedAt: atMs };
  }

  /** The first audio of an agent response was forwarded at `atMs`. */
  agentAudio(atMs: number): void {
    if (this.pending === null) return;
    const { endpointMs, stoppedAt } = this.pending;
    this.samples = [...this.samples, { endpointMs, answerMs: Math.max(0, atMs - stoppedAt) }];
    this.pending = null;
  }

  /** The last caller stop will not be answered (a listening sound). */
  dropPending(): void {
    this.pending = null;
  }

  interruption(): void {
    this.interruptions += 1;
  }

  listeningSound(): void {
    this.listening += 1;
  }

  silenceCheck(): void {
    this.silenceChecks += 1;
  }

  summary(): AiCallTurnStats {
    const totals = ascending(this.samples.map((s) => s.endpointMs + s.answerMs));
    const endpoints = ascending(this.samples.map((s) => s.endpointMs));
    const answers = ascending(this.samples.map((s) => s.answerMs));
    const any = this.samples.length > 0;
    return {
      v: 1,
      bargeIn: this.bargeIn,
      turns: this.samples.length,
      totalMs: any ? { p50: percentile(totals, 50), p90: percentile(totals, 90), max: totals[totals.length - 1] as number } : null,
      endpointMs: any ? { p50: percentile(endpoints, 50) } : null,
      answerMs: any ? { p50: percentile(answers, 50) } : null,
      interruptions: this.interruptions,
      listening: this.listening,
      silenceChecks: this.silenceChecks,
    };
  }
}
```

Run the stats test → PASS.

- [ ] **Step 4: Write the failing silence-check test**

`services/cti-api/src/ai-voice/bridge-silence.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_CHECK_MS, MAX_SILENCE_CHECKS, SILENCE_CHECK_MS, SilenceCheck, silenceNoteItem } from './bridge-silence.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function check() {
  const onSilence = vi.fn();
  const c = new SilenceCheck({ setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (h) => clearTimeout(h), onSilence });
  return { c, onSilence };
}

describe('SilenceCheck', () => {
  it('fires once per arm with the seconds waited', () => {
    const { c, onSilence } = check();
    c.arm(SILENCE_CHECK_MS);
    vi.advanceTimersByTime(SILENCE_CHECK_MS - 1);
    expect(onSilence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilence).toHaveBeenCalledWith(8);
    vi.advanceTimersByTime(SILENCE_CHECK_MS * 3);
    expect(onSilence).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${MAX_SILENCE_CHECKS} check-ins until the caller is heard`, () => {
    const { c, onSilence } = check();
    for (let i = 0; i < MAX_SILENCE_CHECKS + 1; i += 1) {
      c.arm(SILENCE_CHECK_MS);
      vi.advanceTimersByTime(SILENCE_CHECK_MS);
    }
    expect(onSilence).toHaveBeenCalledTimes(MAX_SILENCE_CHECKS);
    c.heard();
    c.arm(HOLD_CHECK_MS);
    vi.advanceTimersByTime(HOLD_CHECK_MS);
    expect(onSilence).toHaveBeenLastCalledWith(30);
    expect(onSilence).toHaveBeenCalledTimes(MAX_SILENCE_CHECKS + 1);
  });

  it('cancel() and re-arming replace the pending timer', () => {
    const { c, onSilence } = check();
    c.arm(SILENCE_CHECK_MS);
    c.arm(HOLD_CHECK_MS);
    vi.advanceTimersByTime(SILENCE_CHECK_MS);
    expect(onSilence).not.toHaveBeenCalled();
    c.cancel();
    vi.advanceTimersByTime(HOLD_CHECK_MS);
    expect(onSilence).not.toHaveBeenCalled();
  });
});

describe('silenceNoteItem', () => {
  it('is a hidden user note the agent reads, not caller speech', () => {
    expect(silenceNoteItem(8)).toEqual({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '(No one has said anything for 8 seconds.)' }] },
    });
  });
});
```

Run → FAIL (module missing).

- [ ] **Step 5: Implement the silence check**

`services/cti-api/src/ai-voice/bridge-silence.ts`:

```ts
/**
 * Silence check-ins (spec 2026-10-09 §4.2). Semantic VAD has no idle timeout, so the bridge times
 * the silence after the agent finished speaking and hands the agent a hidden note; the prompt says
 * to check in once, then say goodbye. At most MAX_SILENCE_CHECKS notes until the caller is heard.
 */
import type { ClearTimer, SetTimer } from './bridge-playback.js';

/** Silence after the agent's turn before a check-in. */
export const SILENCE_CHECK_MS = 8000;
/** The same after the agent called wait_for_user (they asked it to hold on). */
export const HOLD_CHECK_MS = 30_000;
export const MAX_SILENCE_CHECKS = 2;

export function silenceNoteItem(seconds: number): object {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `(No one has said anything for ${seconds} seconds.)` }],
    },
  };
}

export interface SilenceCheckDeps {
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  onSilence(seconds: number): void;
}

export class SilenceCheck {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sent = 0;

  constructor(private readonly deps: SilenceCheckDeps) {}

  arm(ms: number): void {
    this.cancel();
    if (this.sent >= MAX_SILENCE_CHECKS) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.sent += 1;
      this.deps.onSilence(Math.round(ms / 1000));
    }, ms);
  }

  cancel(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  /** The caller spoke: cancel, and allow check-ins again. */
  heard(): void {
    this.cancel();
    this.sent = 0;
  }
}
```

Run → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/ai-calls.ts packages/contracts/src/ai-calls.test.ts services/cti-api/src/ai-voice/bridge-turn-stats.ts services/cti-api/src/ai-voice/bridge-turn-stats.test.ts services/cti-api/src/ai-voice/bridge-silence.ts services/cti-api/src/ai-voice/bridge-silence.test.ts
# plus every file you touched to add turnStats: null (list them explicitly)
git commit -m "feat(ai-voice): turn stats contract and collector, silence check-in timer"
```

---

### Task 4: Playback tracker — current item, audio left, drained listener

**Files:**
- Modify: `services/cti-api/src/ai-voice/bridge-playback.ts`
- Test: `services/cti-api/src/ai-voice/bridge-playback.test.ts`

**Interfaces:**
- Produces: `export const PCMU_BYTES_PER_MS = 8` (was a private const); constructor option `onDrained?: () => void`; `get currentItemId(): string | null`; `remainingMs(): number`.
- Semantics: `onDrained` fires when queued agent audio finishes playing naturally (all marks echoed and audio done) — **not** after `interrupt()`/`reset()`. `remainingMs()`: `0` when nothing plays, `Infinity` while the response is still streaming, else generated − played (≥ 0).

- [ ] **Step 1: Write the failing tests** (append to `bridge-playback.test.ts`; reuse its helpers if any, else this standalone block)

```ts
describe('drained listener, current item and audio left', () => {
  const b64 = (ms: number) => Buffer.alloc(ms * 8).toString('base64');

  it('calls onDrained once the last mark plays after audio done, not on interrupt', () => {
    const onDrained = vi.fn();
    const p = new PlaybackTracker({ onDrained });
    const m1 = p.onAudioDelta('item_1', b64(100));
    p.onAudioDone();
    expect(onDrained).not.toHaveBeenCalled();
    p.onMark(m1);
    expect(onDrained).toHaveBeenCalledTimes(1);

    p.onAudioDelta('item_2', b64(100));
    p.interrupt();
    expect(onDrained).toHaveBeenCalledTimes(1);
  });

  it('does not call onDrained for a response with no audio', () => {
    const onDrained = vi.fn();
    const p = new PlaybackTracker({ onDrained });
    p.onResponseDone();
    expect(onDrained).not.toHaveBeenCalled();
  });

  it('reports the current item and the audio left to play', () => {
    const p = new PlaybackTracker();
    expect(p.currentItemId).toBeNull();
    expect(p.remainingMs()).toBe(0);
    p.onInboundMedia(1000);
    p.onAudioDelta('item_1', b64(3000));
    expect(p.currentItemId).toBe('item_1');
    expect(p.remainingMs()).toBe(Number.POSITIVE_INFINITY); // still streaming
    p.onAudioDone();
    p.onInboundMedia(2500);
    expect(p.remainingMs()).toBe(1500);
    p.onInboundMedia(9000);
    expect(p.remainingMs()).toBe(0);
  });
});
```

(Ensure `vi` is imported in the test file.)

Run: `npx vitest run --root services/cti-api src/ai-voice/bridge-playback.test.ts` → FAIL.

- [ ] **Step 2: Implement**

In `bridge-playback.ts`:
1. `const PCMU_BYTES_PER_MS = 8;` → `export const PCMU_BYTES_PER_MS = 8;`
2. Add fields `private busy = false;` and `private readonly onDrained: () => void;`.
3. Constructor:

```ts
  constructor(timers: { setTimer?: SetTimer; clearTimer?: ClearTimer; onDrained?: () => void } = {}) {
    this.setTimer = timers.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = timers.clearTimer ?? ((h) => clearTimeout(h));
    this.onDrained = timers.onDrained ?? (() => undefined);
  }
```

4. In `onAudioDelta`, after `this.streaming = true;` add `this.busy = true;`.
5. Add:

```ts
  /** The agent item now queued or playing, or null. */
  get currentItemId(): string | null {
    return this.itemId;
  }

  /** Agent audio left to play: 0 when nothing is queued, Infinity while the response still streams. */
  remainingMs(): number {
    if (!this.playing) return 0;
    if (this.streaming) return Number.POSITIVE_INFINITY;
    const generatedMs = Math.floor(this.generatedBytes / PCMU_BYTES_PER_MS);
    return Math.max(0, generatedMs - (this.latestMediaMs - this.itemStartMs));
  }
```

6. Replace `reset()`'s final `this.settle();` with `this.settle(false);` and replace `settle()`:

```ts
  /** Release drain waiters once drained; `notify` = the audio played out (not cut). */
  private settle(notify = true): void {
    if (!this.drained()) return;
    this.releaseAll();
    if (!this.busy) return;
    this.busy = false;
    if (notify) this.onDrained();
  }
```

Run the playback tests → PASS; run `bridge.test.ts` → still PASS.

- [ ] **Step 3: Commit**

```bash
git add services/cti-api/src/ai-voice/bridge-playback.ts services/cti-api/src/ai-voice/bridge-playback.test.ts
git commit -m "feat(ai-voice): playback tracker reports the playing item, audio left, and when it played out"
```

---

### Task 5: `wait_for_user` tool

**Files:**
- Modify: `services/cti-api/src/ai-voice/prompt-tools.ts` (tool schema; include it in `AI_CALL_TOOLS`, therefore in `toolsFor`)
- Modify: `services/cti-api/src/ai-voice/bridge-tools.ts` (answer it in the bridge; batch reports `speak`)
- Modify: `services/cti-api/src/ai-voice/bridge.ts` (call site only)
- Test: `services/cti-api/src/ai-voice/bridge.test.ts` (tool-calls block), `prompt-tools`/`prompt` tests that count tools

**Interfaces:**
- Produces: `WAIT_FOR_USER = 'wait_for_user'`, `WAIT_FOR_USER_TOOL: RealtimeFunctionTool` (prompt-tools.ts); `ToolResult.then` gains `'wait'`; `runToolBatch(...)` now resolves `{ carryOn: boolean; speak: boolean }` (`speak` false when any call in the batch was `wait_for_user`).
- `wait_for_user` is **not** in `TOOL_NAMES` (those go to the call service); the bridge answers it with `{"ok":true}` and never calls `hooks.onTool`.

- [ ] **Step 1: Write the failing tests** (add inside `describe('tool calls', …)` in `bridge.test.ts`)

```ts
  it('answers wait_for_user itself and does not ask the agent to speak', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('wait_for_user', '{}', 'call_w')));
    await flush();
    expect(hooks.onTool).not.toHaveBeenCalled();
    expect(openai.sent).toEqual([
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_w', output: '{"ok":true}' } },
    ]);
  });

  it('a batch with wait_for_user and save_qualification runs both and stays quiet', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'c1'), fnCall('wait_for_user', '{}', 'c2')));
    await flush();
    expect(hooks.onTool).toHaveBeenCalledTimes(1);
    expect(openai.types()).toEqual(['conversation.item.create', 'conversation.item.create']);
  });
```

And in the prompt-tools/prompt tests, add:

```ts
it('offers wait_for_user on every call, with no parameters', () => {
  const tool = AI_CALL_TOOLS.find((t) => t.name === 'wait_for_user');
  expect(tool?.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  expect(toolsFor([]).some((t) => t.name === 'wait_for_user')).toBe(true);
});
```

Run the bridge and prompt tests → FAIL. Update any existing test that pins the exact tool list/count to include `wait_for_user` last.

- [ ] **Step 2: Implement**

`prompt-tools.ts` — add above `AI_CALL_TOOLS`:

```ts
/** Answered by the bridge itself (no side effect): stay quiet and keep listening. Spec 2026-10-09 §4.2. */
export const WAIT_FOR_USER = 'wait_for_user';

export const WAIT_FOR_USER_TOOL: RealtimeFunctionTool = {
  type: 'function',
  name: WAIT_FOR_USER,
  description:
    "Say nothing and keep listening: what you heard wasn't meant for you (a TV, someone else in the room, noise), or they asked you to hold on.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};
```

and append `WAIT_FOR_USER_TOOL` as the last entry of `AI_CALL_TOOLS` (so `toolsFor` includes it; keep `book_appointment`'s position as `toolsFor` builds it today). Re-export `WAIT_FOR_USER` from `prompt.ts` next to the other prompt-tools re-exports.

`bridge-tools.ts`:

```ts
import { TOOL_NAMES, WAIT_FOR_USER, type ToolName } from './prompt.js';

export interface ToolResult {
  output: string;
  then?: 'hangup' | 'transfer' | 'continue' | 'wait';
}

export interface BatchResult {
  /** False when any call ended the conversation (hangup / transfer). */
  carryOn: boolean;
  /** False when the agent chose to stay quiet (wait_for_user): no response.create. */
  speak: boolean;
}

const WAITING: ToolResult = { output: '{"ok":true}', then: 'wait' };

/** Run calls in order and send every output. */
export async function runToolBatch(calls: readonly FunctionCall[], deps: ToolDeps): Promise<BatchResult> {
  let carryOn = true;
  let speak = true;
  for (const call of calls) {
    const result = await runTool(call, deps);
    deps.send(functionCallOutput(call.call_id, result.output));
    if (result.then === 'hangup' || result.then === 'transfer') carryOn = false;
    if (result.then === 'wait') speak = false;
  }
  return { carryOn, speak };
}
```

and at the top of `runTool`: `if (call.name === WAIT_FOR_USER) return WAITING;`. Update the file's header comment ("The batch reports whether the conversation continues and whether the agent should speak").

`bridge.ts` `onResponseDone` — keep behaviour, adapt the call site:

```ts
        const { carryOn, speak } = await runToolBatch(calls, deps);
        if (!carryOn) this.closeConversation();
        if (!this.closing && speak) this.sendOpenAi({ type: 'response.create' });
```

(Task 7 replaces this block.)

- [ ] **Step 3: Run tests** — `bridge.test.ts`, prompt tests, then `npm run typecheck -w services/cti-api`. Fix `service-tools.ts` only if its exhaustive switch now complains (it should not: `wait_for_user` is not a `ToolName`). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/cti-api/src/ai-voice/prompt-tools.ts services/cti-api/src/ai-voice/prompt.ts services/cti-api/src/ai-voice/bridge-tools.ts services/cti-api/src/ai-voice/bridge.ts services/cti-api/src/ai-voice/bridge.test.ts
# plus the prompt/prompt-tools test files you changed
git commit -m "feat(ai-voice): wait_for_user lets the agent stay quiet for TV, side talk, or 'hold on'"
```

---

### Task 6: Config and session settings

**Files:**
- Modify: `services/cti-api/src/config.ts` (two vars)
- Modify: `services/cti-api/src/ai-voice/bridge-session.ts` (`SessionSettings`, `sessionUpdate`)
- Modify: `services/cti-api/src/ai-voice/bridge.ts` (`BridgeOptions`, pass settings)
- Modify: `services/cti-api/src/ai-voice/stream-session.ts` (pass config)
- Test: `services/cti-api/src/ai-voice/bridge.test.ts` (`describe('session.update')`), config test if one pins defaults, `stream-session.test.ts`

**Interfaces:**
- Produces: config `AI_VOICE_BARGE_IN: 'gate' | 'instant'` (default `'gate'`), `AI_VOICE_TRANSCRIBE_MODEL: string` (default `'gpt-live-transcribe'`); `BridgeOptions.bargeIn?: BargeInMode` (default `'instant'`), `BridgeOptions.transcribeModel?: string` (default `LEGACY_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'`); `SessionSettings` gains `bargeIn: BargeInMode` and `transcribeModel: string`.
- Gate session: `turn_detection: { type: 'semantic_vad', eagerness, create_response: false, interrupt_response: false }`. Instant session: unchanged (`create_response: true, interrupt_response: true`). `stopAutoResponses` unchanged (used only in instant mode after Task 7).

- [ ] **Step 1: Write the failing tests** (in `describe('session.update')`)

```ts
  it('gate mode turns off server responses and barge-in and uses the given transcriber', () => {
    const { openai, bridge } = setup({ bargeIn: 'gate', transcribeModel: 'gpt-live-transcribe' });
    bridge.start();
    const session = (openai.sent[0] as { session: { audio: { input: Record<string, unknown> } } }).session;
    expect(session.audio.input.transcription).toEqual({ model: 'gpt-live-transcribe', language: 'en' });
    expect(session.audio.input.turn_detection).toEqual({
      type: 'semantic_vad',
      eagerness: 'auto',
      create_response: false,
      interrupt_response: false,
    });
  });
```

The existing "sends the GA session shape on start" test (default options) must still pass unchanged — it pins the legacy defaults.

In `stream-session.test.ts`, find the test that asserts the options passed to `createBridge` (search for `vadEagerness`) and add `bargeIn: 'gate'` and `transcribeModel: 'gpt-live-transcribe'` to its expectation (the test config gets the defaults).

Run → FAIL.

- [ ] **Step 2: Implement**

`config.ts`, after `AI_VOICE_VOICE`:

```ts
  /**
   * Barge-in (spec 2026-10-09): `gate` = the bridge keeps the agent talking through "mm-hmm"
   * and stops it on a real interruption, from the caller's streamed words; `instant` = the
   * pre-2026-10-09 behaviour (OpenAI stops the agent on any caller sound). Rollback switch.
   */
  AI_VOICE_BARGE_IN: z.enum(['gate', 'instant']).default('gate'),
  /** The Realtime session transcriber; the gate needs one that streams words while the caller talks. */
  AI_VOICE_TRANSCRIBE_MODEL: z.string().default('gpt-live-transcribe'),
```

`bridge-session.ts`:

```ts
import type { BargeInMode } from './bridge-turn-stats.js';

export interface SessionSettings {
  model: string;
  voice: string;
  instructions: string;
  tools: readonly unknown[];
  reasoningEffort: ReasoningEffort;
  vadEagerness: VadEagerness;
  bargeIn: BargeInMode;
  transcribeModel: string;
}
```

Delete `const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';`. Add:

```ts
/** Gate mode: the bridge decides when the agent answers and when it is interrupted (spec 2026-10-09 §4.1). */
function gateTurnDetection(eagerness: VadEagerness): object {
  return { type: 'semantic_vad', eagerness, create_response: false, interrupt_response: false };
}
```

In `sessionUpdate`: `transcription: { model: s.transcribeModel, language: 'en' }` and `turn_detection: s.bargeIn === 'gate' ? gateTurnDetection(s.vadEagerness) : turnDetection(s.vadEagerness, true)`.

`bridge.ts`:

```ts
import type { BargeInMode } from './bridge-turn-stats.js';
export type { BargeInMode };

/** The transcriber before 2026-10-09; the bridge's default so a bare BridgeOptions behaves as before. */
export const LEGACY_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
```

`BridgeOptions` gains:

```ts
  /** 'gate' (spec 2026-10-09) or 'instant' (default here; the service passes AI_VOICE_BARGE_IN). */
  bargeIn?: BargeInMode;
  /** Session transcriber (default LEGACY_TRANSCRIBE_MODEL; the service passes AI_VOICE_TRANSCRIBE_MODEL). */
  transcribeModel?: string;
```

Add a field `private readonly bargeIn: BargeInMode;`, set `this.bargeIn = opts.bargeIn ?? 'instant';` in the constructor, and in `start()` build the session from:

```ts
    this.outbox.prepend(
      JSON.stringify(
        sessionUpdate({ ...this.opts, bargeIn: this.bargeIn, transcribeModel: this.opts.transcribeModel ?? LEGACY_TRANSCRIBE_MODEL }),
      ),
    );
```

`stream-session.ts`, in the options object passed to `createBridge` (next to `vadEagerness`):

```ts
      bargeIn: cfg.AI_VOICE_BARGE_IN,
      transcribeModel: cfg.AI_VOICE_TRANSCRIBE_MODEL,
```

- [ ] **Step 3: Run** `bridge.test.ts`, `stream-session.test.ts`, any config test, `npm run typecheck -w services/cti-api` → PASS.

- [ ] **Step 4: Commit**

```bash
git add services/cti-api/src/config.ts services/cti-api/src/ai-voice/bridge-session.ts services/cti-api/src/ai-voice/bridge.ts services/cti-api/src/ai-voice/stream-session.ts services/cti-api/src/ai-voice/bridge.test.ts services/cti-api/src/ai-voice/stream-session.test.ts
git commit -m "feat(ai-voice): AI_VOICE_BARGE_IN and AI_VOICE_TRANSCRIBE_MODEL; gate sessions turn off server barge-in"
```

---

### Task 7: The bridge drives turns in gate mode

**Files:**
- Modify: `services/cti-api/src/ai-voice/bridge.ts`
- Test: `services/cti-api/src/ai-voice/bridge.test.ts` (new `describe('barge-in gate')`)

**Interfaces:**
- Consumes: `OverlapGate`, `LATE_OVERLAP_MS` (Task 2), `PlaybackTracker` additions (Task 4), `BatchResult` (Task 5), `BargeInMode` (Task 3/6).
- Produces (private, for Task 8): `requestResponse()`, `agentSpeaking()`, `note(text)`, `onAgentFinished()`, fields `responsePending`, `responseHasAudio`, `toolsRunning`, `wantResponse`, `answerAfterPlayback`, `callerTalking`, `holding`, `agentSpoke`, `openerItemId`, `sentAudioMs`.

Rules (spec §4.1) — all only when `bargeIn === 'gate'` unless noted:
1. `speech_started` (item_id): set `callerSpoke`, `callerTalking`, clear `holding`, cancel the opener timer. **Instant:** today's cut (clear + truncate), nothing else. **Gate:** if closing → nothing; if `agentSpeaking()` → `gate.open(itemId, { cuttable: playback.currentItemId !== openerItemId, late: playback.remainingMs() <= LATE_OVERLAP_MS })`; else if a response is active with no audio yet → `response.cancel`.
2. Transcription delta → `gate.onDelta`.
3. Gate interrupt → `response.cancel` (if a response is active), Twilio `clear`, truncate at what was heard, system transcript note `[stopped — they interrupted]`, info log with `why`.
4. `speech_stopped`: clear `callerTalking`.
5. `committed` (item_id): gate mode, not closing, not the open overlap's item → `requestResponse()`.
6. `…transcription.completed` / `…transcription.failed` for the open overlap's item → `gate.finish`: `'interrupted'` → `requestResponse()`; `'answer'` → if `agentSpeaking()` set `answerAfterPlayback`, else `requestResponse()`; `'ignore'` → nothing.
7. `requestResponse()` (both modes): no-op when closing/ended; deferred (`wantResponse`) while a response is pending/active or tools run; otherwise `response.create`. Every `response.create` the bridge sends goes through it (opener, after tools, answers). An OpenAI `error` event after the session is ready clears `responsePending` (a rejected `response.create` never gets `response.created`) and honours `wantResponse`, so the agent can never get stuck silent.
8. `response.created` → `responsePending = false`, `responseActive = true`, `responseHasAudio = false`. First forwarded audio delta of a response → `responseHasAudio = true`, `agentSpoke = true`, `openerItemId ??= itemId`.
9. `response.done` without tool calls → if `wantResponse`, `requestResponse()`. With tool calls → `toolsRunning` while the batch runs; then `carryOn` false → `closeConversation()`; `speak` → `requestResponse()`; else set `holding` and (Task 8) arm the silence check; finally honour `wantResponse`.
10. Playback drained (`onDrained`) → if `answerAfterPlayback`, clear it and `requestResponse()` (Task 8 adds the silence check here).
11. `closeConversation()` → closing; close the gate; send `stopAutoResponses` **only in instant mode** (gate sessions never auto-respond).
12. `silence()` and `finish()` also close the gate.

- [ ] **Step 1: Write the failing tests**

Add after the existing `describe('agent audio and barge-in', …)`:

```ts
describe('barge-in gate', () => {
  const marks = (twilio: FakeSocket) =>
    twilio.sent.filter((m) => m.event === 'mark').map((m) => (m.mark as { name: string }).name);
  const playAll = (twilio: FakeSocket) => {
    for (const name of marks(twilio)) twilio.msg({ event: 'mark', streamSid: SID, mark: { name } });
  };
  const doneEmpty = { type: 'response.done', response: { status: 'completed', output: [] } };
  const talk = (openai: FakeSocket, itemId: string, ms: number) => {
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: itemId, delta: audio(ms) });
  };

  /** Gate mode; the opener (item_0) played out; the agent is now 500 ms into a 3 s answer (item_1), still streaming. */
  function talking() {
    const s = setup({ bargeIn: 'gate', transcribeModel: 'gpt-live-transcribe' });
    s.bridge.start();
    s.openai.msg(READY);
    talk(s.openai, 'item_0', 100);
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(doneEmpty);
    playAll(s.twilio);
    s.twilio.msg(media(1000));
    talk(s.openai, 'item_1', 3000);
    s.twilio.msg(media(1500));
    s.twilio.clearSent();
    s.openai.clearSent();
    return s;
  }
  const started = (openai: FakeSocket, id = 'c1') => openai.msg({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: 1500 });
  const delta = (openai: FakeSocket, text: string, id = 'c1') =>
    openai.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta: text });
  const stopped = (openai: FakeSocket, id = 'c1') => openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: 2200 });
  const committed = (openai: FakeSocket, id = 'c1') => openai.msg({ type: 'input_audio_buffer.committed', item_id: id });
  const completed = (openai: FakeSocket, text: string, id = 'c1') =>
    openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text });

  it('keeps talking through "mm-hmm" and never answers it', () => {
    const { twilio, openai } = talking();
    started(openai);
    delta(openai, ' Mm');
    delta(openai, '-hmm');
    stopped(openai);
    committed(openai);
    completed(openai, 'Mm-hmm.');
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(200) });
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(twilio.sent.some((m) => m.event === 'media')).toBe(true);
    expect(openai.sent).toEqual([]);
  });

  it('stops on "wait" — cancel, clear, truncate at what was heard — and answers when their turn ends', () => {
    const { twilio, openai, hooks } = talking();
    started(openai);
    delta(openai, ' Wait');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    expect(openai.sent).toEqual([
      { type: 'response.cancel' },
      { type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 500 },
    ]);
    expect(hooks.onTranscript).toHaveBeenCalledWith(expect.objectContaining({ role: 'system', text: '[stopped — they interrupted]' }));
    openai.clearSent();
    stopped(openai);
    committed(openai); // the cancelled response has not reported done yet: wait for it
    expect(openai.sent).toEqual([]);
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    expect(openai.sent).toEqual([{ type: 'response.create' }]);
  });

  it('stops on the second real word', () => {
    const { twilio, openai } = talking();
    started(openai);
    delta(openai, " I'm");
    expect(twilio.sent).toEqual([]);
    delta(openai, ' interested');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
  });

  it('stops after 2 s of talk with no words', async () => {
    const { twilio, openai } = talking();
    started(openai);
    await vi.advanceTimersByTimeAsync(1999);
    expect(twilio.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
  });

  it('a late "yeah sure" is answered once the agent has finished', () => {
    const { twilio, openai } = talking();
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    twilio.msg(media(3000)); // 1 s of item_1 left to play
    openai.clearSent();
    started(openai);
    delta(openai, ' Yeah sure');
    stopped(openai);
    committed(openai);
    completed(openai, 'Yeah, sure.');
    expect(openai.sent).toEqual([]);
    playAll(twilio);
    expect(openai.sent).toEqual([{ type: 'response.create' }]);
  });

  it('never cuts the opener; a question over it is answered after it plays', async () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    twilio.msg(media(100));
    talk(openai, 'item_0', 4000);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    twilio.clearSent();
    openai.clearSent();
    started(openai);
    delta(openai, ' Wait who is this');
    await vi.advanceTimersByTimeAsync(3000);
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    stopped(openai);
    committed(openai);
    completed(openai, 'Wait, who is this?');
    expect(openai.sent).toEqual([]);
    playAll(twilio);
    expect(openai.sent).toEqual([{ type: 'response.create' }]);
  });

  it('cancels a response that has not played a sound when the caller keeps talking', () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.msg({ type: 'response.created' });
    twilio.clearSent();
    openai.clearSent();
    started(openai);
    expect(openai.sent).toEqual([{ type: 'response.cancel' }]);
    expect(twilio.sent).toEqual([]);
  });

  it('answers a normal turn when it is committed', () => {
    const { openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    started(openai);
    stopped(openai);
    committed(openai);
    expect(openai.sent).toEqual([{ type: 'response.create' }]);
    committed(openai, 'c2'); // a second turn before response.created: one response at a time
    expect(openai.sent).toEqual([{ type: 'response.create' }]);
    openai.msg({ type: 'response.created' });
    openai.msg(doneEmpty);
    expect(openai.sent).toEqual([{ type: 'response.create' }, { type: 'response.create' }]);
  });

  it('a caller turn during a slow tool waits for the batch, then one response', async () => {
    let release: () => void = () => undefined;
    const onTool = vi.fn(() => new Promise<{ output: string }>((r) => { release = () => r({ output: '{"ok":true}' }); }));
    const { openai, bridge } = setup({ bargeIn: 'gate' }, { onTool });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'c1')] } });
    await flush();
    committed(openai, 'c9');
    expect(openai.types()).toEqual([]);
    release();
    await flush();
    expect(openai.types()).toEqual(['conversation.item.create', 'response.create']);
  });

  it('a rejected response.create does not leave the agent stuck silent', () => {
    const { openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    committed(openai, 'c1');
    committed(openai, 'c2'); // deferred behind the first
    expect(openai.sent).toEqual([{ type: 'response.create' }]);
    openai.msg({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'busy' } });
    expect(openai.sent).toEqual([{ type: 'response.create' }, { type: 'response.create' }]);
  });

  it('ignores caller speech over the goodbye once a tool ended the call', async () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' }, { onTool: vi.fn(async () => ({ output: 'bye', then: 'hangup' as const })) });
    bridge.start();
    openai.msg(READY);
    talk(openai, 'item_0', 100);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    playAll(twilio);
    talk(openai, 'item_1', 2000);
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('end_call', '{"outcome":"not_interested"}', 'e1')] } });
    await flush();
    twilio.clearSent();
    openai.clearSent();
    started(openai);
    delta(openai, ' Wait wait');
    committed(openai);
    expect(twilio.sent).toEqual([]);
    expect(openai.sent).toEqual([]);
  });
});
```

Run: `npx vitest run --root services/cti-api src/ai-voice/bridge.test.ts` → the new cases FAIL; existing cases PASS.

- [ ] **Step 2: Implement in `bridge.ts`**

Imports:

```ts
import { LATE_OVERLAP_MS, OverlapGate, type InterruptWhy } from './bridge-overlap.js';
import { PCMU_BYTES_PER_MS, PlaybackTracker, base64Bytes, type ClearTimer, type SetTimer, type Truncation } from './bridge-playback.js';
```

New fields (next to the existing ones):

```ts
  private readonly gate: OverlapGate;
  /** Our response.create is in flight (response.created not seen yet). */
  private responsePending = false;
  /** The active response has forwarded audio to Twilio. */
  private responseHasAudio = false;
  private toolsRunning = false;
  /** A turn wants an answer while a response or a tool batch is still going. */
  private wantResponse = false;
  /** A late overlap ("yeah sure" over the end of a question): answer once the agent's audio has played. */
  private answerAfterPlayback = false;
  private callerTalking = false;
  /** The agent called wait_for_user and nobody has spoken since. */
  private holding = false;
  private agentSpoke = false;
  /** The first agent item that played: the opener, never cut by the gate. */
  private openerItemId: string | null = null;
  /** Caller audio handed to OpenAI so far, in ms (for endpoint timing). */
  private sentAudioMs = 0;
```

Constructor (replace the `this.playback = …` line and add the gate):

```ts
    this.playback = new PlaybackTracker({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onDrained: () => this.onAgentFinished(),
    });
    this.gate = new OverlapGate({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onInterrupt: (why) => this.interruptAgent(why),
    });
```

Twilio media: count forwarded caller audio:

```ts
        if (payload) {
          this.sentAudioMs += base64Bytes(payload) / PCMU_BYTES_PER_MS;
          this.sendOpenAi({ type: 'input_audio_buffer.append', audio: payload }, true);
        }
```

OpenAI switch — replace/add these cases:

```ts
      case 'input_audio_buffer.speech_started':
        return this.onCallerSpeech(str(msg.item_id));
      case 'input_audio_buffer.speech_stopped':
        return this.onCallerStopped();
      case 'input_audio_buffer.committed':
        return this.onCallerTurn(str(msg.item_id));
      case 'conversation.item.input_audio_transcription.delta':
        return this.gate.onDelta(str(msg.item_id), str(msg.delta));
      case 'response.created':
        this.responsePending = false;
        this.responseActive = true;
        this.responseHasAudio = false;
        return;
      case 'conversation.item.input_audio_transcription.completed':
        this.transcript('caller', msg.transcript);
        return this.onCallerFinal(str(msg.item_id), str(msg.transcript));
      case 'conversation.item.input_audio_transcription.failed':
        return this.onCallerFinal(str(msg.item_id), '');
```

Replace `onCallerSpeech` and add the turn methods:

```ts
  private onCallerSpeech(itemId: string): void {
    this.callerSpoke = true;
    this.callerTalking = true;
    this.holding = false;
    this.cancelOpener();
    if (this.bargeIn === 'instant') return this.cutAgent();
    if (this.closing) return;
    if (this.agentSpeaking()) {
      const cuttable = this.playback.currentItemId !== this.openerItemId;
      this.gate.open(itemId, { cuttable, late: this.playback.remainingMs() <= LATE_OVERLAP_MS });
      return;
    }
    // A response that has not played a sound yet: drop it unheard; their turn gets a fresh one.
    if (this.responseActive && !this.responseHasAudio) this.sendOpenAi({ type: 'response.cancel' });
  }

  private onCallerStopped(): void {
    this.callerTalking = false;
  }

  /** Gate mode: a committed caller turn gets an answer unless it is an overlap still being judged. */
  private onCallerTurn(itemId: string): void {
    if (this.bargeIn !== 'gate' || this.closing || this.gate.itemId === itemId) return;
    this.requestResponse();
  }

  /** The final transcript (or a failed one) of the overlap being judged. */
  private onCallerFinal(itemId: string, text: string): void {
    if (this.bargeIn !== 'gate' || this.gate.itemId !== itemId) return;
    const end = this.gate.finish(itemId, text);
    if (end === 'interrupted') return this.requestResponse();
    if (end !== 'answer') return;
    if (this.agentSpeaking()) this.answerAfterPlayback = true;
    else this.requestResponse();
  }

  /** The agent is audible or about to be: audio queued in Twilio, or a response that already produced audio. */
  private agentSpeaking(): boolean {
    return this.playback.playing || (this.responseActive && this.responseHasAudio);
  }

  /** Stop the agent where the caller stopped hearing it. */
  private cutAgent(): void {
    const cut = this.playback.interrupt();
    if (!cut) return;
    this.sendTwilio({ event: 'clear', streamSid: this.opts.streamSid });
    this.truncateOnce(cut);
  }

  /** The gate decided the caller is really talking. */
  private interruptAgent(why: InterruptWhy): void {
    if (this.responseActive) this.sendOpenAi({ type: 'response.cancel' });
    this.cutAgent();
    this.hooks.log.info({ why }, 'ai-voice bridge: caller interrupted the agent');
    this.note('[stopped — they interrupted]');
  }

  /** Ask the agent to speak — one response at a time. */
  private requestResponse(): void {
    if (this.closing || this.ended) return;
    if (this.responsePending || this.responseActive || this.toolsRunning) {
      this.wantResponse = true;
      return;
    }
    this.wantResponse = false;
    this.responsePending = true;
    this.sendOpenAi({ type: 'response.create' });
  }

  /** The agent's queued audio finished playing. */
  private onAgentFinished(): void {
    if (this.ended || this.closing) return;
    if (!this.answerAfterPlayback) return;
    this.answerAfterPlayback = false;
    this.requestResponse();
  }

  /** A system line in the transcript (not spoken). */
  private note(text: string): void {
    this.guard('onTranscript', () => this.hooks.onTranscript({ role: 'system', text, at: new Date(this.now()) }));
  }
```

`openCall()` — replace `this.sendOpenAi({ type: 'response.create' });` with `this.requestResponse();`.

`onOpenAiError` — release a rejected request (keep the existing log and fail-closed lines):

```ts
  private onOpenAiError(fields: Record<string, string>): void {
    this.hooks.log.warn(fields, 'ai-voice bridge: openai error event');
    if (!this.sessionReady) return this.notConfigured(fields.message || fields.code || 'error');
    // A rejected response.create never gets response.created: don't stay "pending" forever.
    if (!this.responsePending) return;
    this.responsePending = false;
    if (this.wantResponse) this.requestResponse();
  }
```

`onAgentAudio` — after the early-return guard and before `sendTwilio`:

```ts
    if (!this.responseHasAudio) {
      this.responseHasAudio = true;
      this.agentSpoke = true;
      this.openerItemId ??= itemId;
    }
```

`onResponseDone` — replace with:

```ts
  private onResponseDone(response: Msg): void {
    this.responseActive = false;
    this.responsePending = false;
    this.playback.onResponseDone();
    const calls = functionCalls(response);
    if (calls.length === 0) return this.afterResponse();
    const deps = {
      onTool: this.hooks.onTool.bind(this.hooks),
      log: this.hooks.log,
      send: (m: object) => this.sendOpenAi(m),
    };
    this.toolsRunning = true;
    this.toolChain = this.toolChain
      .then(async () => {
        const { carryOn, speak } = await runToolBatch(calls, deps);
        this.toolsRunning = false;
        if (!carryOn) this.closeConversation();
        if (speak) return this.requestResponse();
        this.holding = true;
        this.afterResponse();
      })
      .catch((e: unknown) => {
        this.toolsRunning = false;
        this.hooks.log.error({ err: errText(e) }, 'ai-voice bridge: tool batch failed');
      });
  }

  /** A response (or a quiet tool batch) finished without asking for another. */
  private afterResponse(): void {
    if (this.wantResponse) this.requestResponse();
  }
```

`closeConversation()`:

```ts
  private closeConversation(): void {
    this.closing = true;
    this.gate.close();
    // Gate sessions never auto-respond; instant sessions stop VAD responses during the drain.
    if (this.bargeIn === 'gate' || this.autoResponsesOff) return;
    this.autoResponsesOff = true;
    this.sendOpenAi(stopAutoResponses(this.opts));
  }
```

`silence()`: add `this.gate.close();` after `this.cancelOpener();`. `finish()`: add `this.gate.close();` after `this.cancelOpener();`.

Update the file header comment: describe gate vs instant in two sentences and point at the spec.

- [ ] **Step 3: Run** `npx vitest run --root services/cti-api src/ai-voice/bridge.test.ts` → all PASS (old and new). If an old test fails, it is a behaviour change you introduced in instant mode — fix the code, not the test (the only intended instant-mode change: `response.create` is deferred while a response is active, which no existing test exercises). Then `npm run typecheck -w services/cti-api`.

- [ ] **Step 4: Commit**

```bash
git add services/cti-api/src/ai-voice/bridge.ts services/cti-api/src/ai-voice/bridge.test.ts
git commit -m "feat(ai-voice): in gate mode the bridge keeps talking through mm-hmm and stops on real interruptions"
```

---

### Task 8: Silence check-ins and turn stats in the bridge

**Files:**
- Modify: `services/cti-api/src/ai-voice/bridge.ts`
- Test: `services/cti-api/src/ai-voice/bridge.test.ts` (new `describe('silence check-ins')`, `describe('turn stats')`)

**Interfaces:**
- Consumes: `SilenceCheck`, `SILENCE_CHECK_MS`, `HOLD_CHECK_MS`, `silenceNoteItem` (Task 3); `TurnStatsCollector` (Task 3); Task 7's fields.
- Produces: `BridgeHooks.onStats?(stats: AiCallTurnStats): void` — called once, just before `onEnd`.

Rules: silence check-ins only in gate mode. Arm when the agent has spoken at least once, isn't closing, the caller isn't talking, no response is pending/active, no tools run, nothing is playing, and no late answer is pending — after playback drains (Task 7's `onAgentFinished`) and after a quiet (`wait_for_user`) batch. 8 s normally, 30 s while `holding`. Cancel on `speech_started`-heard, `response.created`, `requestResponse`, closing, `silence()`, `finish()`. On fire: system note `[no answer for N s]`, `silenceNoteItem(N)`, `requestResponse()`, count it. Stats (both modes): `speech_stopped` with `audio_end_ms` records `callerStopped(sentAudioMs − audio_end_ms, now)` unless that item is the overlap being judged; the first audio of each response records `agentAudio(now)`; an ignored listening sound counts `listeningSound()`; an interruption counts `interruption()`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('silence check-ins (gate mode)', () => {
  const doneEmpty = { type: 'response.done', response: { status: 'completed', output: [] } };
  const note = (seconds: number) => ({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(No one has said anything for ${seconds} seconds.)` }] },
  });

  /** The agent opened the call (OPENER_DELAY_MS of silence), said its line, and it played out. */
  async function quietAfterAgent(over: Partial<BridgeOptions> = { bargeIn: 'gate' }) {
    const s = setup(over);
    s.bridge.start();
    s.openai.msg(READY);
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS);
    s.openai.msg({ type: 'response.created' });
    s.openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(100) });
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(doneEmpty);
    const name = (s.twilio.sent.find((m) => m.event === 'mark') as { mark: { name: string } }).mark.name;
    s.twilio.msg({ event: 'mark', streamSid: SID, mark: { name } });
    s.openai.clearSent();
    return s;
  }

  it('checks in after 8 s of silence, at most twice until the caller speaks', async () => {
    const { openai, hooks } = await quietAfterAgent();
    await vi.advanceTimersByTimeAsync(7999);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([note(8), { type: 'response.create' }]);
    expect(hooks.onTranscript).toHaveBeenCalledWith(expect.objectContaining({ role: 'system', text: '[no answer for 8 s]' }));
    // the check-in plays, then silence again → second note; then no third
    for (let i = 0; i < 2; i += 1) {
      openai.msg({ type: 'response.created' });
      openai.msg(doneEmpty);
      await vi.advanceTimersByTimeAsync(8000);
    }
    expect(openai.sent.filter((m) => m.type === 'conversation.item.create')).toHaveLength(2);
  });

  it('caller speech cancels the timer', async () => {
    const { openai } = await quietAfterAgent();
    await vi.advanceTimersByTimeAsync(5000);
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openai.sent).toEqual([]);
  });

  it('waits 30 s after wait_for_user', async () => {
    const { openai } = await quietAfterAgent();
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('wait_for_user', '{}', 'w1')] } });
    await flush();
    openai.clearSent();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([note(30), { type: 'response.create' }]);
  });

  it('never checks in in instant mode', async () => {
    const { openai } = await quietAfterAgent({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(openai.sent.filter((m) => m.type === 'conversation.item.create')).toEqual([]);
  });
});

describe('turn stats', () => {
  it('reports endpoint + answer time per answered turn, once, before onEnd', async () => {
    const { twilio, openai, bridge, hooks } = setup({ bargeIn: 'gate' });
    const onStats = vi.fn();
    (hooks as BridgeHooks).onStats = onStats;
    bridge.start();
    openai.msg(READY);
    for (let ts = 20; ts <= 3000; ts += 20) twilio.msg(media(ts, audio(20))); // 3000 ms of caller audio sent
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 1000 });
    openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 1800 }); // endpoint 1200
    openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' });
    await vi.advanceTimersByTimeAsync(700); // answer 700
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(100) });
    bridge.stop();
    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats.mock.calls[0]?.[0]).toMatchObject({
      v: 1, bargeIn: 'gate', turns: 1, totalMs: { p50: 1900, p90: 1900, max: 1900 },
      endpointMs: { p50: 1200 }, answerMs: { p50: 700 },
    });
    expect(onStats.mock.invocationCallOrder[0]).toBeLessThan(hooks.onEnd.mock.invocationCallOrder[0] as number);
  });
});
```

Note: `setup()`'s `hooks` object is the one passed to the bridge, so assigning `onStats` before `start()` works because the bridge reads `this.hooks.onStats` at end time. If `setup()` freezes or copies hooks, add an `onStats` option to `setup()` instead.

Run → FAIL.

- [ ] **Step 2: Implement**

Imports:

```ts
import type { AiCallTurnStats } from '@cti/contracts';
import { HOLD_CHECK_MS, SILENCE_CHECK_MS, SilenceCheck, silenceNoteItem } from './bridge-silence.js';
import { TurnStatsCollector } from './bridge-turn-stats.js';
```

`BridgeHooks` gains:

```ts
  /** Once, just before onEnd: this call's turn-taking numbers (spec 2026-10-09 §4.3). */
  onStats?(stats: AiCallTurnStats): void;
```

Fields and constructor:

```ts
  private readonly silenceCheck: SilenceCheck;
  private readonly stats: TurnStatsCollector;
  // constructor, after this.gate = …
    this.silenceCheck = new SilenceCheck({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onSilence: (seconds) => this.onSilence(seconds),
    });
    this.stats = new TurnStatsCollector(this.bargeIn);
```

Wire-ups:
- `onCallerSpeech`: right after `this.cancelOpener();` add `this.silenceCheck.heard();`.
- `speech_stopped` case: `return this.onCallerStopped(str(msg.item_id), Number(msg.audio_end_ms));` and:

```ts
  private onCallerStopped(itemId: string, audioEndMs: number): void {
    this.callerTalking = false;
    if (this.gate.itemId === itemId || !Number.isFinite(audioEndMs)) return; // an overlap is not a turn (yet)
    this.stats.callerStopped(this.sentAudioMs - audioEndMs, this.now());
  }
```

- `response.created` case: add `this.silenceCheck.cancel();`.
- `requestResponse`: before `this.responsePending = true;` add `this.silenceCheck.cancel();`.
- `onAgentAudio`, inside the `if (!this.responseHasAudio)` block: add `this.stats.agentAudio(this.now());`.
- `interruptAgent`: add `this.stats.interruption();`.
- `onCallerFinal`: replace the final `if (end !== 'answer') return;` with:

```ts
    if (end !== 'answer') {
      this.stats.listeningSound();
      return;
    }
```

- `onAgentFinished`:

```ts
  private onAgentFinished(): void {
    if (this.ended || this.closing) return;
    if (this.answerAfterPlayback) {
      this.answerAfterPlayback = false;
      return this.requestResponse();
    }
    this.armSilenceCheck();
  }
```

- `afterResponse`:

```ts
  private afterResponse(): void {
    if (this.wantResponse) return this.requestResponse();
    if (!this.playback.playing) this.armSilenceCheck();
  }
```

- New:

```ts
  /** Gate mode: the agent is waiting for the caller — time the silence. */
  private armSilenceCheck(): void {
    if (this.bargeIn !== 'gate' || this.ended || this.closing || !this.agentSpoke || this.callerTalking) return;
    if (this.responsePending || this.responseActive || this.toolsRunning || this.playback.playing || this.answerAfterPlayback) return;
    this.silenceCheck.arm(this.holding ? HOLD_CHECK_MS : SILENCE_CHECK_MS);
  }

  private onSilence(seconds: number): void {
    if (this.ended || this.closing || this.callerTalking || this.agentSpeaking()) return;
    this.stats.silenceCheck();
    this.note(`[no answer for ${seconds} s]`);
    this.sendOpenAi(silenceNoteItem(seconds));
    this.requestResponse();
  }
```

- `closeConversation`, `silence()`, `finish()`: add `this.silenceCheck.cancel();` next to `this.gate.close();`.
- `finish()`: before `this.guard('onEnd', …)`, add `this.guard('onStats', () => this.hooks.onStats?.(this.stats.summary()));`.

- [ ] **Step 3: Run** `bridge.test.ts` (all), `npm run typecheck -w services/cti-api` → PASS. Check `bridge.ts` stays under 800 lines (`wc -l`).

- [ ] **Step 4: Commit**

```bash
git add services/cti-api/src/ai-voice/bridge.ts services/cti-api/src/ai-voice/bridge.test.ts
git commit -m "feat(ai-voice): check in after silence, and measure response time per turn"
```

---

### Task 9: Save turn stats on the call

**Files:**
- Create: `packages/db/migrations/0059_ai_call_turn_stats.sql`
- Modify: `packages/db/src/schema.ts` (`aiCalls`: `turnStats: jsonb('turn_stats')`)
- Modify: `services/cti-api/src/ai-voice/stream-session.ts` (`onStats` hook → log + `store.update`)
- Test: a migration test following the pattern of the newest existing one (look at `packages/db/src/migration-0050.test.ts` and any `migration-0058*` test), `services/cti-api/src/ai-voice/stream-session.test.ts`

**Interfaces:**
- Consumes: `BridgeHooks.onStats` (Task 8); `AiCallStore.update(id, patch)` (exists — confirm its patch type accepts `turnStats` once the schema has it; if `update` takes a hand-written patch type, add `turnStats?: AiCallTurnStats | null` to it).
- Produces: column `ai_calls.turn_stats jsonb NULL`.

- [ ] **Step 1: Migration test first** (mirror the existing migration tests' style: they typically read the SQL file and assert statements, and/or run it in the pg lane). Minimum assertion:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('0059_ai_call_turn_stats', () => {
  const sql = readFileSync(new URL('../migrations/0059_ai_call_turn_stats.sql', import.meta.url), 'utf8');
  it('adds a nullable jsonb turn_stats column, idempotently, with a lock timeout', () => {
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(sql).toMatch(/ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "turn_stats" jsonb;/);
    expect(sql).not.toMatch(/NOT NULL|DEFAULT/);
  });
});
```

(Adjust the path to wherever existing migration tests resolve the migrations folder.)

- [ ] **Step 2: Write the migration**

```sql
-- =============================================================================
-- 0059_ai_call_turn_stats.sql — per-call turn-taking numbers from the AI voice
-- bridge (spec docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.3):
--   { v, bargeIn, turns, totalMs{p50,p90,max}, endpointMs{p50}, answerMs{p50},
--     interruptions, listening, silenceChecks }   (contracts: AiCallTurnStats)
-- NULL for calls before this shipped. A nullable ADD COLUMN with no default does
-- not rewrite the table.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "turn_stats" jsonb;
```

If the repo keeps a migrations journal/manifest (look for how 0058 was registered — e.g. a `meta/_journal.json`, a list in `migrate-runner`, or a test that counts migrations), register 0059 the same way.

- [ ] **Step 3: Schema** — in `packages/db/src/schema.ts` `aiCalls` table add `turnStats: jsonb('turn_stats'),` next to `transcript`. `npm run build:packages`.

- [ ] **Step 4: stream-session test first** — in `stream-session.test.ts`, find how the test captures the hooks passed to `createBridge`; add:

```ts
  it('logs turn stats and saves them on the call', async () => {
    // arrange as the neighbouring tests do, capture `hooks` from createBridge
    const stats = { v: 1, bargeIn: 'gate', turns: 2, totalMs: { p50: 1500, p90: 2000, max: 2000 }, endpointMs: { p50: 900 }, answerMs: { p50: 600 }, interruptions: 0, listening: 1, silenceChecks: 0 } as const;
    hooks.onStats?.(stats);
    await flush();
    expect(store.update).toHaveBeenCalledWith(AI_CALL_ID, { turnStats: stats });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ aiCallId: AI_CALL_ID, turnStats: stats }), 'ai-voice: turn stats');
  });
```

(Use the file's real names for the store mock, logger, call id and flush helper.) Run → FAIL.

- [ ] **Step 5: Implement** — in `stream-session.ts`, in the hooks object next to `onTranscript`:

```ts
    onStats: (stats) => saveTurnStats(entry.aiCallId, stats, deps),
```

and below `onBridgeEnd`:

```ts
/** The call's turn-taking numbers: one log line and the `turn_stats` column (best effort). */
function saveTurnStats(aiCallId: string, stats: AiCallTurnStats, deps: StreamSessionDeps): void {
  deps.log.info({ aiCallId, turnStats: stats }, 'ai-voice: turn stats');
  void deps.store
    .update(aiCallId, { turnStats: stats })
    .catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: turn stats not saved'));
}
```

(`import type { AiCallTurnStats } from '@cti/contracts';`)

- [ ] **Step 6: Run** db tests, `stream-session.test.ts`, `store*.test.ts`, typecheck cti-api and db → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0059_ai_call_turn_stats.sql packages/db/src/schema.ts services/cti-api/src/ai-voice/stream-session.ts services/cti-api/src/ai-voice/stream-session.test.ts
# plus the migration test file and any journal/store type you changed
git commit -m "feat(ai-voice): save each call's turn stats (migration 0059)"
```

---

### Task 10: Prompt — interruptions, listening sounds, silence notes, wait_for_user

**Files:**
- Modify: `services/cti-api/src/ai-voice/prompt.ts`
- Modify: `services/cti-api/src/ai-voice/__snapshots__/prompt-first-call.txt` (regenerated)
- Test: `services/cti-api/src/ai-voice/prompt.test.ts`

- [ ] **Step 1: Write the failing tests** (in `prompt.test.ts`, using its existing builder for a default `PromptInput`)

```ts
describe('natural turn-taking rules (2026-10-09)', () => {
  const text = buildInstructions(baseInput()); // use the file's existing default-input helper

  it('tells the agent how to handle being cut off and listening sounds', () => {
    expect(text).toContain("If you get cut off, don't repeat what you already said");
    expect(text).toContain('as their whole reply means yes or okay to what you just asked');
    expect(text).toContain('For simple confirmations, answer right away.');
  });

  it('replaces the long-silence rule with silence notes and wait_for_user', () => {
    expect(text).not.toContain("If there's a long silence after your question");
    expect(text).toContain('(No one has said anything for 8 seconds.)');
    expect(text).toContain('Sure, take your time.');
    expect(text).toContain('- wait_for_user —');
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement** in `prompt.ts`:

`PERSONALITY` — append three bullets at the end of the section (keep the existing ones):

```
- If you get cut off, don't repeat what you already said — respond to what they said, and pick your point back up only if it still matters.
- A short "mm-hmm", "yeah" or "okay" as their whole reply means yes or okay to what you just asked — carry on.
- For simple confirmations, answer right away.
```

`UNCLEAR_AUDIO` — replace the line `- Background noise, a TV, or a side conversation isn't meant for you — ignore it.` and the long-silence line with:

```
- Background noise, a TV, or a side conversation isn't meant for you — call wait_for_user and say nothing.
- If they ask you to hold on ("hang on a sec", "let me grab my husband"): "Sure, take your time." → wait_for_user.
- You may get a note like "(No one has said anything for 8 seconds.)" — it isn't them talking. The first time, check in once, briefly: "Hey — are you still there?" If you get another note, say a quick goodbye → end_call (outcome "hung_up").
```

`toolsSection` — add before the `end_call` line:

```
- wait_for_user — when what you heard wasn't meant for you (a TV, someone else in the room, noise): call it silently and say nothing. When they ask you to hold on: preamble "Sure, take your time." After calling it, say nothing more until they speak.
```

- [ ] **Step 3: Regenerate the snapshot and review the diff**

Run: `npx vitest run --root services/cti-api src/ai-voice/prompt.test.ts -u`
Then `git diff services/cti-api/src/ai-voice/__snapshots__/prompt-first-call.txt` — the diff must contain exactly the lines above (3 + 3 + 1 added, 2 removed) and nothing else. Run the prompt tests again without `-u` → PASS.

- [ ] **Step 4: Commit**

```bash
git add services/cti-api/src/ai-voice/prompt.ts services/cti-api/src/ai-voice/prompt.test.ts services/cti-api/src/ai-voice/__snapshots__/prompt-first-call.txt
git commit -m "feat(ai-voice): prompt covers being cut off, listening sounds, silence notes and wait_for_user"
```

---

### Task 11: Show turn stats above every transcript

**Files:**
- Modify: `services/outreach-api/src/ai-calls/results-query.ts` (`loadTranscript`, `loadPracticeTranscript`: select `a.turn_stats`, return `turnStats`)
- Test: the outreach-api test that covers these queries (search `loadTranscript` in `services/outreach-api/src/**/*.test.ts`)
- Modify: `apps/outreach-web/src/lib/call-words.ts` (`turnStatsWords`)
- Modify: `apps/outreach-web/src/components/ai-call-transcript.tsx` (render the line)
- Test: `apps/outreach-web/src/lib/call-words.test.ts` (create if missing), `apps/outreach-web/src/components/ai-call-transcript.test.tsx` (create if missing, following neighbouring component tests)

**Interfaces:**
- Consumes: `AiCallTurnStats`, `AiCallTranscript.turnStats` (Task 3).
- Produces: `turnStatsWords(stats: AiCallTurnStats | null): string | null`; `parseTurnStats(raw: unknown): AiCallTurnStats | null` (results-query.ts).

- [ ] **Step 1: outreach-api test first** — extend the existing transcript-query test: a row with `turn_stats` = a valid stats object returns it as `turnStats`; a row with `turn_stats` = `null` or `{"v":9}` returns `turnStats: null`. Run → FAIL.

- [ ] **Step 2: Implement** in `results-query.ts`:

```ts
/** `ai_calls.turn_stats`, if it is a stats object this version understands. */
export function parseTurnStats(raw: unknown): AiCallTurnStats | null {
  const parsed = AiCallTurnStats.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
```

Add `a.turn_stats` to both `select` lists, widen the row types with `turn_stats: unknown`, and return `{ aiCallId, lines: transcriptLines(row.transcript), turnStats: parseTurnStats(row.turn_stats) }` (replacing Task 3's `turnStats: null`). Run → PASS.

- [ ] **Step 3: Web words test first** (`call-words.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { turnStatsWords } from './call-words';

const base = { v: 1, bargeIn: 'gate', turns: 4, totalMs: { p50: 1900, p90: 2600, max: 3100 }, endpointMs: { p50: 1100 }, answerMs: { p50: 800 }, interruptions: 1, listening: 4, silenceChecks: 0 } as const;

describe('turnStatsWords', () => {
  it('summarises response time and what the agent did', () => {
    expect(turnStatsWords(base)).toBe('Response time: usually 1.9 s (slowest 3.1 s) · kept talking through 4 "mm-hmm"s · stopped for 1 interruption');
  });
  it('handles singulars, silence check-ins and no answered turns', () => {
    expect(turnStatsWords({ ...base, totalMs: null, endpointMs: null, answerMs: null, turns: 0, listening: 1, interruptions: 2, silenceChecks: 1 }))
      .toBe('Kept talking through 1 "mm-hmm" · stopped for 2 interruptions · checked in after silence once');
    expect(turnStatsWords({ ...base, silenceChecks: 2, listening: 0, interruptions: 0 })).toBe('Response time: usually 1.9 s (slowest 3.1 s) · checked in after silence 2 times');
  });
  it('says nothing for old calls or empty stats', () => {
    expect(turnStatsWords(null)).toBeNull();
    expect(turnStatsWords({ ...base, turns: 0, totalMs: null, endpointMs: null, answerMs: null, interruptions: 0, listening: 0 })).toBeNull();
  });
});
```

(Import path style: match the other `call-words` imports — the app uses the `@/` alias in components; a sibling test can use `./call-words`.) Run → FAIL.

- [ ] **Step 4: Implement** in `call-words.ts`:

```ts
import type { AiCallTurnStats } from '@cti/contracts';

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One line above a call transcript: how fast the AI answered and how it handled overlaps (spec 2026-10-09 §4.3). */
export function turnStatsWords(stats: AiCallTurnStats | null): string | null {
  if (stats === null) return null;
  const parts = [
    stats.totalMs ? `response time: usually ${seconds(stats.totalMs.p50)} (slowest ${seconds(stats.totalMs.max)})` : null,
    stats.listening > 0 ? `kept talking through ${count(stats.listening, '"mm-hmm"', '"mm-hmm"s')}` : null,
    stats.interruptions > 0 ? `stopped for ${count(stats.interruptions, 'interruption', 'interruptions')}` : null,
    stats.silenceChecks > 0 ? `checked in after silence ${stats.silenceChecks === 1 ? 'once' : `${stats.silenceChecks} times`}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}
```

- [ ] **Step 5: Component test first** (`ai-call-transcript.test.tsx`, following the setup of a neighbouring component test that mocks `@/lib/outreach-api` and renders with a `QueryClientProvider`): with `getAiCallTranscript` resolving `{ aiCallId, lines: [{ role: 'agent', text: 'Hi', at: null }], turnStats: base }`, the panel shows the `turnStatsWords(base)` text; with `turnStats: null` it does not. Run → FAIL.

- [ ] **Step 6: Implement** in `ai-call-transcript.tsx`: compute `const statsLine = turnStatsWords(transcript.data.turnStats);` after the error/pending checks; wrap the return so that, when `statsLine` is non-null, a `<p className="text-xs text-muted-foreground">{statsLine}</p>` renders directly above the `<ol>` (inside a `<div className="space-y-2">`). Leave the "No transcript was recorded" branch unchanged. Check `record-test-calls.tsx` and `practice-calls.tsx`: if they render transcripts through `AiCallTranscriptPanel`, nothing else is needed; if either renders lines itself, render `turnStatsWords(...)` there the same way.

- [ ] **Step 7: Run** outreach-api tests + typecheck, outreach-web tests + typecheck → PASS.

- [ ] **Step 8: Commit**

```bash
git add services/outreach-api/src/ai-calls/results-query.ts apps/outreach-web/src/lib/call-words.ts apps/outreach-web/src/components/ai-call-transcript.tsx
# plus the test files you added/changed, listed explicitly
git commit -m "feat(outreach-web): each call transcript shows response time and how the AI handled interruptions"
```

---

### Task 12: Runbook and full verification

**Files:**
- Modify: `docs/runbooks/ai-voice.md`

- [ ] **Step 1: Add a section** "Natural turn-taking (2026-10-09)" to `docs/runbooks/ai-voice.md`:

```markdown
## Natural turn-taking (2026-10-09)

Spec: `docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md`.

- **What changed.** The agent keeps talking through "mm-hmm", "yeah", "okay", coughs and noise, and stops for a real interruption ("wait", "hold on", "no", or two real words) about a second in. It never cuts its own opener (the AI disclosure). After 8 s of silence it checks in once ("are you still there?"), then says goodbye. It stays quiet for a TV or side conversation (`wait_for_user`) and gives people 30 s when they ask it to hold on.
- **Settings (@cti/api).** `AI_VOICE_BARGE_IN` = `gate` (default) or `instant` (the old behaviour: stop on any sound, no silence check-ins). `AI_VOICE_TRANSCRIBE_MODEL` = `gpt-live-transcribe` (default; streams words while the caller talks — the gate needs that). `AI_VOICE_VAD_EAGERNESS` (`auto`) still sets how long the agent waits to be sure the caller finished.
- **Rollback.** Set `AI_VOICE_BARGE_IN=instant` on @cti/api (Railway variables) and redeploy; to also restore the old transcriber, set `AI_VOICE_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`.
- **Numbers.** Every call saves `ai_calls.turn_stats` and logs `ai-voice: turn stats`; outreach-web shows one line above each transcript ("Response time: usually 1.9 s (slowest 3.1 s) · kept talking through 4 "mm-hmm"s · stopped for 1 interruption"). Response time = how long after the caller stopped until our server sent the first agent audio; Twilio playout (~0.1–0.2 s) is extra.
- **Owner check after deploy.** Test a record → Talk in browser: (1) say "mm-hmm" while it talks — it keeps going; (2) say "wait, hold on" — it stops and answers you; (3) say "hello" over its first line — it finishes the disclosure; (4) go quiet — after ~8 s it checks in once, then says goodbye; (5) say "hang on a sec" — "Sure, take your time", then quiet for 30 s. Read the response-time line above the transcript.
```

- [ ] **Step 2: Full verification** from the worktree root:

```bash
npm run build:packages
npm test -w packages/contracts
npm test -w packages/db
npm test -w services/cti-api
npm run typecheck -w services/cti-api
npm test -w services/outreach-api
npm run typecheck -w services/outreach-api
npm test -w apps/outreach-web
npm run typecheck -w apps/outreach-web
```

All must pass. (Use the real script names from each `package.json`.)

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/ai-voice.md
git commit -m "docs(runbooks): AI voice natural turn-taking — settings, rollback, owner check"
```
