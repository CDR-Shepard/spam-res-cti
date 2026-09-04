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

- Recents rows show the raw dialed string for outbound calls; the server does
  not return a normalized E.164 in the recent-calls feed.
- The voice-token seam on `CallController` is synchronous, so a dial racing the
  very first token mint fails after `POST /calls` already created a row.
- The in-call speaker button does not observe `AVAudioSession.routeChangeNotification`,
  so switching to AirPods mid-call leaves the toggle stale.
- `.dialing` cannot be cancelled from the app's own UI; CallKit's End works
  once ringback starts.
- Operator scripts exclude the per-tenant "AI Agent" service user by email
  pattern; tighten to `kind = 'human'` now that `0036_tenancy` is applied.
