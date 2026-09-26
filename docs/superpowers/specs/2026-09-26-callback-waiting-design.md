# Callback waiting during a power-dial run: Design

**Date:** 2026-09-26 · **Ruling:** the user approved "answer during a run" ("and 2") together with ring-longer (shipped 9e53456, 25 s).

**Rulings (2026-09-26):** the cancel counts toward the per-customer ceiling but not toward the rollover; the `/voice` guard admits a leg only when the named run is live AND no other run of the rep's is active.

## Why

While a rep power dials, the rep's conference leg counts as an active call. The Twilio Voice SDK (2.18.3), with its default `allowIncomingWhileBusy: false`, silently drops every callback to that rep's own numbers. Twilio then marks the `<Client>` leg `busy` in 0 s, and the call forwards to the rep's cell or goes to voicemail. The rep never knows it happened. Callbacks are the warmest calls a rep gets.

## What the rep sees

- **A callback during a run while the rep is NOT talking to a prospect** (waiting, a dial ringing, or paused): the power-dial view stays on screen. A banner appears above the current-record card: **"Callback: <caller name or number> · <record type>"** with **[Pause & answer]** and **[Ignore]**. A short chime plays through the chosen speaker, because the SDK plays no ringtone while busy. The rep has the 25 s ring window to decide.
  - **Ignore:** the callback forwards or goes to voicemail, exactly as today.
  - **The caller hangs up first:** the banner goes away.
- **A callback while the rep IS talking to a prospect** (current item `connected` and `prospectEndedAt` not set): no interruption. It is rejected at once, as today (forward or voicemail), and a toast says "Missed callback from <name> — you were on a call. It went to <your cell|voicemail>."
- **Pause & answer**, in order:
  1. The run pauses. A prospect dial that is still ringing is cancelled and its person goes back in the queue. The cancel is not one of the owner's dials for the follow-up rollover. It DOES count toward the per-customer ceiling (the person's phone rang), as well as the 3 h courtesy and the state-law cap.
  2. The rep leaves the dialer room.
  3. The callback is answered through the normal inbound path: screen-pop, recording and caller ID.
  4. After the call and wrap-up, the rep returns to the power-dial view with the run **paused**.
  5. **Resume** puts the rep back in the room first, then restarts dialing.
- **The caller hangs up during Pause & answer:** the run stays paused, and the rep sees "The caller hung up before you answered." plus the paused run with Resume.

## Decisions

1. **Device:** set `allowIncomingWhileBusy: true` at construction. Don't use `updateOptions`, because that rebuilds the sound cache and loses the ringtone sink chosen in Settings.
2. **Busy on a manual call is unchanged:** an incoming callback during a normal outbound or inbound call is `reject()`ed immediately, which is today's outcome (forward or voicemail).
3. **Talking is judged by the item, not the session:** `currentItem.status === 'connected' && !currentItem.prospectEndedAt`. The web lifts a minimal run snapshot (`sessionId`, `sessionStatus`, `currentItem.status`, `prospectEndedAt`) from DialerPanel to App.
4. **Server endpoint `POST /dialer/sessions/:id/take-callback`** (owner-only):
   - It pauses the session FIRST.
   - Then, if an item is `dialing`, it settles that item as cancelled and requeued, and only then hangs up its prospect leg (settle before hangup, the house rule).
   - If an item is already `connected` (a human answered in the race), it returns **409** `{ reason: 'connected' }` and changes nothing. The web then treats the rep as talking: it rejects the callback and shows the toast.
   - It is idempotent on an already-paused session.
5. **Leaving the room safely:** the web clears `dialerConnRef` BEFORE `disconnect()`, so dropped-leg recovery never fires. It never lets the SDK's `beforeAccept` disconnect the leg, because that path makes recovery stop the whole run. Nav stays locked, and no deferred teardown is flushed. The server's rejoin route sees `completed` and pauses a run that is already paused, which is a no-op.
6. **Resume after a callback:** if the rep has no live dialer leg, Resume first joins the room with the paused session id and waits for the join. Then it POSTs `/resume`. The server's `/voice` DialerConference branch admits the leg only when the named run is live (active or paused) AND no other run of the rep's is active, so a stale tab can't land in a newer run's room. It is deliberately not "the newest non-terminal run": a newer run that is only `ready` or `paused` owns no room and must not lock the rep out of the run they are dialing.
7. **A callback longer than 10 minutes:** while the run is parked for a callback, App sends a heartbeat (GET the session every 60 s), so the no-poll reaper doesn't stop the paused run.
8. **Screen-pop:** remounting DialerPanel must not pop the run's current record again. The last-popped id moves to App or sessionStorage.
9. **Leg recovery while a callback rings:** if the leg drops unexpectedly while a callback is ringing, recovery waits. SDK `connect()` would silently `ignore()` the pending call. The callback shows as the normal ring screen, and the server pauses the run on leg loss as today.
10. **iOS:** unchanged. It shares the `rep_<id>` identity; this change is web-only apart from the endpoint.

## Out of scope

Call-waiting during a manual call. Holding a live prospect to take a callback. Changes to the cti-desktop app.

## Tasks (for the plan)

1. **API:** the `take-callback` engine function and route, following the ordering rules, with tests for pause-first, dialing→cancelled+requeued, 409 when connected, idempotency, and owner-only. Plus the `/voice` DialerConference guard: the named run is live AND no other run of the rep's is active.
2. **Web core:** the Device flag, the incoming branch during a run (talking → reject + toast; else → `callbackWaiting`), the Pause & answer sequence (endpoint, then clear ref and disconnect, then accept via the existing `acceptIncoming`), cancel handling, and the heartbeat.
3. **Web UI:** the banner and chime in DialerPanel, Resume = join then resume when no leg, the lifted run snapshot, and the last-popped id kept across remounts.
4. **Rep guide and runbook note.**
