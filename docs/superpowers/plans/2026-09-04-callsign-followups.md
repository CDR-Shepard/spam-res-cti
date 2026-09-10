# Callsign / CTI — open follow-ups

Tracked items left deliberately unbuilt, each with the reasoning that deferred
it. Grep for `FOLLOW-UP(callsign-followups)` to find the code that points here.

## 1. No way to deactivate a user (BLOCKS the offboarding cascade)

**Gap.** Nothing in this codebase deactivates, disables or removes a *user*.
There is no admin route for it and `users` has no active/status column; the
only suspension that exists is org-level (`organizations.status`, enforced by
`SuspendedTenantError` in `packages/auth/src/session.ts`).

**Why it matters.** A departing rep keeps a valid Salesforce session for up to
30 days, and their phone keeps a device token that never expires at all. That
token reads the org's whole caller directory — lead names and phone numbers.
Today the only remedy is revoking each device by hand from the softphone's
device list.

**Already built, waiting for a caller** (both exported, unit-tested, and
deliberately NOT wired, because inventing an admin route was out of scope):
- `revokeDevicesForDeactivatedUser(userId)` — `services/cti-api/src/routes/mobile.ts`
- `revokeAllSessionsForUser(userId)` — `packages/auth/src/session.ts`

**To close it:** add the deactivation concept (a `users` status column plus an
admin route, or hang it off the org-level suspension path), and call both
functions from it. Routine web-softphone logout must NOT cascade — see the
comment on `revokeDevicesForDeactivatedUser`.

## 2. Smaller Callsign items

- The in-call speaker button does not observe `AVAudioSession.routeChangeNotification`,
  so switching to AirPods mid-call leaves the toggle stale.
- `.dialing` cannot be cancelled from the app's own UI; CallKit's End works
  once ringback starts.
- Operator scripts exclude the per-tenant "AI Agent" service user by email
  pattern; tighten to `kind = 'human'` now that `0036_tenancy` is applied.
- Power dialer (spec 2026-09-10 §Out of scope): batched phone resolution so a
  200-record list reaches the confirm block in seconds — `create-session.ts`
  `resolveRows` awaits `resolveDialNumber` one record at a time.
- Power dialer: a per-record outcome list during and after a run (the panel
  shows only the tally from `missBreakdown`).
- Power dialer: retry policy by miss type — skip the 5-minute attempt-2 retry
  after a `voicemail`; today every miss retries the same way.
- Power dialer: a rep who closes the tab at the confirm block leaves a `ready`
  session behind forever. Harmless (it can never dial; nothing polls it) but
  worth a reaper (stop `ready` sessions older than a day) once real runs exist.
- Power dialer: the current-record card never shows a miss reason — the
  server's `currentItem` is `inFlightItem` (dialing/connected only), so
  `itemStatusLabel`'s Voicemail / No answer / Busy / Bad number labels are
  reachable only through the miss line. Return the last settled item alongside
  the in-flight one, or ship the per-record list above.
- Power dialer: a failed FIRST originate surfaces as a 500 from
  `POST /dialer/sessions/:id/start` with the session already `active`; the run
  screen then shows nothing in flight and a pinned "Could not start the run."
  until the rep presses Pause → Resume (or Start again, which re-advances).
  Add a Retry affordance and clear `controlError` when the session status
  changes.
- Power dialer: no route-level test covers `POST /dialer/sessions/:id/start`
  (403 without the grant, 409 on a second active run) — `routes/dialer.test.ts`
  has no Fastify inject harness; borrow the one in `routes/admin-team.test.ts`.
- Power dialer: `apps/cti-web/src/components/DialerPanel.tsx` is ~710 lines;
  the pure helpers (`queueParts`, `confirmLine`, `missLine`, `itemStatusLabel`,
  `startDialingSequence`, `isStartRefused`) belong in a sibling
  `dialer-lines.ts`.
