# Reset CTI (per rep, admin-triggered) + sound check: Design

**Date:** 2026-09-28 · **Ask (user):** "a mechanism where we can reset on a user basis — log them out of the CTI — force reset their sound settings, have them reconnect, and make sure the Chrome popup comes back to allow input and output."

## The browser limit

A website can't make Chrome show its microphone popup again once the site is **Allowed** or **Blocked**. Only the user can change it, through the site-settings icon. So the reset handles each of Chrome's three permission states:

| Chrome's mic setting for the CTI | What the rep sees after the reset |
|---|---|
| Not decided yet (`prompt`) | An "Allow microphone" button. Chrome's popup appears when they click it. |
| Blocked (`denied`) | A full-screen how-to: "click the icon left of the address bar → Microphone → Allow". It flips to ✓ the moment they allow it (via `PermissionStatus.onchange`), with no reload needed. |
| Allowed (`granted`) | No popup needed. The sound check opens: a live mic level meter, the mic and speaker pickers, and "Play test sound". |

## What an admin sees

In **More → Team** (`TeamPanel`), each rep's row gets a **Reset CTI** button and a status line:

- "Reset pending since 2:41 PM", or
- "Reset done 2:43 PM".

The header gets a **Reset everyone** button, behind a confirm. It covers every human user in the org except the admin who clicks it.

## What the rep sees

1. **When idle,** within about 20 s the softphone signs them out. The Twilio Device stops, and saved mic/speaker picks and the session are wiped. The softphone then reloads to the "Sign in with Salesforce" screen, with the note "Your admin reset your phone. Sign in again to reconnect."
   - Idle means: no call, ringing, wrap-up or pending disposition, placing, power-dial run (live or parked), or callback waiting.
   - A reset never interrupts any of those. It waits.
2. **After sign-in,** the **sound check** runs once, in whichever of the three permission states applies. "Looks good" finishes it. It can also be run any time from Settings with **Run sound check**.

**Settings → Reset my audio** is self-serve and never signs the rep out. It clears the rep's mic and speaker picks, rebuilds the Twilio Device (only when idle, and also when there is none, e.g. after "Inbound calls unavailable"), and opens the sound check.

## Decisions

1. **Storage:** migration 0045 adds three nullable columns to `users`: `cti_reset_requested_at timestamptz`, `cti_reset_requested_by uuid`, and `cti_reset_completed_at timestamptz`.
2. **Pending is per session, not a global flag.** A session is due for reset when `users.cti_reset_requested_at > sessions.created_at`. Signing in again creates a new session, and that ends it. This means no reset loop is possible, and a rep who was offline gets reset on their next load. The admin status shows *pending* while `requested_at > coalesce(completed_at, 'epoch')`; otherwise it shows *done at completed_at*.
3. **Delivery:** there is a new, cheap `GET /auth/reset-signal` returning `{ resetDue: boolean }`.
   - It is based on the caller's own session.
   - EVERY tab polls it every 20 s, and again on `visibilitychange → visible`. Non-leader tabs make no other periodic calls, so this poll is new for them.
   - A 401 is ignored. The existing bootstrap and token-refresh paths handle expiry.
   - Today's refresh-401 `signOut()` would tear the Device down mid-call, so the reset must never be delivered as a 401.
4. **Doing the reset, in this order:**
   1. Confirm the tab AND every live peer tab on the rep's BroadcastChannel are idle. The coordinator exposes the peers' busy flags. Peers share this channel only when they share storage, and so also the session token.
   2. `teardownDevice()`, which releases a pinned mic.
   3. `POST /auth/reset-complete`. The server stamps `cti_reset_completed_at = now()` and revokes the CALLING session only (`revokeSession(bearer)`). The iPhone app's session is untouched.
   4. Broadcast `{type:'reset'}`, so peer tabs tear down, wipe and reload too.
   5. Wipe `cti.session.v1`, `cti.displayName`, `cti.audio.input` and `cti.audio.output`.
   6. Set `cti.soundCheck.due = '1'` and `cti.reset.notice = '1'`.
   7. `window.location.reload()`. This keeps `?sf=`, and inside Salesforce it reloads only the softphone iframe.

   If step 3 fails, the tab still wipes and reloads. The old token is gone from storage, and the next session's `created_at` clears the reset.
5. **Busy checking:** there is one exported `isBusyForReset()` covering:
   - phase ringing, active or wrapup;
   - a pending disposition;
   - `placingRef` and `takingCallbackRef`;
   - `incomingRef`;
   - a LIVE `connectionRef` (status not `closed`);
   - `dialerConnRef`, `dialerLive` and `dialerSessionId`;
   - `callbackWaitingRef` and `parkedRunIdRef`.
6. **Sound check:**
   - The permission state comes from `navigator.permissions.query({name:'microphone'})`. If the Permissions API is missing, treat the state as `prompt`.
   - The level meter is an `AnalyserNode` on a short-lived `getUserMedia` stream on the chosen mic. The stream's tracks are stopped when the check closes, so the mic is never left open.
   - It reuses `AudioDeviceRows` for the pickers and the existing test tone.
7. **Sign-in after the reset still needs one click.** Salesforce sign-in is a popup and needs a user gesture. Inside Salesforce the reload surfaces the panel (`setPanelVisibility(true)`).
8. **Admin routes:**
   - `POST /admin/team/:userId/reset-cti` (admin only, same org, human user).
   - `POST /admin/team/reset-cti` (every human user in the org except the requester).
   - `GET /admin/team` adds `ctiResetRequestedAt` and `ctiResetCompletedAt`.
   - Every request is audited in the log as `{ adminId, targetUserId }`.
9. **iOS and cti-desktop:** unchanged, and their sessions are never revoked. This is web softphone only.

## Out of scope

Forcing Chrome's popup when the site is Allowed or Blocked, which is impossible for a website. Resetting OS-level devices (for example, another app holding the headset). The iOS app.

## Tasks

1. **API:** migration 0045 plus schema; the reset-signal and reset-complete auth routes; the two admin routes and the team-list fields. Every rendered SQL and WHERE is pinned; tests cover admin-only, same-org and exclude-self.
2. **Web core:** the reset poller in every tab; `isBusyForReset`; the coordinator exposing its peers' busy flags plus a `reset` message; `performReset` in the order above; peer handling of the reset message; the post-reset sign-in notice.
3. **Web UI:** the sound-check screen (three states, the meter, pickers, test tone, "Looks good"); Settings "Reset my audio" and "Run sound check"; the TeamPanel Reset CTI buttons, statuses and "Reset everyone" confirm.
4. **Docs:** runbook `docs/runbooks/cti-reset.md` and a rep-guide note.
