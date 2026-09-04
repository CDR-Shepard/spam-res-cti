# Callsign iOS: release runbook

## What this is

`apps/cti-ios` (targets `Callsign` / `CallDirectory`, bundle ids
`com.gghomes.callsign` / `com.gghomes.callsign.directory`, App Group
`group.com.gghomes.cti`) is the rep's iPhone half of caller ID **and** a
native softphone: sign in with Salesforce, pull the org's caller directory
into a Call Directory extension, dial and receive calls via a VoIP push +
CallKit, all gated by the same pre-call firewall audit the web softphone
uses. See `apps/cti-ios/README.md` for the app's architecture — this is the
ship-it process, not a rewrite of that doc.

This supersedes `docs/runbooks/caller-id-app.md` in spirit (that runbook
documents the earlier `CTICallerID`/`com.gghomes.cti.callerid` naming, before
the app grew a softphone and was renamed). It is left in place for its
history and its still-accurate Apple-portal mechanics (App Group,
provisioning-profile gotchas, ITMS validation errors); this runbook is the
one to follow going forward.

Both `services/cti-api/migrations/` (currently the API's migrations
directory — a parallel branch, `feat/outreach-foundation`, is moving this to
`packages/db/migrations/`) and `services/cti-api/src/db/schema.ts` are
referenced below by their current location; check which layout has landed
before assuming the path.

---

## 1. Apple Developer setup (one-time, or when adding a capability)

1. **App IDs.** Under **Certificates, Identifiers & Profiles → Identifiers**,
   confirm both exist (they should already, since builds have shipped under
   the prior name — see `docs/runbooks/caller-id-app.md` §1):
   - `com.gghomes.callsign` — capabilities **Push Notifications** and **App
     Groups**, with `group.com.gghomes.cti` enabled.
   - `com.gghomes.callsign.directory` — capability **App Groups**, same
     group.
2. **VoIP Services certificate.** Under the `com.gghomes.callsign` App ID's
   capabilities, open **Push Notifications** and generate a **VoIP Services
   Certificate** (not a plain APNs certificate — VoIP push uses PushKit, a
   distinct certificate type from ordinary remote push). Download it, import
   into Keychain Access, and export a `.p12` (with a password) — Twilio's
   Push Credential in step 2 below is created from this `.p12`.

## 2. Twilio Push Credential (VoIP)

1. Twilio Console → **Voice → Manage → Push Credentials** (the brief for this
   work also names it Console → Credentials → Push Credentials; both land on
   the same Push Credentials list) → **Create new Push Credential**.
2. **Type: VoIP (APNs)** — deliberately **not** the plain "APNs" credential
   type. Twilio's Voice SDK delivers incoming-call notifications over
   PushKit, which only a VoIP-type push credential can sign.
3. Upload the `.p12` from step 1.1 and its password.
4. **Sandbox: OFF.** Sandbox APNs only reaches apps built with a development
   provisioning profile; TestFlight and App Store builds use production
   APNs, so a sandbox credential silently fails to ring a rep's phone with no
   error surfaced anywhere in this app. Toggle it off for any credential used
   by a TestFlight or App Store build.
5. Copy the credential SID (`CR…`).
6. Set it on the server — **never paste the value in chat, a commit message,
   or a log line**:
   ```bash
   railway link          # pick project endearing-comfort if not already linked
   railway variables --set "TWILIO_IOS_PUSH_CREDENTIAL_SID=CR..." --service @cti/api
   ```
7. Redeploy `@cti/api` (Railway redeploys on variable changes for a linked
   service; if it doesn't, trigger one explicitly). Until this variable is
   set, `POST /telephony/token` with `{"platform":"ios"}` returns 503 with
   `TWILIO_IOS_PUSH_CREDENTIAL_SID is not configured — iOS clients cannot
   register for VoIP push` (`services/cti-api/src/telephony/twilio.ts`) — the
   web softphone (`platform` omitted or `"web"`) is unaffected either way.

## 3. App Store Connect

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps**
   → check whether an app for `com.gghomes.callsign` already exists (it may,
   under the prior name/bundle id if that migration hasn't happened — see
   `docs/runbooks/caller-id-app.md` §1 step 10 for the "create it before your
   first archive" gotcha). If not: **+ → New App**, platform iOS, name
   **Callsign**, bundle id `com.gghomes.callsign`, any unique SKU, full
   access.
2. Provisioning profiles, matching `project.yml`'s
   `PROVISIONING_PROFILE_SPECIFIER` settings exactly:
   - `Callsign AppStore` for the `Callsign` app target.
   - `Callsign Directory AppStore` for the `CallDirectory` extension target.

   Both **App Store** distribution profiles, both under the
   `CCY3R86SMX` team, installed under
   `~/Library/Developer/Xcode/UserData/Provisioning Profiles`.
3. **Bump the version before you archive.** In `apps/cti-ios/project.yml`,
   under `settings.base`:
   - `CURRENT_PROJECT_VERSION` — the build number. **Every upload needs a new
     one**; App Store Connect rejects a build number it has already seen, and
     there is no way to reuse one.
   - `MARKETING_VERSION` — the version reps see. Bump it for a user-visible
     release; leave it alone for another build of the same release.

   Both are project-level settings, so the app and the extension always get
   the same pair — which they must, or the upload is rejected for a version
   mismatch between a host and its extension. The two `info.properties` blocks
   reference them as `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`;
   nothing else in the project hardcodes a version.
4. Regenerate and archive:
   ```bash
   cd apps/cti-ios
   xcodegen generate
   xcodebuild archive -project Callsign.xcodeproj -scheme Callsign \
     -destination 'generic/platform=iOS' -archivePath build/Callsign.xcarchive
   ```
   Confirm the bump actually landed — the generated plists hold the *variables*,
   so the only honest check is the built product:
   ```bash
   plutil -p build/Callsign.xcarchive/Products/Applications/Callsign.app/Info.plist \
     | grep -E 'CFBundleShortVersionString|CFBundleVersion'
   plutil -p build/Callsign.xcarchive/Products/Applications/Callsign.app/PlugIns/CallDirectory.appex/Info.plist \
     | grep -E 'CFBundleShortVersionString|CFBundleVersion'
   ```
   Both must show the numbers you just set, and must match each other.
5. **Before uploading**, verify both binaries carry the App Group
   entitlement — an archive that gets re-signed at export without it loses
   the App Group silently and the extension can never read the directory:
   ```bash
   codesign -d --entitlements :- build/Callsign.xcarchive/Products/Applications/Callsign.app
   codesign -d --entitlements :- build/Callsign.xcarchive/Products/Applications/Callsign.app/PlugIns/CallDirectory.appex
   ```
   Both must show `com.apple.security.application-groups` containing
   `group.com.gghomes.cti`.
6. Upload (CLI, or Xcode Organizer → Distribute App → App Store Connect →
   Upload — see `docs/runbooks/caller-id-app.md` §1 for the step-by-step GUI
   flow, which still applies once the team has at least one registered
   device; without one, use `xcodebuild -exportArchive`).
7. First upload only: TestFlight asks an **Export Compliance** question —
   this app makes plain HTTPS calls and uses the Twilio Voice SDK's standard
   TLS signaling, no custom cryptography, so answer standard/exempt
   encryption.
8. **TestFlight → Internal Testing** — add the app's internal testing group
   first (reuse the existing group from `docs/runbooks/caller-id-app.md` §1
   step 19 if it already has the right roster, or create one), attach the
   processed build, and confirm testers receive the update notification.

## 4. Distribution (org-wide rollout)

1. App Store Connect → the app → **Pricing and Availability** → set
   distribution to **Custom App**, restricted to the GG Homes Apple Business
   Manager organization (not the public App Store).
2. Mosyle (or whichever MDM currently manages the fleet) → **Apps & Books** →
   license the app from Apple Business Manager → assign it to the reps'
   device group for auto-install.
3. **Retire the old caller-ID app, in the same rollout.**
   `com.gghomes.cti.callerid` (the pre-rename `CTICallerID` build — see
   `docs/runbooks/caller-id-app.md`) is a *different* bundle id, so Callsign
   installs **alongside** it rather than replacing it. Leaving both on a
   handset means two Call Directory extensions publishing overlapping numbers
   — iOS shows whichever it likes, and a rep who sees a stale name has no way
   to tell which app supplied it — plus two apps syncing the same directory on
   the same schedule, and two device tokens on the same rep's list.
   - Mosyle → **Apps & Books** → `com.gghomes.cti.callerid` → **unassign** it
     from the reps' device group and **remove** the app (choose the option
     that deletes it from the device, not just the assignment; an unassigned
     app that stays installed keeps its extension registered).
   - Revoke the old app's device tokens so its rows stop being valid bearers
     for the org's caller directory: the softphone's admin device list, or
     `DELETE /mobile/devices/:id` per row. A revoked device token 401s the
     feed, which is what makes the old app unpair itself if it is still on a
     handset somewhere.
   - Sequence it so Callsign is installed and signed in **first**: removing
     the old app wipes its directory, and a gap where a rep has neither app
     means unidentified inbound calls.
4. Push **Managed App Configuration** to that device group so
   `AppConfig.resolveBaseURL(managed:)` (`apps/cti-ios/Shared/AppConfig.swift`)
   picks it up instead of the built-in production default:
   ```json
   { "apiBaseUrl": "https://ctiapi-production.up.railway.app" }
   ```
   This is normally a no-op (it matches the app's own compiled-in default)
   — it exists so a staging build or a future region can be pointed
   elsewhere without a new build. The value must be an `https://` URL with a
   host; anything else is ignored and the app falls back to the production
   default.

## 5. Rep first run

1. Install from the Mosyle-pushed app icon (or the TestFlight invite for a
   pre-rollout build).
2. Open the app. First launch shows the **sign-in screen** — tap to sign in,
   which opens a Salesforce login page in an in-app browser
   (`ASWebAuthenticationSession`). Log in with the rep's normal Salesforce
   credentials. The app lands on the **Dial** tab once sign-in completes and
   the softphone finishes starting — no prompt of any kind appears at this
   point.
3. **On the first call** (placed or received), iOS asks for **microphone**
   access — tap **Allow**. If it's denied (by mistake, or by a prior "Don't
   Allow"), the call connects with no audio in either direction; fix it at
   **Settings → Callsign → Microphone**. No notification permission is ever
   requested: incoming calls arrive through a silent VoIP push and CallKit,
   which need no user-facing permission to work.
4. Turn the Call Directory extension on — the one manual step iOS requires
   and there is no way around it: **Settings → Phone → Call Blocking &
   Identification → Callsign** (iOS 17, this app's deployment target), or
   **Settings → Apps → Phone → Call Blocking & Identification** on iOS 18
   and later (iOS 18 moved per-app settings under "Apps"). `StatusView`'s
   **Open Phone settings** button deep-links here directly.
5. Back in the app's **Status** tab, "Caller ID" should read **On** — tap
   **Refresh now** if it hasn't caught up.

## 6. Manual device checklist (TestFlight, one phone)

Run all of these on a real iPhone — the Simulator has no real Phone app /
CallKit incoming-call UI, so it cannot show most of this (see
`docs/runbooks/caller-id-app.md` §5 for exactly what the Simulator can and
can't verify; the same split applies here).

- [ ] Inbound ring on a **locked** phone shows "Name · Lead" (the custom
      parameters attached to the inbound `<Client>` dial).
- [ ] **On the very first call this install ever handles**, the iOS
      microphone prompt appears and tapping **Allow** works — audio flows
      both ways afterward. Separately, on a phone/build where the microphone
      permission was previously **denied**, confirm the call still connects
      (silently, with no audio) and that **Settings → Callsign → Microphone**
      is the fix, matching runbook §5.3.
- [ ] Answer → talk → hang up → audio flowed both ways and the Task appears in
      Salesforce (auto-logged, **no wrap-up**). An answered inbound call is
      logged server-side; the phone deliberately shows no disposition screen
      for it, exactly as the web softphone doesn't.
- [ ] Decline → the caller reaches voicemail (the no-answer forward path).
- [ ] Outbound **allowed** call connects and the far end sees the rotated
      caller ID.
- [ ] Outbound **refused** call — dial a Florida lead already at 3 calls in
      24h, or any number outside calling hours — shows the server's refusal
      message on the Dial screen and the phone never rings out.
- [ ] **Acknowledge & Dial** on a REQUIRE_REVIEW number (a 412 response)
      creates the call with `acknowledged: true` and it actually dials —
      confirm in the calls table or the resulting Salesforce Task that the
      audit shows the acknowledgement, not a fresh unacknowledged attempt.
- [ ] Wrap-up creates the Salesforce Task with disposition + a Chatter post +
      the recording link once it's ready.
- [ ] **Skip a wrap-up, then dial again** — the dial is refused by the server's
      disposition gate and the phone reopens *that* call's wrap-up (not an
      error message); saving it lets the next dial through. Tapping the Dial
      screen's orange "Finish your last call" banner does the same thing
      without needing the refusal first.
- [ ] **Open in Salesforce** (Recents row / in-call screen) lands on the
      correct Lead/Opportunity/Deal record in the Salesforce mobile app.
- [ ] Web softphone and iPhone ring together for the same inbound call, and
      whichever answers first wins — the other stops ringing.
- [ ] Token refresh survives an hour idle (leave the app backgrounded ~60
      minutes, then place a call — it should connect without a fresh
      sign-in).
- [ ] **Force-quit Callsign (swipe it away), then call the phone → it rings.**
      This is the cold-launch VoIP push: PushKit is armed in
      `application(_:didFinishLaunchingWithOptions:)`, so iOS launches the app
      and delivers the push. If it shows only a *missed* call instead of
      ringing, the push arrived before the softphone attached — still correct
      (iOS requires a CallKit report either way), but worth noting on the
      build.
- [ ] **Reboot the phone and, BEFORE unlocking it once, call it.** Expect a missed-call entry, not a ring: the session token is Keychain `AfterFirstUnlockThisDeviceOnly`, so the app cannot attach the voice runtime until the first unlock and reports the push as a missed call (by design — do not file this as the cold-launch race). Unlock once, call again → it rings.
- [ ] **Sign out on the phone → the web softphone still works.** Sign out
      revokes this phone's `mobile_devices` row (`DELETE /mobile/devices/:id`),
      unregisters the handset from Twilio, and clears its session; it must not
      touch the rep's other sessions or devices. Confirm in the softphone's
      admin device list that this phone's row is gone and the rep's other
      devices are not.
- [ ] **Sign back in → inbound rings again** on this phone (confirms the
      VoIP registration re-establishes cleanly after a sign-out/sign-in
      cycle, not just after a fresh install).
- [ ] Outbound: **ringback audio is heard** while the far end rings — it may
      start a beat after the callee's own phone begins ringing (that's
      normal SDK/CallKit latency); **silence until answer is NOT** — that
      indicates the ringback path is broken.
- [ ] Caller hangs up while the iPhone is **still ringing** (inbound) → the
      CallKit ring stops within about 2 seconds (the cancel arrives via the
      SDK's `cancelledCallInviteReceived:error:` callback, not a push).

## 7. Known gaps / follow-ups

These are accepted, documented limitations as of this release — not bugs to
chase before shipping:

- **Speaker button doesn't track route changes.** It does not observe
  `AVAudioSession.routeChangeNotification`, so if AirPods connect or
  disconnect mid-call, the on-screen speaker state can go stale (shows a
  state that no longer matches the actual output route).
- **Outbound Recents rows show the raw typed number** until the recent-calls
  API returns `toNumberE164` — a follow-up chip has been filed for this.
- **The voice-token seam is synchronous by design**
  (`CallController.tokens`, so nothing may `await` between the server's
  "allowed" verdict and `sdk.connect`) — a chip has been filed to track
  whether this constraint holds up as the token-refresh path evolves.
- **Per-user device-token cap + session-revoke cascade** — nothing currently
  limits how many devices one rep can register, and revoking a Salesforce
  session does not cascade to revoke that rep's mobile device tokens. Signing
  out on the phone now revokes *that* phone's row (`DELETE
  /mobile/devices/:id`, best effort — a sign-out with no network still signs
  the handset out locally and leaves the row for the admin device list), so
  rows no longer accumulate one per sign-in; the cap and the cascade are still
  open. Filed as a follow-up chip.
- **No server-side session logout.** `revokeSession` exists in
  `services/cti-api/src/auth/session.ts` but no route reaches it, so signing
  out destroys the session token locally and leaves the row to expire on its
  own 30-day clock. Adding the route is a server change this wave did not make.
- **`.dialing` is not cancellable from the app's own UI** — once a rep places
  a call, they can't abort it from the app before ringback starts; CallKit's
  own end-call control works once ringback has begun. Filed as a follow-up
  chip.
- **`App.tsx` render test** — a follow-up chip has been filed for the
  cti-web side of this work (not the iOS app itself).
- **Silent push for directory updates is still not built**
  (`POST /mobile/apns-token` exists server-side but nothing calls it) — see
  `docs/runbooks/caller-id-app.md` §6. Directory updates arrive on the next
  foreground open or the periodic background refresh, same as before this
  app grew a softphone.

## 8. If the SDK pin needs to move

`apps/cti-ios/project.yml` pins the Twilio Voice SPM package with
`exactVersion: "6.13.7"` rather than a `from:` floor — this is the version
the ~275-case test suite and the manual device checklist in §6 were
validated against. Bumping it is a deliberate action, not something that
should happen as a side effect of a routine `xcodegen generate` /
dependency-resolution run:

1. Change the `exactVersion` in `project.yml`.
2. `cd apps/cti-ios && xcodegen generate`.
3. `xcodebuild build -project Callsign.xcodeproj -scheme Callsign -destination 'platform=iOS Simulator,name=iPhone 17 Pro'` and the full test suite (`xcodebuild test`, same destination) must pass.
4. Re-run the §6 manual device checklist on a real phone before shipping —
   Twilio Voice SDK upgrades have changed VoIP push and CallKit behavior in
   the past, and none of that surfaces in the Simulator.
