# Hold music during Power Dial

Spec: `docs/superpowers/specs/2026-09-23-hold-music-choices-design.md`.
A rep sets it in Settings under "Hold music during Power Dial". A change takes effect on the rep's next run.

## The eight choices

| Choice | Where it plays | Rep leg conference `waitUrl` |
|---|---|---|
| Off | Nowhere; silence | `""` |
| Classical (default) | The phone line | attribute omitted, which is Twilio's default and exactly the pre-choice TwiML |
| Ambient, Electronica, Guitars, Rock, Soft rock | The phone line | `https://twimlets.com/holdmusic?Bucket=com.twilio.music.<ambient/electronica/guitars/rock/softrock>` |
| YouTube | The rep's browser, in YouTube's own player | `""`; the line waits in silence |

The code is `waitUrlFor` in `services/cti-api/src/dialer/twilio-telephony.ts`. It runs on the conference join and on every rejoin (`routes/telephony.ts`). A failed, slow, or unknown lookup falls back to Classical, so a database hiccup never keeps a rep out of their room.

## YouTube mode

- **Why it plays in the browser:** YouTube's terms forbid taking the audio out of its player, so it can't go through the phone line. The player stays visible under the current-record card, 200 px tall.
- **The link:** the rep pastes a playlist or video link. Only the ids are stored, in `users.dialer_youtube_list_id` and `dialer_youtube_video_id`, never the link.
- **Pause:** the player pauses on the first sound on the silent line. That's two loud samples of the dialer leg's `outputVolume` (at least 0.02). The poll showing `connected` is the backup.
- **The hold-off after an answer:** the music stays off until the poll moves to a new record or status, or 12 s have passed. Without this, a quiet "hello?" plus a slow poll would bring the music back mid-call.
- **Resume:** when the next number rings and the line has been quiet for 1.5 s.
- **First press:** the rep must press play once per run, because browsers block autoplay before a click. The caption says so.
- **Inside the Salesforce utility bar:** resuming by code depends on Salesforce's iframe granting autoplay. If play doesn't start within 2 s, the caption changes to "Press play to resume", and nothing else is affected.
- **A private or deleted playlist** shows "Couldn't load your YouTube playlist". The run carries on.
- **Live-check items:**
  - The conference join beep or line noise pausing the music by mistake. If it happens, raise `LOUD_LEVEL` in `apps/cti-web/src/line-audio.ts`.
  - Playlist shuffle actually taking effect.

## SQL (read-only)

```sql
SELECT display_name, dialer_hold_music_choice, dialer_youtube_list_id, dialer_youtube_video_id
  FROM users WHERE kind = 'human' ORDER BY 1;
```

## Deploying (first release, migration 0043)

1. Deploy off-hours. `preDeployCommand` runs 0043 while the old code still serves; the migration is additive, so the old code is unaffected.
2. After the new deployment is live, run this once to close the overlap gap. A rep who switched hold music off in an old tab between the migration and go-live would otherwise hear Classical. The statement is idempotent.
   ```sql
   UPDATE users SET dialer_hold_music_choice = 'off' WHERE dialer_hold_music = false AND dialer_hold_music_choice = 'classical';
   ```
3. Check: the count of `choice = 'off'` equals the count of `dialer_hold_music = false`.
4. Roll back by redeploying the previous image only. Never roll back the migration; the boolean is kept in step, so the old image works unchanged.

Live checks, one rep, off-hours:
- A preset other than Classical plays on the line and stops on answer.
- YouTube in the standalone `/cti/` tab: it pauses on answer, stays paused on "They hung up", and resumes on the next ring. End call keeps it paused.
- YouTube inside the Salesforce utility bar: does it resume by itself, or show "Press play to resume"?
- Start a second run in the same tab and press play during the first ring. If it pauses by itself, the rep's own join beep is the cause. The fix is a short grace after each leg join, or `beep: false` on the rep leg.
- Shuffle takes effect.

## Adding a preset

It must be one of Twilio's `com.twilio.music.*` twimlet buckets. Three places change:
1. Add it to `HOLD_MUSIC_CHOICES` and `HOLD_MUSIC_LABELS` in `packages/contracts/src/hold-music.ts`.
2. Widen the `users_dialer_hold_music_choice_check` constraint in a new migration.
3. Pin its URL in `twilio-telephony.test.ts`.

## Rep guide paragraph (for guides.gghomes.org/power-dial; publishing is a separate, user-approved step)

> **Hold music.** In Settings, "Hold music during Power Dial" lets you choose what you hear while the dialer rings the next number. Pick one of six music styles, pick Off for silence, or pick YouTube and paste a playlist or video link. With YouTube, a small player shows under the current record. Press play once at the start of a run. After that it pauses by itself the moment someone answers and picks up again on the next ring. If it ever shows "Press play to resume", tap play. Changes apply from your next run.
