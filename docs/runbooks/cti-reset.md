# Reset CTI (per rep) and the sound check

Spec: `docs/superpowers/specs/2026-09-28-cti-reset-design.md`. Plan: `docs/superpowers/plans/2026-09-28-cti-reset.md`. Migration `0045`.
Code: `services/cti-api/src/routes/cti-reset.ts` (API); `apps/cti-web/src/cti-reset.ts`, `reset-poller.ts` and `use-cti-reset.ts` (web); `components/SoundCheck.tsx`.

## What it does

- **The admin:** in **More → Team**, presses **Reset CTI** on a rep's row. Or they press **Reset everyone** and then **Yes, reset everyone**, which covers every human user in the org except that admin.
- **The rep's web softphone**, in every tab of it in that browser, signs out the next time it is idle:
  - the Twilio Device stops;
  - the saved session, display name, microphone and speaker are wiped;
  - the softphone reloads to "Sign in with Salesforce" with *Your admin reset your phone. Sign in again to reconnect.*
  - Inside Salesforce only the softphone panel reloads, and it pops open. The `?sf=` stays, so click-to-dial works after sign-in.
- **After sign-in**, the sound check runs once.
  - One sign-in is enough: the rep's other softphone tabs in that browser, still on the sign-in screen, reload and pick the new session up (a tab with a call still up behind that screen waits for the call to end).
  - **Looks good** in any one tab finishes the check in all of them.
- **Other clients:** the iPhone app and the desktop app are never signed out. Only the web tab's own session is revoked.

## When it happens

- **Due:** a web session is due while `users.cti_reset_requested_at > sessions.created_at`.
  - Signing in again creates a newer session, and that ends it. There is no flag to clear, so there is no loop.
  - A rep whose softphone is closed is reset on their next load.
- **Polling:** every signed-in tab polls `GET /auth/reset-signal` every 20 s, and again when the tab becomes visible.
  - The poll has its own rate limit: 60 a minute per session token, separate from the office IP's shared budget — plus a per-IP ceiling on failed lookups, so a bad or spoofed session token can't be hammered from one address (see **Controller rulings and review notes** below).
  - A 401 on the poll is ignored. A reset is never delivered as a sign-out.
- **Idle** means none of these, in this tab AND in every other softphone tab of the rep's in the same browser — only real live things hold a reset back (see **Controller rulings and review notes → What counts as busy**):
  - a call, a ring, or wrap-up;
  - placing a call, or taking a callback;
  - a power-dial run that is live, paused, or parked for a callback;
  - a callback waiting.
- **Who acts:** only the softphone's leader tab starts the reset. The other tabs follow its broadcast.
- **Timing:** a tab never acts in its first 3 s, and it needs two idle checks 2 s apart. In practice that's 4–25 s after the admin clicks, if the rep is idle.

## What the admin sees

- *Reset pending since 2:41 PM*: the request is later than the last completion.
- *Reset done 2:43 PM*: a softphone tab finished it (`POST /auth/reset-complete`).
- To refresh, switch to another tab and back to Team.

## Why a reset stays "pending"

1. **The rep is busy** (see Idle above): a call, a ring, wrap-up, dialing out, a live/paused/parked power-dial run, or a waiting callback. It waits, by design. An unfinished disposition or an undismissed "Run complete" summary does **not** hold it back — see **Controller rulings and review notes → What counts as busy**.
2. **The softphone isn't open.** It happens on the next load.
3. **A softphone tab from before this release is open.** That tab can't report the new reset-busy signal, so peers fall back to its older "busy" signal and every tab waits. If the old tab is the **leader**, it never starts a reset on its own — the reset waits until that tab reloads. Ask the rep to reload all softphone tabs (or close the old one). See **Controller rulings and review notes** below.
4. **The tab's `reset-complete` failed** (network). The tab still reset itself, but nothing stamped `cti_reset_completed_at` — the admin can see "pending" briefly even though the rep is done. It self-heals: the rep's fresh session (created at sign-in) isn't due, and the next time it polls `reset-signal` while `requested_at > completed_at`, the server stamps the reset completed right then. No second admin-triggered reset is needed. Check whether the rep has a web session newer than the request (the second query below) to confirm.
5. **A busy softphone tab went quiet.** A tab that last said it was busy (for example, wrap-up open in a background tab) keeps holding the reset back after it stops answering: Chrome slows a tab hidden for 5+ minutes to about one heartbeat a minute. That hold ends when the tab closes normally, says it's free, or 10 minutes after it last said busy (a crashed tab).
6. **The Salesforce panel and a standalone `/cti/` tab** usually keep separate sign-ins. Each resets on its own, and "done" appears after the first one finishes — see **Controller rulings and review notes → "Done" is per user, not per browser**.

## Controller rulings and review notes

These close the open questions the plan flagged and record a few points reviewers raised. They describe the intended, final behavior — where any text above reads differently, this section governs.

- **What counts as busy.** A reset waits only on real live things: a call, ringing, the wrap-up form, dialing out, a power-dial run that is live, paused or parked, or a waiting callback. An old unfinished disposition or a finished run's summary does **not** block it.
- **"Done" is per user, not per browser.** A rep with both the Salesforce panel and a standalone tab, each signed in separately, shows "done" after the first one resets. The Team panel tracks the user, not a specific browser or tab.
- **A failed reset-complete still finishes.** The next poll from the rep's fresh session stamps the reset as done, so the admin never sees "pending" forever.
- **Softphone tabs opened before this release don't report the new reset-busy signal.** Peers fall back to such a tab's older "busy" signal. If an old tab is the leader, it never starts a reset, so the reset waits until that tab reloads. On deploy day, ask reps to reload their softphone once.
- **The status poll has its own rate limit:** 60 per minute per session, plus a per-IP ceiling on failed lookups.
- **Revoke scope.** A reset signs out only that browser's CTI session. The iPhone app and other clients stay signed in.
- **The browser limit.** Chrome can't be forced to re-show its microphone popup when the site is Allowed or Blocked. What the rep sees in each of the three states:
  - **Not decided:** an **Allow microphone** button; Chrome's own popup appears on the click.
  - **Blocked:** the how-to ("click the icon left of the address bar → Microphone → Allow"); it flips to ✓ on its own the moment they allow it, no reload needed.
  - **Allowed:** no popup — straight to the live level meter, the Microphone and Speaker pickers, **Play test sound**, and **Looks good**.

## SQL (read-only)

```sql
-- Outstanding and recent resets
SELECT u.display_name, u.email, u.cti_reset_requested_at, u.cti_reset_completed_at,
       a.email AS requested_by
  FROM users u LEFT JOIN users a ON a.id = u.cti_reset_requested_by
 WHERE u.kind = 'human' AND u.cti_reset_requested_at IS NOT NULL
 ORDER BY u.cti_reset_requested_at DESC;

-- One rep's live sessions and whether each is due. iPhone and desktop
-- sessions also show as due, but those apps never poll, so they are never
-- reset or revoked.
SELECT s.id, s.created_at, s.expires_at, (u.cti_reset_requested_at > s.created_at) AS due
  FROM sessions s JOIN users u ON u.id = s.user_id
 WHERE u.email = '<rep email>' AND s.revoked_at IS NULL AND s.expires_at > now()
 ORDER BY s.created_at DESC;
```

## Logs

- `cti_reset_requested` `{ adminId, targetUserId }`: one line per person (Reset everyone logs one per target).
- `cti_reset_completed` `{ userId }`: a tab finished and revoked its own session.

## The sound check

| Chrome's mic setting for the softphone | What the rep sees |
|---|---|
| Not decided | **Allow microphone**. Chrome's popup appears on the click. |
| Blocked | How to unblock: "Click the icon left of the address bar → Microphone → Allow". It flips to ✓ the moment they allow it, with no reload. |
| Allowed | A live level meter, the Microphone and Speaker pickers, **Play test sound**, and **Looks good**. |

- **Chrome's popup:** a website can't make it appear again once the mic is Allowed or Blocked. Only the rep can change that, in site settings.
- **Inside Salesforce:** the icon to use is the one in the Salesforce page's own address bar.
- **The mic:** the stream is stopped whenever the check closes. The check hides during a ring, a call, wrap-up, a waiting callback or a power-dial run, and comes back afterwards.
- **"Not now"** closes it for this page load. After a reset it returns on each load until **Looks good**.
- **Settings → Run sound check** opens it at any time.
- **Settings → Reset my audio** puts the mic and speaker back to System default and builds a fresh Twilio Device (only when nothing is live; otherwise the live Device just switches to the defaults). Then it opens the check. It never signs the rep out.

## Deploying (migration 0045)

1. The migration is additive (three nullable columns). `preDeployCommand` runs it while the old code still serves.
2. Open softphone tabs keep the old build until they reload, and an old tab blocks every reset in that browser (see "pending", item 3). Tell reps to reload before anyone uses Reset CTI.
3. To roll back, redeploy the previous image. Never roll back the migration: the old code ignores the columns.

Live checks (one test rep, off-hours):

- Reset an idle rep in the standalone `/cti/` tab. The sign-in screen with the notice shows within ~25 s, and Team shows "done".
- Reset during a test call on our own test numbers. Nothing happens until the call and its wrap-up are finished.
- Two tabs, one on a call: neither resets until the call and wrap-up end, then both reload.
- Inside the Salesforce utility bar: only the panel reloads and pops open, and click-to-dial works after sign-in.
- The rep's iPhone app is still signed in and can place a call.
- Sound check: with the mic Allowed, the meter moves. Block the mic in site settings and the how-to shows. Allow it and the screen flips to ✓ with no reload.

## Rep guide paragraph (for guides.gghomes.org; publishing is a separate, user-approved step)

> **If your phone resets.** Your admin can reset your softphone to fix sound problems. It waits until you're not on a call, then signs you out with "Your admin reset your phone. Sign in again to reconnect." Click **Sign in with Salesforce**, and a sound check opens.
>
> If Chrome asks, allow the microphone. Talk and watch the bar move. Pick your headset for Microphone and Speaker, press **Play test sound**, then click **Looks good**.
>
> If the screen says your microphone is blocked, click the icon just left of the address bar, set Microphone to **Allow**, and the screen updates by itself.
>
> You can run the check any time from **Settings → Run sound check**. **Settings → Reset my audio** puts your mic and speaker back to the default without signing you out.
