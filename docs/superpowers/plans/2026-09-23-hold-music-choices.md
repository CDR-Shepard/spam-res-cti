# Hold Music Choices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each rep chooses what they hear between Power Dial calls — Off, one of six Twilio music sets played through the phone line, or their own YouTube playlist in a small player that pauses the instant someone is connected.

**Architecture:** One shared definition (`@cti/contracts` `hold-music.ts`: the eight choices, labels, YouTube link parsing) used by API and softphone. The API stores the rep's choice (migration 0043) and turns it into the rep leg's conference `waitUrl` on join and on every rejoin. The softphone gets a Settings picker, a tiny "line audio" signal fed by the dialer leg's volume events, pure play/pause rules, and a `YouTubeHoldPlayer` mounted under the current-record card during a live run.

**Tech Stack:** TypeScript; Fastify + Drizzle (Postgres) + zod; Twilio TwiML (`twilio` node lib); React 18 + Vite; vitest (+ @testing-library/react, jsdom); YouTube IFrame Player API.

**Executes AFTER** `docs/superpowers/plans/2026-09-23-dialer-cadence-and-controls.md` (both touch `DialerPanel.tsx`; this plan relies on that plan's `DialerCurrentItem.prospectEndedAt`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-23-hold-music-choices-design.md`.
- Choices (exact, in this order): `off, classical, ambient, electronica, guitars, rock, softrock, youtube`. Labels: Off, Classical, Ambient, Electronica, Guitars, Rock, Soft rock, YouTube. Default `classical`.
- Rep-leg `waitUrl`: `classical` → attribute omitted (Twilio's default = today's TwiML); `off` and `youtube` → `waitUrl=""`; the other five → `https://twimlets.com/holdmusic?Bucket=com.twilio.music.<choice>`. The prospect leg never carries `waitUrl`.
- A lookup of the rep's choice that fails, times out, or finds an unknown value → `classical`.
- YouTube link error sentence (exact): `That doesn't look like a YouTube link.` Store ids only, never a URL. Video id `^[A-Za-z0-9_-]{11}$`; playlist id `^[A-Za-z0-9_-]{10,64}$`.
- Legacy `dialerHoldMusic` boolean (PATCH + GET) keeps working one release: `false` → `off`; `true` → `classical` only when the current choice is `off`; GET `dialerHoldMusic = choice !== 'off'`. The `dialer_hold_music` column is kept in step (`choice !== 'off'`).
- Player: YouTube's own player, host `https://www.youtube-nocookie.com`, height `200` px, width `100%`, API script `https://www.youtube.com/iframe_api`. Loud = `outputVolume ≥ 0.02` on `2` consecutive samples; resume needs the line quiet `≥ 1500 ms`; "stuck" after `2000 ms` without PLAYING.
- Captions (exact): `Pauses automatically when someone answers.` · `Press play once — after that it pauses and resumes by itself.` · `Press play to resume` · `Couldn't load your YouTube playlist`
- Work in `/Users/cdrshepard/spam-res-cti/.claude/worktrees/callsign-main` on `main`; harness worktrees: `git merge --ff-only main` FIRST, then `npm install --no-audit --no-fund --prefer-offline` and `for p in auth contracts db firewall phone; do (cd packages/$p && npm run build); done`.
- TDD (red first). Rendered TwiML pinned exactly. Never `git stash`, never push, never deploy, never touch production.
- Commits: conventional, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Style: WHY comments, pure functions exported for tests, immutable updates, no `any` outside tests, no `console.log`.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/hold-music.ts` (new) | choices, labels, `toHoldMusicChoice`, `parseYouTubeLink`, `youtubeLinkFor`, shared types |
| `Dockerfile`, `apps/cti-web/package.json`, `services/cti-api/package.json` | depend on `@cti/contracts`; build packages before the web bundle |
| `packages/db/migrations/0043_hold_music_choice.sql`, `packages/db/src/schema.ts` | the three `users` columns + CHECK |
| `services/cti-api/src/dialer/twilio-telephony.ts` | `waitUrlFor`, `ConferenceOptions.holdMusic: HoldMusicChoice` |
| `services/cti-api/src/routes/telephony.ts` | `repHoldMusicChoice` for join + rejoin |
| `services/cti-api/src/routes/auth.ts` | GET/PATCH `/auth/me` hold-music fields |
| `apps/cti-web/src/components/SettingsPanel.tsx` | the picker + YouTube link box |
| `apps/cti-web/src/line-audio.ts` (new) | the line-audio signal fed by the dialer leg's `'volume'` events |
| `apps/cti-web/src/hold-music-rules.ts` (new) | `heardSomeone`, `shouldPlay` |
| `apps/cti-web/src/youtube-api.ts` (new) | IFrame API loader + `playerOptionsFor` |
| `apps/cti-web/src/components/YouTubeHoldPlayer.tsx` (new) | the player component |
| `apps/cti-web/src/App.tsx`, `components/DialerPanel.tsx`, `styles.css` | wiring + mount + style |
| `docs/runbooks/hold-music.md` (new) | runbook + rep-guide paragraph |

---

### Task 1: Shared hold-music definitions (`@cti/contracts`) and the build order

**Files:**
- Create: `packages/contracts/src/hold-music.ts`, `packages/contracts/src/hold-music.test.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from './hold-music.js';`)
- Modify: `apps/cti-web/package.json`, `services/cti-api/package.json` (dependency `"@cti/contracts": "*"`), `package-lock.json` (via `npm install`)
- Modify: `Dockerfile` (build line)

**Interfaces — Produces:**
```ts
export const HOLD_MUSIC_CHOICES: readonly ['off','classical','ambient','electronica','guitars','rock','softrock','youtube'];
export type HoldMusicChoice = (typeof HOLD_MUSIC_CHOICES)[number];
export const HOLD_MUSIC_LABELS: Readonly<Record<HoldMusicChoice, string>>;
export const DEFAULT_HOLD_MUSIC: HoldMusicChoice; // 'classical'
export function isHoldMusicChoice(v: unknown): v is HoldMusicChoice;
export function toHoldMusicChoice(v: unknown): HoldMusicChoice;         // anything invalid → 'classical'
export interface YouTubeRef { listId: string | null; videoId: string | null }
export interface HoldMusicSetting { choice: HoldMusicChoice; youtube: YouTubeRef | null }
export const YOUTUBE_LINK_ERROR: string;                               // "That doesn't look like a YouTube link."
export function parseYouTubeLink(input: string): YouTubeRef | null;
export function youtubeLinkFor(ref: YouTubeRef): string | null;
```

- [ ] **Step 1: Failing tests** (`hold-music.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOLD_MUSIC, HOLD_MUSIC_CHOICES, HOLD_MUSIC_LABELS, isHoldMusicChoice, parseYouTubeLink,
  toHoldMusicChoice, YOUTUBE_LINK_ERROR, youtubeLinkFor,
} from './hold-music.js';

const V = 'dQw4w9WgXcQ';
const L = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

describe('hold-music choices', () => {
  it('eight choices in picker order, with labels, default Classical', () => {
    expect(HOLD_MUSIC_CHOICES).toEqual(['off', 'classical', 'ambient', 'electronica', 'guitars', 'rock', 'softrock', 'youtube']);
    expect(HOLD_MUSIC_LABELS.softrock).toBe('Soft rock');
    expect(HOLD_MUSIC_LABELS.youtube).toBe('YouTube');
    expect(DEFAULT_HOLD_MUSIC).toBe('classical');
  });
  it('toHoldMusicChoice: valid passes, anything else is Classical (never keep a rep out of their music)', () => {
    expect(toHoldMusicChoice('rock')).toBe('rock');
    for (const bad of ['jazz', '', null, undefined, 3, 'Rock']) expect(toHoldMusicChoice(bad)).toBe('classical');
    expect(isHoldMusicChoice('softrock')).toBe(true);
    expect(isHoldMusicChoice('soft rock')).toBe(false);
  });
  it('the error sentence is exact', () => { expect(YOUTUBE_LINK_ERROR).toBe("That doesn't look like a YouTube link."); });
});

describe('parseYouTubeLink', () => {
  it.each([
    [`https://www.youtube.com/playlist?list=${L}`, { listId: L, videoId: null }],
    [`https://youtube.com/watch?v=${V}`, { listId: null, videoId: V }],
    [`https://www.youtube.com/watch?v=${V}&list=${L}&index=3`, { listId: L, videoId: V }],
    [`https://youtu.be/${V}`, { listId: null, videoId: V }],
    [`https://youtu.be/${V}?list=${L}`, { listId: L, videoId: V }],
    [`https://m.youtube.com/watch?v=${V}`, { listId: null, videoId: V }],
    [`https://music.youtube.com/playlist?list=${L}`, { listId: L, videoId: null }],
    [`youtube.com/playlist?list=${L}`, { listId: L, videoId: null }],
    [`  https://www.youtube.com/watch?v=${V}  `, { listId: null, videoId: V }],
  ])('accepts %s', (input, expected) => { expect(parseYouTubeLink(input)).toEqual(expected); });

  it.each([
    '', 'not a link', 'https://vimeo.com/123', `https://youtube.com.evil.com/watch?v=${V}`,
    `javascript:alert(1)//youtube.com/watch?v=${V}`, 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/playlist?list=bad!chars', 'https://www.youtube.com/playlist',
    `ftp://youtube.com/watch?v=${V}`, 'https://www.youtube.com/',
  ])('rejects %s', (input) => { expect(parseYouTubeLink(input)).toBeNull(); });
});

describe('youtubeLinkFor — the canonical link for a stored ref (Settings prefill)', () => {
  it('playlist, video, video-in-playlist, nothing', () => {
    expect(youtubeLinkFor({ listId: L, videoId: null })).toBe(`https://www.youtube.com/playlist?list=${L}`);
    expect(youtubeLinkFor({ listId: null, videoId: V })).toBe(`https://www.youtube.com/watch?v=${V}`);
    expect(youtubeLinkFor({ listId: L, videoId: V })).toBe(`https://www.youtube.com/watch?v=${V}&list=${L}`);
    expect(youtubeLinkFor({ listId: null, videoId: null })).toBeNull();
  });
  it('round-trips through parseYouTubeLink', () => {
    for (const ref of [{ listId: L, videoId: null }, { listId: null, videoId: V }, { listId: L, videoId: V }]) {
      expect(parseYouTubeLink(youtubeLinkFor(ref)!)).toEqual(ref);
    }
  });
});
```

- [ ] **Step 2: Run** — `cd packages/contracts && npx vitest run src/hold-music.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`hold-music.ts`):

```ts
/**
 * Hold music during a Power Dial run — the one definition the API (which turns
 * a choice into the rep leg's conference waitUrl) and the softphone (Settings
 * picker, YouTube player) share. Six choices are Twilio's royalty-free sets and
 * play through the phone line; `youtube` plays in the rep's browser instead,
 * because YouTube's audio may not be separated from its own player.
 */
export const HOLD_MUSIC_CHOICES = ['off', 'classical', 'ambient', 'electronica', 'guitars', 'rock', 'softrock', 'youtube'] as const;
export type HoldMusicChoice = (typeof HOLD_MUSIC_CHOICES)[number];

export const HOLD_MUSIC_LABELS: Readonly<Record<HoldMusicChoice, string>> = {
  off: 'Off', classical: 'Classical', ambient: 'Ambient', electronica: 'Electronica',
  guitars: 'Guitars', rock: 'Rock', softrock: 'Soft rock', youtube: 'YouTube',
};

/** Twilio's own default conference music — what every rep heard before choices existed. */
export const DEFAULT_HOLD_MUSIC: HoldMusicChoice = 'classical';

export function isHoldMusicChoice(v: unknown): v is HoldMusicChoice {
  return typeof v === 'string' && (HOLD_MUSIC_CHOICES as readonly string[]).includes(v);
}

/** Anything unreadable is Classical: a bad value must never keep a rep out of their room. */
export function toHoldMusicChoice(v: unknown): HoldMusicChoice {
  return isHoldMusicChoice(v) ? v : DEFAULT_HOLD_MUSIC;
}

export interface YouTubeRef { listId: string | null; videoId: string | null }
export interface HoldMusicSetting { choice: HoldMusicChoice; youtube: YouTubeRef | null }

export const YOUTUBE_LINK_ERROR = "That doesn't look like a YouTube link.";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);

/**
 * A YouTube playlist / video / video-in-playlist link → its ids, or null. Only
 * ids ever leave this function: the link itself is never stored or embedded.
 * A malformed id is a rejection, not something to drop silently.
 */
export function parseYouTubeLink(input: string): YouTubeRef | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const rawVideo = host.endsWith('youtu.be')
    ? url.pathname.split('/')[1] ?? ''
    : url.pathname === '/watch' ? url.searchParams.get('v') ?? '' : '';
  const rawList = url.searchParams.get('list') ?? '';

  if (rawVideo && !VIDEO_ID.test(rawVideo)) return null;
  if (rawList && !LIST_ID.test(rawList)) return null;
  const videoId = rawVideo || null;
  const listId = rawList || null;
  return videoId || listId ? { listId, videoId } : null;
}

/** The canonical link for stored ids (Settings shows it back to the rep). */
export function youtubeLinkFor(ref: YouTubeRef): string | null {
  if (ref.videoId && ref.listId) return `https://www.youtube.com/watch?v=${ref.videoId}&list=${ref.listId}`;
  if (ref.videoId) return `https://www.youtube.com/watch?v=${ref.videoId}`;
  if (ref.listId) return `https://www.youtube.com/playlist?list=${ref.listId}`;
  return null;
}
```

Add `export * from './hold-music.js';` to `packages/contracts/src/index.ts`.

- [ ] **Step 4: Run** — `cd packages/contracts && npx vitest run && npm run build` → PASS.

- [ ] **Step 5: Wire the dependency and the build order.**
  - Add `"@cti/contracts": "*"` to `dependencies` in `apps/cti-web/package.json` and `services/cti-api/package.json`; run `npm install --no-audit --no-fund --prefer-offline` at the root so `package-lock.json` records it.
  - `Dockerfile`: the build line `RUN npm run build:web && npm run build:api` builds the web bundle BEFORE any package is built, so an import of `@cti/contracts` from the web app would find no `dist`. Change it to `RUN npm run build:packages && npm run build:web && npm run build:api` with a one-line comment saying why.
  - Verify from a clean state the same order the image uses: `rm -rf packages/contracts/dist && npm run build:packages && npm run build:web` → succeeds.

- [ ] **Step 6: Commit** — `feat(contracts): hold-music choices and YouTube link parsing, shared by API and softphone` (+ trailer). Include the Dockerfile and package manifests.

---

### Task 2: Migration 0043 and schema

**Files:**
- Create: `packages/db/migrations/0043_hold_music_choice.sql`, `packages/db/src/migration-0043.test.ts`
- Modify: `packages/db/src/schema.ts` (`users`, beside `dialerHoldMusic`)

**Interfaces — Produces:** `users.dialerHoldMusicChoice: text NOT NULL default 'classical'`, `users.dialerYoutubeListId: text | null`, `users.dialerYoutubeVideoId: text | null`.

- [ ] **Step 1: Failing test** (`migration-0043.test.ts`, same idiom as `migration-0042.test.ts`):

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { users } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(here, '../migrations/0043_hold_music_choice.sql'), 'utf8');

describe('0043_hold_music_choice', () => {
  it('adds the choice (default Classical) and the YouTube ids, idempotently', () => {
    expect(sql).toContain("ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_hold_music_choice text NOT NULL DEFAULT 'classical';");
    expect(sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_list_id text;');
    expect(sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_video_id text;');
  });
  it('carries "hold music off" over, and only that', () => {
    expect(sql).toContain("UPDATE users SET dialer_hold_music_choice = 'off' WHERE dialer_hold_music = false AND dialer_hold_music_choice = 'classical';");
  });
  it('refuses any value that is not one of the eight choices', () => {
    expect(sql).toContain("CHECK (dialer_hold_music_choice IN ('off','classical','ambient','electronica','guitars','rock','softrock','youtube'))");
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'users_dialer_hold_music_choice_check'\)/);
  });
  it('the Drizzle schema matches', () => {
    const c = getTableColumns(users);
    expect(c.dialerHoldMusicChoice.name).toBe('dialer_hold_music_choice');
    expect(c.dialerHoldMusicChoice.notNull).toBe(true);
    expect(c.dialerHoldMusicChoice.default).toBe('classical');
    for (const col of [c.dialerYoutubeListId, c.dialerYoutubeVideoId]) { expect(col.notNull).toBe(false); expect(col.hasDefault).toBe(false); }
    expect(c.dialerYoutubeListId.name).toBe('dialer_youtube_list_id');
    expect(c.dialerYoutubeVideoId.name).toBe('dialer_youtube_video_id');
  });
});
```

- [ ] **Step 2: Run** — `cd packages/db && npx vitest run src/migration-0043.test.ts` → FAIL.

- [ ] **Step 3: Migration** (`0043_hold_music_choice.sql`):

```sql
-- =============================================================================
-- 0043_hold_music_choice.sql — what a rep hears between Power Dial calls.
--
-- users.dialer_hold_music_choice   off | classical | ambient | electronica |
--                                  guitars | rock | softrock | youtube.
--                                  Classical is Twilio's default conference
--                                  music — what everyone heard until now — so
--                                  it is the default, and "hold music off"
--                                  carries over as 'off'.
-- users.dialer_youtube_list_id     the rep's YouTube playlist id (ids only —
-- users.dialer_youtube_video_id    a link is never stored).
-- dialer_hold_music (boolean) stays one release for softphone tabs that have
-- not reloaded; the API keeps it in step and a later migration drops it.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_hold_music_choice text NOT NULL DEFAULT 'classical';
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_list_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_video_id text;

UPDATE users SET dialer_hold_music_choice = 'off' WHERE dialer_hold_music = false AND dialer_hold_music_choice = 'classical';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_dialer_hold_music_choice_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_dialer_hold_music_choice_check
      CHECK (dialer_hold_music_choice IN ('off','classical','ambient','electronica','guitars','rock','softrock','youtube'));
  END IF;
END $$;
```

(The table is a few dozen rows; the spec's NOT VALID/VALIDATE split is unnecessary at this size.)

- [ ] **Step 4: Schema** — in `users`, after `dialerHoldMusic`:

```ts
    /** Hold music between Power Dial calls (migration 0043) — one of
     *  `HOLD_MUSIC_CHOICES` in @cti/contracts; read it with `toHoldMusicChoice`. */
    dialerHoldMusicChoice: text('dialer_hold_music_choice').default('classical').notNull(),
    /** The rep's YouTube playlist / video id when the choice is `youtube` (ids only). */
    dialerYoutubeListId: text('dialer_youtube_list_id'),
    dialerYoutubeVideoId: text('dialer_youtube_video_id'),
```

- [ ] **Step 5: Run** — `cd packages/db && npm run build && npx vitest run` → PASS. Then `cd services/cti-api && npx tsc --noEmit -p .` — any test fixture typed as a full `users` row that now misses the new columns must gain them (same fix as 0042's `listViewId`).

- [ ] **Step 6: Commit** — `feat(db): 0043 hold-music choice + YouTube ids, "off" carried over` (+ trailer).

---

### Task 3: The rep leg's waiting music follows the choice (join and rejoin)

**Files:**
- Modify: `services/cti-api/src/dialer/twilio-telephony.ts` (`ConferenceOptions`, `bridgeTwiml`, new `waitUrlFor`)
- Modify: `services/cti-api/src/routes/telephony.ts` (`repHoldMusic` → `repHoldMusicChoice`; both call sites)
- Tests: `services/cti-api/src/dialer/twilio-telephony.test.ts` (the "hold music per rep" block), `services/cti-api/src/routes/telephony-voice-conference.test.ts`

**Interfaces:**
- Consumes: `HoldMusicChoice`, `toHoldMusicChoice`, `DEFAULT_HOLD_MUSIC` from `@cti/contracts`; `users.dialerHoldMusicChoice`.
- Produces: `export function waitUrlFor(choice: HoldMusicChoice): string | undefined`; `ConferenceOptions.holdMusic?: HoldMusicChoice`.

- [ ] **Step 1: Failing tests.** Replace the `describe('hold music per rep', …)` block in `twilio-telephony.test.ts` with:

```ts
describe('hold music per rep — the choice becomes the rep leg\'s waitUrl', () => {
  it('waitUrlFor: Classical omits it, Off/YouTube are silent, the other five are Twilio\'s sets', () => {
    expect(waitUrlFor('classical')).toBeUndefined();
    expect(waitUrlFor('off')).toBe('');
    expect(waitUrlFor('youtube')).toBe('');
    for (const set of ['ambient', 'electronica', 'guitars', 'rock', 'softrock'] as const) {
      expect(waitUrlFor(set)).toBe(`https://twimlets.com/holdmusic?Bucket=com.twilio.music.${set}`);
    }
  });
  it('the rep leg carries it exactly', () => {
    expect(bridgeTwiml('abc123', true, { holdMusic: 'ambient' })).toContain('waitUrl="https://twimlets.com/holdmusic?Bucket=com.twilio.music.ambient"');
    expect(bridgeTwiml('abc123', true, { holdMusic: 'off' })).toContain('waitUrl=""');
    expect(bridgeTwiml('abc123', true, { holdMusic: 'youtube' })).toContain('waitUrl=""');
  });
  it('Classical — and no choice at all — is byte-for-byte today\'s TwiML (no waitUrl attribute)', () => {
    expect(bridgeTwiml('abc123', true, { holdMusic: 'classical' })).toBe(bridgeTwiml('abc123', true));
    expect(bridgeTwiml('abc123', true)).not.toContain('waitUrl');
  });
  it('the prospect leg never waits, so never carries waitUrl', () => {
    expect(bridgeTwiml('abc123', false)).not.toContain('waitUrl');
    expect(bridgeTwiml('abc123', true)).not.toContain('waitUrl');
  });
  it('dialerConferenceTwiml passes the choice through', () => {
    expect(dialerConferenceTwiml('client:rep_abc123', { holdMusic: 'rock' })).toContain('com.twilio.music.rock');
  });
  // keep the existing repUserIdFromClientIdentity test unchanged
});
```

In `telephony-voice-conference.test.ts`: the state's `userRow` becomes `{ dialerHoldMusicChoice: string } | null`, default `{ dialerHoldMusicChoice: 'classical' }`; the join tests become: Classical → no `waitUrl`; `'ambient'` → the ambient twimlet URL; `'off'` → `waitUrl=""`; `'youtube'` → `waitUrl=""`; an unknown stored value `'jazz'` → no `waitUrl` (Classical); a throwing lookup → no `waitUrl`; a missing row → no `waitUrl`; `state.lastFindFirst?.columns` equals `{ dialerHoldMusicChoice: true }` and the where binds the rep's id. The rejoin tests: the rep's choice (e.g. `'guitars'`) carried on the way back in; a HANGING lookup (existing `_setRejoinDbTimeoutForTests(30)` idiom) → Classical (no `waitUrl`).

- [ ] **Step 2: Run** — `cd services/cti-api && npx vitest run src/dialer/twilio-telephony.test.ts src/routes/telephony-voice-conference.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `twilio-telephony.ts`:

```ts
import type { HoldMusicChoice } from '@cti/contracts';

/**
 * The rep leg's conference waitUrl for a hold-music choice. Classical is
 * Twilio's own default, so the attribute is omitted and the TwiML is exactly
 * what every rep got before choices existed. Off and YouTube wait in silence —
 * YouTube plays in the browser instead (YouTubeHoldPlayer). The other five are
 * Twilio's royalty-free sets, served by its holdmusic twimlet.
 */
export function waitUrlFor(choice: HoldMusicChoice): string | undefined {
  if (choice === 'classical') return undefined;
  if (choice === 'off' || choice === 'youtube') return '';
  return `https://twimlets.com/holdmusic?Bucket=com.twilio.music.${choice}`;
}
```

`ConferenceOptions.holdMusic?: HoldMusicChoice` (update its doc comment), and in `bridgeTwiml`:

```ts
  const waitUrl = opts.holdMusic ? waitUrlFor(opts.holdMusic) : undefined;
  // …
      ...(waitUrl !== undefined ? { waitUrl } : {}),
```

`routes/telephony.ts`: replace `repHoldMusic` with

```ts
/**
 * The rep's hold-music choice for their own dialer conference leg (Settings →
 * "Hold music during Power Dial"). A missing row, an unknown value, or a lookup
 * that fails is Classical: a DB hiccup must never keep a rep out of their room.
 */
async function repHoldMusicChoice(from: string): Promise<HoldMusicChoice> {
  const userId = repUserIdFromClientIdentity(from);
  if (!userId) return DEFAULT_HOLD_MUSIC;
  try {
    const row = await getDb().query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { dialerHoldMusicChoice: true },
    });
    return toHoldMusicChoice(row?.dialerHoldMusicChoice);
  } catch {
    return DEFAULT_HOLD_MUSIC;
  }
}
```

Join: `holdMusic: await repHoldMusicChoice(body.From ?? '')`. Rejoin: `holdMusic: await orDefaultAfter(repHoldMusicChoice(from), DEFAULT_HOLD_MUSIC)`.

- [ ] **Step 4: Run** the two test files + `npx vitest run src/dialer src/routes` + `npx tsc --noEmit -p .` → green/clean.
- [ ] **Step 5: Commit** — `feat(dialer): the rep leg waits to the rep's chosen music — six Twilio sets, silence, or YouTube in the browser` (+ trailer).

---

### Task 4: `/auth/me` reads and writes the choice

**Files:**
- Modify: `services/cti-api/src/routes/auth.ts` (`PatchMeBody`, GET and PATCH handlers)
- Tests: `services/cti-api/src/routes/auth.test.ts` (PatchMeBody), `services/cti-api/src/routes/auth-me.test.ts`

**Interfaces:**
- GET `user.holdMusic: HoldMusicSetting` + legacy `user.dialerHoldMusic: boolean`.
- PATCH body `holdMusic?: { choice: HoldMusicChoice; youtubeLink?: string }` (plus the existing optional fields); response stays `{ ok: true, ...patch }`.

- [ ] **Step 1: Failing tests.** `auth.test.ts` (PatchMeBody): accepts `{ holdMusic: { choice: 'ambient' } }` and `{ holdMusic: { choice: 'youtube', youtubeLink: 'https://youtu.be/dQw4w9WgXcQ' } }`; rejects `{ holdMusic: { choice: 'jazz' } }`, `{ holdMusic: {} }`, a `youtubeLink` longer than 500 chars; `{}` still refused.

`auth-me.test.ts`: extend the harness's `userRow` type with `dialerHoldMusicChoice`, `dialerYoutubeListId`, `dialerYoutubeVideoId` (default `'classical'`, null, null). Tests:

```ts
  it('GET returns the choice and the stored YouTube ids, plus the legacy boolean', async () => {
    state.userRow = { ...state.userRow!, dialerHoldMusicChoice: 'youtube', dialerYoutubeListId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', dialerYoutubeVideoId: null };
    const me = (await app.inject({ method: 'GET', url: '/auth/me' })).json();
    expect(me.user.holdMusic).toEqual({ choice: 'youtube', youtube: { listId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', videoId: null } });
    expect(me.user.dialerHoldMusic).toBe(true);
  });
  it('GET: Off → legacy false; no ids → youtube null; an unknown stored value reads as Classical', async () => { /* three rows */ });
  it('PATCH a preset writes the choice and keeps the legacy column in step — nothing else', async () => {
    const res = await patch({ holdMusic: { choice: 'ambient' } });
    expect(res.statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusicChoice: 'ambient', dialerHoldMusic: true });
  });
  it('PATCH Off → legacy false', async () => {
    await patch({ holdMusic: { choice: 'off' } });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusicChoice: 'off', dialerHoldMusic: false });
  });
  it('PATCH YouTube with a valid link stores the ids, never the link', async () => {
    await patch({ holdMusic: { choice: 'youtube', youtubeLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' } });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusicChoice: 'youtube', dialerHoldMusic: true, dialerYoutubeListId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', dialerYoutubeVideoId: 'dQw4w9WgXcQ' });
  });
  it('PATCH YouTube with a bad link → 400 with the exact sentence, nothing written', async () => {
    const res = await patch({ holdMusic: { choice: 'youtube', youtubeLink: 'https://vimeo.com/1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "That doesn't look like a YouTube link." });
    expect(state.lastUpdateSet).toBeNull();
  });
  it('PATCH YouTube with no link: allowed when ids are already stored (switching back), refused when not', async () => {
    state.userRow = { ...state.userRow!, dialerYoutubeListId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' };
    expect((await patch({ holdMusic: { choice: 'youtube' } })).statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusicChoice: 'youtube', dialerHoldMusic: true });
    state.lastUpdateSet = null;
    state.userRow = { ...state.userRow!, dialerYoutubeListId: null, dialerYoutubeVideoId: null };
    expect((await patch({ holdMusic: { choice: 'youtube' } })).statusCode).toBe(400);
    expect(state.lastUpdateSet).toBeNull();
  });
  it('a preset or Off leaves the stored YouTube ids alone', async () => {
    await patch({ holdMusic: { choice: 'rock' } });
    expect(state.lastUpdateSet).not.toHaveProperty('dialerYoutubeListId');
  });
  it('legacy tab: dialerHoldMusic false → Off', async () => {
    await patch({ dialerHoldMusic: false });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusic: false, dialerHoldMusicChoice: 'off' });
  });
  it('legacy tab: dialerHoldMusic true brings Off back to Classical, and never overwrites a chosen preset or YouTube', async () => {
    state.userRow = { ...state.userRow!, dialerHoldMusicChoice: 'off' };
    await patch({ dialerHoldMusic: true });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusic: true, dialerHoldMusicChoice: 'classical' });
    state.userRow = { ...state.userRow!, dialerHoldMusicChoice: 'ambient' };
    await patch({ dialerHoldMusic: true });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusic: true });
  });
```

Update the existing tests that pinned `{ dialerHoldMusic: false }` as the whole patch to the new legacy mapping, and keep the "forwarding-only body never touches hold music" and "hold-music-only body never touches forwarding" assertions.

- [ ] **Step 2: Run** — `cd services/cti-api && npx vitest run src/routes/auth.test.ts src/routes/auth-me.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `PatchMeBody`:

```ts
export const PatchMeBody = z
  .object({
    noAnswerForwardE164: z.string().nullable().optional(),
    /** Legacy (softphone tabs from before hold-music choices): on/off. */
    dialerHoldMusic: z.boolean().optional(),
    holdMusic: z.object({ choice: z.enum(HOLD_MUSIC_CHOICES), youtubeLink: z.string().max(500).optional() }).optional(),
  })
  .refine((b) => b.noAnswerForwardE164 !== undefined || b.dialerHoldMusic !== undefined || b.holdMusic !== undefined, {
    message: 'nothing to update',
  });
```

In the PATCH handler, widen `patch`'s type with `dialerHoldMusicChoice?: HoldMusicChoice; dialerYoutubeListId?: string | null; dialerYoutubeVideoId?: string | null`, and replace the single `dialerHoldMusic` line with:

```ts
    // Hold music. The new picker sends `holdMusic`; a tab from before it sends
    // the legacy boolean, which must never overwrite a preset or YouTube.
    if (parsed.data.holdMusic) {
      const { choice, youtubeLink } = parsed.data.holdMusic;
      if (choice === 'youtube') {
        if (youtubeLink !== undefined) {
          const ref = parseYouTubeLink(youtubeLink);
          if (!ref) return reply.code(400).send({ error: YOUTUBE_LINK_ERROR });
          patch.dialerYoutubeListId = ref.listId;
          patch.dialerYoutubeVideoId = ref.videoId;
        } else {
          const stored = await db.query.users.findFirst({
            where: eq(schema.users.id, session.userId),
            columns: { dialerYoutubeListId: true, dialerYoutubeVideoId: true },
          });
          if (!stored?.dialerYoutubeListId && !stored?.dialerYoutubeVideoId) {
            return reply.code(400).send({ error: YOUTUBE_LINK_ERROR });
          }
        }
      }
      patch.dialerHoldMusicChoice = choice;
      patch.dialerHoldMusic = choice !== 'off';
    } else if (parsed.data.dialerHoldMusic !== undefined) {
      patch.dialerHoldMusic = parsed.data.dialerHoldMusic;
      if (!parsed.data.dialerHoldMusic) {
        patch.dialerHoldMusicChoice = 'off';
      } else {
        const current = await db.query.users.findFirst({
          where: eq(schema.users.id, session.userId),
          columns: { dialerHoldMusicChoice: true },
        });
        // Only Off comes back on as Classical; a preset or YouTube stays put.
        if (current?.dialerHoldMusicChoice === 'off') {
          patch.dialerHoldMusicChoice = DEFAULT_HOLD_MUSIC;
        }
      }
    }
```

The tests assert with `toEqual`, which ignores key order.

GET: add `dialerHoldMusicChoice: true, dialerYoutubeListId: true, dialerYoutubeVideoId: true` to `columns`, and in `user`:

```ts
        // `holdMusic` is the picker's truth; `dialerHoldMusic` keeps tabs from
        // before choices existed showing the right On/Off.
        holdMusic: holdMusicSettingFor(profile),
        dialerHoldMusic: holdMusicSettingFor(profile).choice !== 'off',
```

with a small pure helper in `auth.ts`:

```ts
function holdMusicSettingFor(row: { dialerHoldMusicChoice?: string | null; dialerYoutubeListId?: string | null; dialerYoutubeVideoId?: string | null } | undefined): HoldMusicSetting {
  const listId = row?.dialerYoutubeListId ?? null;
  const videoId = row?.dialerYoutubeVideoId ?? null;
  return { choice: toHoldMusicChoice(row?.dialerHoldMusicChoice), youtube: listId || videoId ? { listId, videoId } : null };
}
```

- [ ] **Step 4: Run** the two files + `npx vitest run src/routes` + `npx tsc --noEmit -p .` → green/clean.
- [ ] **Step 5: Commit** — `feat(auth): /auth/me reads and writes the hold-music choice; the legacy on/off keeps working` (+ trailer).

---

### Task 5: The Settings picker

**Files:**
- Modify: `apps/cti-web/src/components/SettingsPanel.tsx`, `apps/cti-web/src/App.tsx` (the `me.user` type and the `<SettingsPanel holdMusic=…>` prop), `apps/cti-web/src/styles.css` (only if a class is needed)
- Tests: `apps/cti-web/src/components/SettingsPanel.test.tsx` (SSR), new `apps/cti-web/src/components/SettingsPanel.picker.test.tsx` (jsdom)

**Interfaces:**
- `SettingsPanel` prop `holdMusic: HoldMusicSetting` (was `boolean`).
- App: `me.user.holdMusic?: HoldMusicSetting`; passes `me.user.holdMusic ?? { choice: me.user.dialerHoldMusic === false ? 'off' : 'classical', youtube: null }`.

- [ ] **Step 1: Failing tests.** SSR (`SettingsPanel.test.tsx`, replace the switch test):

```tsx
  const setting = (choice: HoldMusicChoice, youtube: YouTubeRef | null = null) => ({ choice, youtube });
  it('a picker with the eight choices, the current one selected', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...props} holdMusic={setting('ambient')} />);
    expect(html).toContain('Hold music during Power Dial');
    for (const label of ['Off', 'Classical', 'Ambient', 'Electronica', 'Guitars', 'Rock', 'Soft rock', 'YouTube']) expect(html).toContain(`>${label}</option>`);
    expect(html).toMatch(/<option value="ambient" selected="">Ambient<\/option>/);
    expect(html).not.toContain('Paste a YouTube');
  });
  it('YouTube chosen: the link box shows the saved playlist and says what it is', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...props} holdMusic={setting('youtube', { listId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', videoId: null })} />);
    expect(html).toContain('YouTube · playlist');
    expect(html).toContain('value="https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"');
  });
```

jsdom (`SettingsPanel.picker.test.tsx`, `/** @vitest-environment jsdom */`, `vi.mock('../api', () => ({ api: vi.fn(async () => ({ ok: true })) }))`):
- picking "Rock" PATCHes `{ holdMusic: { choice: 'rock' } }`, calls `onSaved`, toasts `Hold music: Rock — from your next run.`;
- picking "Off" toasts `Hold music off — silence between calls from your next run.`;
- picking "YouTube" with nothing saved does NOT PATCH, shows the link box; typing `https://vimeo.com/1` + Save shows `That doesn't look like a YouTube link.` inline and does NOT PATCH; typing a valid link + Save PATCHes `{ holdMusic: { choice: 'youtube', youtubeLink: '<the link>' } }`;
- a 400 from the API shows its `error` inline;
- picking "YouTube" when a playlist is already saved PATCHes `{ holdMusic: { choice: 'youtube' } }` immediately (restores it).

- [ ] **Step 2: Run** — `cd apps/cti-web && npx vitest run src/components/SettingsPanel` → FAIL.

- [ ] **Step 3: Implement.** Replace the hold-music row's switch with:

```tsx
            <select
              aria-label="Hold music"
              className="set-select"
              value={picked}
              disabled={savingMusic}
              onChange={(e) => void pickHoldMusic(e.target.value as HoldMusicChoice)}
            >
              {HOLD_MUSIC_CHOICES.map((c) => <option key={c} value={c}>{HOLD_MUSIC_LABELS[c]}</option>)}
            </select>
            {picked === 'youtube' && (
              <div className="set-youtube">
                <input
                  className="set-input"
                  placeholder="Paste a YouTube playlist or video link"
                  value={link}
                  onChange={(e) => { setLink(e.target.value); setLinkError(null); }}
                />
                <button className="btn primary" disabled={savingMusic} onClick={() => void saveYouTube()}>Save</button>
                {linkError && <div className="set-error">{linkError}</div>}
                {holdMusic.choice === 'youtube' && holdMusic.youtube && (
                  <div className="sub">YouTube · {holdMusic.youtube.listId ? 'playlist' : 'video'}</div>
                )}
              </div>
            )}
```

State: `picked` (initialised from `holdMusic.choice`, re-synced when the prop changes), `link` (initialised from `youtubeLinkFor(holdMusic.youtube)`), `linkError`. `pickHoldMusic(c)`: if `c === 'youtube'` → `setPicked('youtube')`; if `holdMusic.youtube` exists, PATCH `{ holdMusic: { choice: 'youtube' } }`; otherwise wait for Save. Any other `c` → PATCH `{ holdMusic: { choice: c } }`. `saveYouTube()`: `parseYouTubeLink(link)` → null → `setLinkError(YOUTUBE_LINK_ERROR)` and stop; else PATCH `{ holdMusic: { choice: 'youtube', youtubeLink: link.trim() } }`; an `ApiError` whose `data.error` is a string → `setLinkError(data.error)`. Success → `await onSaved()` and the toast. Update the row's copy to: "Music plays in your headset while the dialer works between calls. Pick a style, choose Off, or play your own YouTube playlist. Takes effect on your next run." In `App.tsx`, update the `me.user` type and the prop as in Interfaces.

- [ ] **Step 4: Run** — `npx vitest run src/components` + `npx tsc --noEmit -p .` → green/clean.
- [ ] **Step 5: Commit** — `feat(cti-web): hold-music picker — six styles, Off, or a YouTube playlist` (+ trailer).

---

### Task 6: Line audio signal and the play/pause rules (pure)

**Files:**
- Create: `apps/cti-web/src/line-audio.ts` + `line-audio.test.ts`; `apps/cti-web/src/hold-music-rules.ts` + `hold-music-rules.test.ts`

**Interfaces — Produces:**
```ts
// line-audio.ts
export const LOUD_LEVEL = 0.02;
export interface LineAudio {
  push(level: number): void;                                   // one outputVolume sample
  subscribe(listener: (level: number) => void): () => void;     // returns unsubscribe
  quietForMs(): number;                                         // ms since the last loud sample; Infinity if never
}
export function createLineAudio(now?: () => number): LineAudio;
export function watchLineVolume(connection: unknown, audio: LineAudio): void; // connection.on('volume', (_in, out) => audio.push(out))
// hold-music-rules.ts
export const HEARD_SAMPLES = 2;
export const QUIET_BEFORE_RESUME_MS = 1500;
export function heardSomeone(recentLevels: readonly number[]): boolean;
export interface PlayContext { sessionStatus: DialerSession['status']; currentItem: Pick<DialerCurrentItem, 'status' | 'prospectEndedAt'> | null; lineQuietForMs: number }
export function shouldPlay(ctx: PlayContext): boolean;
```

- [ ] **Step 1: Failing tests:**

```ts
// line-audio.test.ts
describe('createLineAudio', () => {
  it('quiet forever until the first loud sample, then counts from it', () => {
    let t = 1000; const a = createLineAudio(() => t);
    expect(a.quietForMs()).toBe(Infinity);
    a.push(0.001); expect(a.quietForMs()).toBe(Infinity);   // below LOUD_LEVEL
    a.push(0.3); t = 1600; expect(a.quietForMs()).toBe(600);
  });
  it('subscribers get every sample; unsubscribe stops them', () => {
    const a = createLineAudio(); const seen: number[] = []; const off = a.subscribe((l) => seen.push(l));
    a.push(0.1); off(); a.push(0.2); expect(seen).toEqual([0.1]);
  });
  it('watchLineVolume feeds outputVolume (what the rep hears), not the rep\'s own mic', () => {
    const handlers: Record<string, (...a: number[]) => void> = {};
    const conn = { on: (e: string, cb: (...a: number[]) => void) => { handlers[e] = cb; } };
    const a = createLineAudio(); const seen: number[] = []; a.subscribe((l) => seen.push(l));
    watchLineVolume(conn, a); handlers.volume!(0.9, 0.05);
    expect(seen).toEqual([0.05]);
  });
  it('watchLineVolume tolerates a connection without an event API', () => {
    expect(() => watchLineVolume({}, createLineAudio())).not.toThrow();
    expect(() => watchLineVolume(null, createLineAudio())).not.toThrow();
  });
});
// hold-music-rules.test.ts
describe('heardSomeone — two loud samples in a row, never one click', () => {
  it.each([
    [[0.3, 0.3], true], [[0.02, 0.02], true], [[0.3], false], [[0.3, 0.01], false], [[0.01, 0.3], false], [[], false], [[0.001, 0.3, 0.4], true],
  ])('%j → %s', (levels, expected) => { expect(heardSomeone(levels)).toBe(expected); });
});
describe('shouldPlay', () => {
  const base: PlayContext = { sessionStatus: 'active', currentItem: { status: 'dialing', prospectEndedAt: null }, lineQuietForMs: 5000 };
  it('plays while an active run is ringing the next number and the line has been quiet 1.5 s', () => {
    expect(shouldPlay(base)).toBe(true);
    expect(shouldPlay({ ...base, currentItem: null })).toBe(true);
    expect(shouldPlay({ ...base, lineQuietForMs: 1499 })).toBe(false);
    expect(shouldPlay({ ...base, lineQuietForMs: 1500 })).toBe(true);
  });
  it('never during a conversation, nor during the "They hung up" choice', () => {
    expect(shouldPlay({ ...base, currentItem: { status: 'connected', prospectEndedAt: null } })).toBe(false);
    expect(shouldPlay({ ...base, currentItem: { status: 'connected', prospectEndedAt: '2026-09-23T18:00:00Z' } })).toBe(false);
  });
  it('never unless the run is active', () => {
    for (const s of ['ready', 'paused', 'stopped', 'done'] as const) expect(shouldPlay({ ...base, sessionStatus: s })).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement** both modules exactly to the interfaces (`createLineAudio` keeps `lastLoudAt: number | null` and a `Set` of listeners; `heardSomeone` checks the last `HEARD_SAMPLES` entries all `≥ LOUD_LEVEL`; `shouldPlay` = `sessionStatus === 'active' && currentItem?.status !== 'connected' && !currentItem?.prospectEndedAt && lineQuietForMs >= QUIET_BEFORE_RESUME_MS`), each with a WHY comment: the line is silent while waiting in YouTube mode, so sound means a person was connected; one sample is a click, two is a join beep or a voice.
- [ ] **Step 4: Run** → PASS; tsc clean. - [ ] **Step 5: Commit** — `feat(cti-web): line-audio signal and hold-music play/pause rules` (+ trailer).

---

### Task 7: The YouTube player

**Files:**
- Create: `apps/cti-web/src/youtube-api.ts` + `youtube-api.test.ts`; `apps/cti-web/src/components/YouTubeHoldPlayer.tsx` + `YouTubeHoldPlayer.test.tsx` (jsdom)
- Modify: `apps/cti-web/src/styles.css` (`.dp-youtube`, `.dp-youtube-caption`)

**Interfaces:**
```ts
// youtube-api.ts — the slice of the IFrame API we use
export const YT_PLAYING = 1;
export interface YTPlayer { playVideo(): void; pauseVideo(): void; setShuffle(on: boolean): void; setLoop(on: boolean): void; getPlayerState(): number; destroy(): void }
export interface YTPlayerOptions {
  height: string; width: string; host: string; videoId?: string; playerVars: Record<string, string | number>;
  events: { onReady?: (e: { target: YTPlayer }) => void; onStateChange?: (e: { data: number }) => void; onError?: (e: { data: number }) => void };
}
export interface YTNamespace { Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayer }
export function playerOptionsFor(ref: YouTubeRef): Pick<YTPlayerOptions, 'videoId' | 'playerVars'>;
export function loadYouTubeApi(timeoutMs?: number): Promise<YTNamespace>;   // default 15_000
// YouTubeHoldPlayer.tsx
export interface YouTubeHoldPlayerProps {
  youtube: YouTubeRef;
  sessionStatus: DialerSession['status'];
  currentItem: Pick<DialerCurrentItem, 'status' | 'prospectEndedAt'> | null;
  lineAudio?: LineAudio;
  loadApi?: () => Promise<YTNamespace>;   // injected in tests; default loadYouTubeApi
}
export function YouTubeHoldPlayer(props: YouTubeHoldPlayerProps): JSX.Element;
```

- [ ] **Step 1: Failing tests.** `youtube-api.test.ts`:

```ts
describe('playerOptionsFor', () => {
  it('a playlist', () => { expect(playerOptionsFor({ listId: 'PLx1234567', videoId: null })).toEqual({ playerVars: { listType: 'playlist', list: 'PLx1234567', playsinline: 1, rel: 0 } }); });
  it('a video in a playlist starts on that video', () => { expect(playerOptionsFor({ listId: 'PLx1234567', videoId: 'dQw4w9WgXcQ' })).toEqual({ videoId: 'dQw4w9WgXcQ', playerVars: { list: 'PLx1234567', playsinline: 1, rel: 0 } }); });
  it('a single video loops (YouTube needs playlist=<id> for that)', () => { expect(playerOptionsFor({ listId: null, videoId: 'dQw4w9WgXcQ' })).toEqual({ videoId: 'dQw4w9WgXcQ', playerVars: { loop: 1, playlist: 'dQw4w9WgXcQ', playsinline: 1, rel: 0 } }); });
});
describe('loadYouTubeApi', () => {
  it('injects the script once and resolves with window.YT when YouTube calls back', async () => { /* jsdom: assert one <script src="https://www.youtube.com/iframe_api">, set window.YT = fake, call window.onYouTubeIframeAPIReady(), await resolves; a second call reuses the same promise */ });
  it('rejects after the timeout when YouTube never calls back', async () => { /* fake timers, 15_000 */ });
});
```

`YouTubeHoldPlayer.test.tsx` (jsdom, fake timers) with a fake namespace:

```tsx
function fakeYT(opts: { blockAutoplay?: boolean } = {}) {
  const created: Array<{ opts: YTPlayerOptions; player: YTPlayer & { state: number; calls: string[] } }> = [];
  class Player {
    state = -1; calls: string[] = []; private o: YTPlayerOptions;
    constructor(_el: HTMLElement, o: YTPlayerOptions) { this.o = o; created.push({ opts: o, player: this as never }); queueMicrotask(() => o.events.onReady?.({ target: this as never })); }
    playVideo() { this.calls.push('play'); if (!opts.blockAutoplay) { this.state = 1; this.o.events.onStateChange?.({ data: 1 }); } }
    pauseVideo() { this.calls.push('pause'); this.state = 2; this.o.events.onStateChange?.({ data: 2 }); }
    setShuffle() { this.calls.push('shuffle'); } setLoop() { this.calls.push('loop'); }
    getPlayerState() { return this.state; } destroy() { this.calls.push('destroy'); }
  }
  return { ns: { Player } as unknown as YTNamespace, created };
}
```

Tests:
- one player across re-renders (rerender 3× with new `currentItem` objects → `created.length === 1`); options: `height: '200'`, `width: '100%'`, `host: 'https://www.youtube-nocookie.com'`, playerVars from `playerOptionsFor`; a pure playlist gets `shuffle` + `loop` on ready.
- plays when `shouldPlay` (active, dialing, line quiet) → `calls` contains `play`; caption `Pauses automatically when someone answers.` after PLAYING.
- two loud line samples → `pause` immediately (no timer advance); one loud sample → no pause.
- `currentItem` becomes `connected` → `pause`.
- stays paused while `prospectEndedAt` is set, or the session is `paused`; resumes (`play`) once back to `dialing` AND 1.5 s of quiet has elapsed (advance timers past the 500 ms re-evaluation tick).
- first-time: with `blockAutoplay`, caption `Press play once — after that it pauses and resumes by itself.` until an `onStateChange({ data: 1 })`.
- stuck: after the first PLAYING, a resume `play` that never reaches PLAYING (`blockAutoplay` switched on) → after 2000 ms caption `Press play to resume`
- `loadApi` rejecting → caption `Couldn't load your YouTube playlist`; `onError` → same caption; neither throws.
- unmount → `destroy`.

- [ ] **Step 2: Run** — `cd apps/cti-web && npx vitest run src/youtube-api.test.ts src/components/YouTubeHoldPlayer.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** `youtube-api.ts`:

```ts
/**
 * The YouTube IFrame Player API — the only compliant way to play a rep's
 * YouTube music (YouTube forbids separating the audio from its player, and the
 * player must stay visible). Loaded once, on demand, the first time a run with
 * YouTube hold music starts.
 */
import type { YouTubeRef } from '@cti/contracts';

export const YT_PLAYING = 1;
// …interfaces as above…

export function playerOptionsFor(ref: YouTubeRef): Pick<YTPlayerOptions, 'videoId' | 'playerVars'> {
  const base = { playsinline: 1, rel: 0 };
  if (ref.listId && ref.videoId) return { videoId: ref.videoId, playerVars: { list: ref.listId, ...base } };
  if (ref.listId) return { playerVars: { listType: 'playlist', list: ref.listId, ...base } };
  return { videoId: ref.videoId ?? '', playerVars: { loop: 1, playlist: ref.videoId ?? '', ...base } };
}

let loading: Promise<YTNamespace> | null = null;
export function loadYouTubeApi(timeoutMs = 15_000): Promise<YTNamespace> {
  if (loading) return loading;
  const w = window as unknown as { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void };
  loading = new Promise<YTNamespace>((resolve, reject) => {
    if (w.YT?.Player) { resolve(w.YT); return; }
    const timer = setTimeout(() => { loading = null; reject(new Error('YouTube player API did not load')); }, timeoutMs);
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => { clearTimeout(timer); previous?.(); if (w.YT) resolve(w.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    document.head.appendChild(s);
  });
  return loading;
}
```

(Export a `_resetYouTubeApiForTests()` that clears `loading`.) `YouTubeHoldPlayer.tsx`: a `hostRef` div; one mount effect creates the player with `{ height: '200', width: '100%', host: 'https://www.youtube-nocookie.com', ...playerOptionsFor(youtube), events }` (on ready: for a pure playlist `setShuffle(true)` and `setLoop(true)`; then `evaluate()`); `onStateChange` PLAYING → `everPlayed = true`, clear the stuck timer and flag; `onError` / a rejected `loadApi` → error caption; cleanup destroys the player. Keep the latest props in a ref. `evaluate()`: `want = shouldPlay({ sessionStatus, currentItem, lineQuietForMs: lineAudio?.quietForMs() ?? Infinity }) && !heardSomeone(recent)`; if `!want` and the player is PLAYING → `pauseVideo()`; if `want` and not PLAYING → `playVideo()` and, when `everPlayed`, arm a 2000 ms timer that sets `stuck` if the state is still not PLAYING. Re-evaluate on prop changes (`sessionStatus`, `currentItem?.status`, `currentItem?.prospectEndedAt`) and every 500 ms (so a resume happens once the quiet window passes). Subscribe to `lineAudio`: keep the last `HEARD_SAMPLES` levels; when `heardSomeone(recent)` and the player is PLAYING → `pauseVideo()` at once. Render `<div className="section dp-youtube"><div ref={hostRef} /><div className="dp-youtube-caption">{caption}</div></div>` with the caption precedence error → first-time → stuck → normal.

- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit -p .` clean. - [ ] **Step 5: Commit** — `feat(cti-web): YouTube hold player — pauses on the first sound of an answer, resumes on the next ring` (+ trailer).

---

### Task 8: Wire it into the run

**Files:**
- Modify: `apps/cti-web/src/App.tsx` (a `LineAudio` for the dialer leg; `watchLineVolume` in `joinLeg`; props to `DialerPanel`)
- Modify: `apps/cti-web/src/components/DialerPanel.tsx` (props; mount the player under the current-record card)
- Tests: `apps/cti-web/src/components/DialerPanel.test.tsx` (SSR, with the player module mocked), `apps/cti-web/src/App.dialer-leg.test.tsx`

**Interfaces:**
- `DialerPanelProps` gains `holdMusic?: HoldMusicSetting; lineAudio?: LineAudio`.

- [ ] **Step 1: Failing tests.** `DialerPanel.test.tsx` — `vi.mock('./YouTubeHoldPlayer', () => ({ YouTubeHoldPlayer: () => <div data-testid="yt-player" /> }))`; render the running panel view (existing helpers) and assert: YouTube choice + ids + `active` session → `data-testid="yt-player"` appears AFTER the current-record card; the same with a `paused` session → still mounted (it pauses, it doesn't vanish); a preset choice, YouTube without ids, `done`/`stopped` session, or no `holdMusic` prop → no player. `App.dialer-leg.test.tsx`: `FakeConnection` records `on('volume', …)`; after `startRun()` the dialer leg has a `'volume'` listener, and a recovered leg (the existing rejoin test) gets one too.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `App.tsx`: `const lineAudioRef = useRef<LineAudio>(createLineAudio());`; in `joinLeg`, right after `dialerConnRef.current = connection;`: `watchLineVolume(connection, lineAudioRef.current);` with a comment ("in YouTube mode the line is silent while waiting, so the first sound on it means someone was connected — the player pauses on it"). Pass `holdMusic={me.user.holdMusic ?? legacyHoldMusic}` (same fallback as Task 5; share one `const`) and `lineAudio={lineAudioRef.current}` to `<DialerPanel>`. `DialerPanel.tsx`: right after `{view.currentItem && <CurrentRecord … />}`:

```tsx
      {holdMusic?.choice === 'youtube' && holdMusic.youtube
        && (view.session.status === 'active' || view.session.status === 'paused') && (
        <YouTubeHoldPlayer
          key={view.session.id}
          youtube={holdMusic.youtube}
          sessionStatus={view.session.status}
          currentItem={view.currentItem}
          lineAudio={lineAudio}
        />
      )}
```

(`key` keeps one player per run across the 1–2 s poll re-renders.) `styles.css`: `.dp-youtube { margin-top: 8px; } .dp-youtube iframe { width: 100%; height: 200px; border: 0; border-radius: 8px; } .dp-youtube-caption { font-size: 11px; color: var(--text-muted); margin-top: 4px; }`.

- [ ] **Step 4: Run** — `cd apps/cti-web && npx vitest run && npx tsc --noEmit -p .` → all green.
- [ ] **Step 5: Commit** — `feat(cti-web): the YouTube hold player rides the run; the dialer leg feeds it the line's sound` (+ trailer).

---

### Task 9: Runbook and rep-guide text

**Files:**
- Create: `docs/runbooks/hold-music.md`

- [ ] **Step 1: Write** (≤ 60 lines): the eight choices and what each does (phone line vs browser); where a rep sets it; the `waitUrl` table; how YouTube mode works (silent line, visible player, pause on first sound, resume after 1.5 s quiet on the next ring); the Salesforce-autoplay caveat and the "Press play to resume" fallback; SQL: `SELECT display_name, dialer_hold_music_choice, dialer_youtube_list_id, dialer_youtube_video_id FROM users WHERE kind='human' ORDER BY 1;`; how to add a preset (it must be a Twilio `com.twilio.music.*` set — add to `HOLD_MUSIC_CHOICES` + migration CHECK). End with a **"Rep guide paragraph"** section holding the exact text for guides.gghomes.org/power-dial (publishing it is a separate, user-approved step).
- [ ] **Step 2: Full verification** — `cd packages/contracts && npx vitest run`; `cd packages/db && npx vitest run`; `cd services/cti-api && npx tsc --noEmit -p . && npx vitest run`; `cd apps/cti-web && npx tsc --noEmit -p . && npx vitest run`; and the image's build order from clean: `rm -rf packages/*/dist && npm run build:packages && npm run build:web && npm run build:api`. Record counts in the commit body.
- [ ] **Step 3: Commit** — `docs(runbooks): hold music — the choices, YouTube mode, the SQL` (+ trailer).

---

## Self-review

- **Spec coverage:** §1 data → Task 2; §2 shared definitions → Task 1; §3 API (GET/PATCH, TwiML, telephony lookup) → Tasks 3–4; §4 Settings → Task 5, line audio + rules → Task 6, player → Task 7, mount + wiring → Task 8, known risk → Task 7 (stuck caption) + Task 9 (runbook) + rollout; §5 errors → Tasks 3 (fallback), 4 (400s), 7 (load/error captions); §6 tests → every task; §7 rollout → Task 9 + the operator's deploy/live check. Deviations recorded inline: plain CHECK instead of NOT VALID/VALIDATE (Task 2); Dockerfile build order (Task 1, required for the shared package).
- **Placeholders:** the two loader tests in Task 7 name exactly what to assert; no TBD/TODO.
- **Type consistency:** `HoldMusicChoice`/`HoldMusicSetting`/`YouTubeRef` (Task 1) are consumed by Tasks 3–8; `LineAudio`/`createLineAudio`/`watchLineVolume` and `heardSomeone`/`shouldPlay` (Task 6) by Tasks 7–8; `YTNamespace`/`playerOptionsFor`/`loadYouTubeApi` (Task 7) by the player only; `DialerCurrentItem.prospectEndedAt` comes from the cadence plan's Task 11 (this plan runs after it).
