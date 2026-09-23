# Hold Music Choices: Design

**Date:** 2026-09-23
**Goal:** Let each rep choose what they hear between Power Dial calls: one of
six preset music sets played through the phone line, silence, or their own
YouTube playlist played in a small YouTube player on the Power Dial screen.

## What changes, in one paragraph

Settings → "Hold music during Power Dial" becomes a picker: **Off · Classical ·
Ambient · Electronica · Guitars · Rock · Soft rock · YouTube**. The six presets
are Twilio's royalty-free hold-music sets and play through the phone line
exactly as today's music does (today's music *is* Classical — Twilio's
default). YouTube cannot go through the phone line, so choosing it makes the
line wait in silence and hands the music to YouTube's own player, shown under
the current-record card during a run; it pauses the instant someone is
connected and resumes when the dialer rings the next number.

## Why these constraints

- **Presets:** Twilio serves six hold-music sets (`com.twilio.music.classical`,
  `ambient`, `electronica`, `guitars`, `rock`, `softrock`) through its
  `holdmusic` twimlet. Verified 2026-09-23: all six return `<Play>` TwiML (HTTP
  200). A conference with no `waitUrl` already plays Classical, so Classical
  keeps omitting `waitUrl` and depends on nothing new.
- **YouTube cannot feed the phone line.** YouTube's terms forbid separating a
  video's audio from its player, and Twilio can only play an audio file or
  TwiML. The only compliant route is YouTube's embedded player in the rep's
  browser, which YouTube requires to stay **visible** at **200 × 200 px or
  more**. Non-Premium accounts get YouTube's ads.
- **Pausing must beat "hello?"** The dialer learns of a connect by polling
  (1 s while ringing). The line itself is faster: in YouTube mode the rep waits
  in a silent room, so the first sound on it — Twilio's join beep, then the
  prospect — means a person was just connected. The Voice SDK reports the
  line's volume many times a second (`Call` `'volume'` event).

## Rulings (2026-09-23)

| # | Ruling |
|---|---|
| 1 | Presets: the six Twilio sets + Off. Existing "on" → Classical, "off" → Off. |
| 2 | YouTube: a small, visible YouTube player on the Power Dial screen; pauses automatically on answer, resumes automatically when the next number is ringing. |
| 3 | A change takes effect on the rep's next run. |

---

## 1. Data (migration 0043, idempotent, house style)

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_hold_music_choice text NOT NULL DEFAULT 'classical';
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_list_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_video_id text;
UPDATE users SET dialer_hold_music_choice = 'off' WHERE dialer_hold_music = false AND dialer_hold_music_choice = 'classical';
```

A `CHECK (dialer_hold_music_choice IN (...the eight values...))` constraint is
added with `NOT VALID` then validated, so a bad value can never be stored. The
old `dialer_hold_music` boolean stays one release for softphone tabs that have
not reloaded (see §2); it is dropped in a later migration.

## 2. Shared definitions — `packages/contracts/src/hold-music.ts`

One definition, used by the API and the softphone:

- `HOLD_MUSIC_CHOICES = ['off','classical','ambient','electronica','guitars','rock','softrock','youtube'] as const`,
  `type HoldMusicChoice`, and `HOLD_MUSIC_LABELS` (`softrock` → "Soft rock").
- `parseYouTubeLink(input: string): { listId: string | null; videoId: string | null } | null` —
  accepts `youtube.com/playlist?list=…`, `youtube.com/watch?v=…(&list=…)`,
  `m.youtube.com/…`, `music.youtube.com/…`, `youtu.be/<id>(?list=…)`, with or
  without scheme; video ids must match `^[A-Za-z0-9_-]{11}$`, playlist ids
  `^[A-Za-z0-9_-]{10,64}$`; anything else → `null`. Never returns a URL.

## 3. API

- **`GET /auth/me`** adds `holdMusic: { choice, youtube: { listId, videoId } | null }`
  and keeps `dialerHoldMusic: choice !== 'off'` for old tabs.
- **`PATCH /auth/me`** accepts `holdMusic: { choice: HoldMusicChoice, youtubeLink?: string }`.
  `choice: 'youtube'` requires a link that `parseYouTubeLink` accepts, else 400
  `{ error: "That doesn't look like a YouTube link." }`; ids are stored, the link
  is not. Choosing a preset or Off leaves the stored ids alone (switching back
  to YouTube restores the last playlist). The legacy `dialerHoldMusic: true|false`
  still works: `false` → `off`; `true` → `classical` only if the current choice
  is `off` (it never overwrites a preset or YouTube).
- **Conference TwiML** (`dialer/twilio-telephony.ts`): `ConferenceOptions.holdMusic`
  becomes `holdMusic?: HoldMusicChoice`. A pure `waitUrlFor(choice)` returns
  `undefined` for `classical` (Twilio's default — attribute omitted, exactly
  today's TwiML), `''` for `off` and `youtube` (silent), and
  `https://twimlets.com/holdmusic?Bucket=com.twilio.music.<set>` for the other
  five. Only the rep's leg ever carries it (the prospect never waits).
- **`routes/telephony.ts`**: `repHoldMusic` becomes `repHoldMusicChoice(from)` →
  `HoldMusicChoice`, read from `dialer_hold_music_choice`; missing row, unknown
  value or a failed/slow lookup → `classical` (today's fail-safe: never keep a
  rep out of their room). The join and the rejoin loop both use it.

## 4. The softphone

**Settings (`SettingsPanel.tsx`).** The on/off button becomes a select with the
eight labels; picking a preset or Off saves immediately (toast "Hold music:
Ambient — from your next run."). Picking YouTube shows a link box and a Save
button; an invalid link shows the API's sentence inline and does not save.
When YouTube is saved, the row shows "YouTube · playlist" or "YouTube · video".

**Line audio signal (`App.tsx`).** In `joinLeg`, beside `watchDialerLeg` and
`keepMicAlive`, the dialer leg's `'volume'` events (`(inputVolume, outputVolume)`)
feed a tiny subscribable signal (`lineAudio`), re-attached on every join
(including dropped-leg recoveries). Only `outputVolume` — what the rep hears —
is used.

**Rules (`hold-music-rules.ts`, pure).**
- `heardSomeone(samples)` → true once `outputVolume ≥ 0.02` on 2 consecutive
  samples (a single click must not pause the music).
- `shouldPlay({ sessionStatus, currentItem, lineQuietForMs })` → true only when
  the session is `active`, the current record is `dialing` (or there is none
  yet), nothing is `connected` (including a connected record whose prospect
  hung up — the Redial/Resume choice), and the line has been quiet for
  ≥ 1500 ms. Paused, ready, stopped and done runs → false.
- Pause triggers: `heardSomeone` (instant) **or** the poll showing `connected`
  (backup). Resume trigger: `shouldPlay` turning true.

**Player (`YouTubeHoldPlayer.tsx`).** Mounted once per live run (never
re-created by the 1–2 s poll re-render) under the current-record card, only
when the rep's choice is YouTube. Loads the YouTube IFrame API from
`https://www.youtube.com/iframe_api`, player host
`https://www.youtube-nocookie.com`, height 200 px, width 100 %; a playlist
loads with shuffle on; a single video loops. Caption: "Pauses automatically
when someone answers." Until YouTube reports its first `PLAYING`, the caption
reads "Press play once — after that it pauses and resumes by itself." On a
YouTube error (private/deleted playlist) the player shows YouTube's message
and the run carries on untouched. Unmounted (and the player destroyed) when
the run ends, stops or the panel unmounts.

**Known risk — resume inside Salesforce.** Pausing never needs permission.
Resuming by code after the first press is allowed in a frame the rep has
clicked in Chrome's standalone tab; inside the Salesforce utility bar it also
depends on Salesforce's iframe granting autoplay to our frame, which cannot be
verified from here. If `playVideo()` does not reach `PLAYING` within 2 s, the
caption changes to "Press play to resume" and the rep taps play; nothing else
breaks. A live check in the Salesforce console is part of the rollout.

## 5. Error handling

- A settings lookup that fails or times out during join/rejoin → Classical (as
  today). A bad stored choice can't exist (CHECK constraint); if parsing it ever
  fails, Classical.
- The YouTube script failing to load, or the player erroring, never touches the
  call or the run: the component renders a one-line "Couldn't load your YouTube
  playlist" and stays out of the way.
- The volume signal missing (older SDK, no events) → the poll still pauses on
  `connected` (≤ 1 s late).

## 6. Testing

- `parseYouTubeLink`: every accepted shape (playlist, watch, watch+list,
  youtu.be, youtu.be+list, m./music., no scheme) and rejects (other hosts,
  short ids, `javascript:`, empty, a playlist id with illegal characters).
- `waitUrlFor`: all eight choices, pinned exactly (Classical → no attribute).
- Rendered TwiML for the rep leg per choice; the prospect leg never carries a
  `waitUrl`.
- Route tests: GET shape; PATCH validation (400 sentence), legacy boolean
  mapping (never overwrites a preset/YouTube), ids stored not links; join and
  rejoin use the rep's choice; lookup failure → Classical.
- Migration test: columns, default, CHECK, the off-carry-over UPDATE.
- `hold-music-rules`: `heardSomeone` thresholds and the 2-sample rule;
  `shouldPlay` for every session status and item status incl. hung-up, and the
  1.5 s quiet window.
- Player component with a fake `YT` global: mounts once across re-renders,
  pauses on the first loud samples and on `connected`, resumes when `shouldPlay`
  flips true, shows the one-time prompt until `PLAYING`, falls back to "Press
  play to resume" after 2 s, destroys on unmount.
- Settings picker: saves presets immediately; YouTube requires a valid link;
  shows the API error inline.
- Independent adversarial review + mutation testing per task, as usual.

## 7. Rollout

- Off-hours deploy; migration 0043 runs first. Lands after the in-progress
  cadence work (different files; neither blocks the other being built).
- Live check with one rep: a preset other than Classical plays and stops on
  connect; YouTube pauses on connect and resumes on the next ring — in the
  standalone `/cti/` tab and in the Salesforce utility bar (the §4 risk).
- Rep guide (guides.gghomes.org/power-dial): one paragraph on the picker and
  the YouTube player.

## Out of scope

- Uploading our own tracks (licensing; not asked for).
- Hold music for click-to-dial or inbound — only the Power Dial wait.
- Volume ducking, per-run choice, a shared team playlist.
