# Callsign for iPhone — Design

**Date:** 2026-09-02
**Product name (ruled):** **Callsign** — the CTI product and its iPhone app.
**Goal:** A native iPhone softphone for GG Homes reps on Mosyle-managed company
phones: inbound calls ring like real phone calls with the caller's Salesforce
name, outbound calls place through the existing firewall and number rotation,
every call wraps up into the same Salesforce Task/Chatter/recording pipeline,
and the caller record opens in the Salesforce mobile app in one tap.

## Decisions

| Question | Decision |
| --- | --- |
| Name | **Callsign** (bundle `com.gghomes.callsign`; the existing `com.gghomes.cti.callerid` app is absorbed, not kept alongside) |
| Where a record opens | **Salesforce mobile app, via deep link** (`salesforce1://sObject/<id>/view`); no in-app record UI in v1 |
| Voice path | **Native VoIP** — Twilio Voice iOS SDK in-app, CallKit for the system call UI, PushKit VoIP push for inbound wake-up |
| Auth | **Sign in with Salesforce** — the softphone's existing login flow, no pairing codes for the app itself |
| What stays server-side | Everything compliance-critical: firewall, rotation/sticky caller ID, calling-day/hour rules, recording + disclosure, Task/Chatter/recording-link sync. The app never decides any of it |
| Seed | Extend `apps/cti-ios` (SwiftUI, xcodegen `project.yml`, App Group `group.com.gghomes.cti`); keep its Call Directory extension |
| Distribution | Apple Business Manager **Custom App** → Mosyle silent install; Managed App Configuration for zero-touch setup (server URL); reps still sign in with Salesforce once |
| Out of scope (v1) | In-app power dialer, SMS, admin views, in-app record pages, Android |

## 1. Architecture

```
iPhone (Callsign)                          CTI API (Railway)                   Twilio
────────────────                           ─────────────────                   ──────
SignIn: ASWebAuthenticationSession ──────▶ /auth/salesforce/login/start
   poll /auth/salesforce/login/status ◀─── bearer session token
Voice token ────────────────────────────▶ /telephony/token?platform=ios
   (VoiceGrant + VoIP push credential) ◀──
PushKit VoIP register ──────────────────▶ /mobile/voip-token (new)
Inbound: VoIP push ◀─────────────────────────────────────────────────────── ring client rep_<userId>
   CallKit reportNewIncomingCall(name · type)   custom params callerName/recordId/recordType
Outbound: POST /calls ──────────────────▶ firewall → rotation → returns callId + from
   TwilioVoice.connect(To, callId) ─────────────────────────────────────────▶ /telephony/twilio/voice
Wrap-up: POST /calls/:id/disposition ───▶ Task + Chatter + recording link (unchanged)
Directory (extension): /mobile/caller-directory (unchanged; token now derived from the session)
```

The app is a thin client. The one genuinely new server capability is **VoIP
push**: Twilio delivers inbound rings to a backgrounded/locked iPhone only
through an APNs VoIP push credential registered on the access token.

## 2. Server changes (`services/cti-api`)

1. **`POST /telephony/token`** accepts `{ platform: 'ios' }` (body) and, for
   iOS, builds the `VoiceGrant` with `pushCredentialSid: cfg.TWILIO_IOS_PUSH_CREDENTIAL_SID`
   (new env var; the credential is created once in the Twilio console from the
   Apple VoIP Services certificate). Web callers are unchanged. Identity stays
   `rep_<userId>` on both platforms — Twilio rings every registered client with
   that identity, so a rep's web softphone and iPhone ring together and the
   first to answer wins (same behavior as two browser tabs today).
2. **`POST /mobile/voip-token`** — session-authenticated (bearer, not device
   token) — stores the PushKit token on `mobile_devices` (new column
   `voip_token`; `apns_token` stays for the deferred silent-push feature).
   Twilio itself does the push delivery given the credential; we store the
   token for device management and future direct pushes.
3. **Session-derived directory access:** the app is signed in, so
   `GET /mobile/caller-directory` also accepts the session bearer (in addition
   to the device token), creating/refreshing a `mobile_devices` row keyed to
   the session's user. Pairing codes remain for any legacy install.
4. **Inbound custom parameters** — already being shipped for the web softphone
   (`callerName`, `recordId`, `recordType` on `<Client>`); the app reads the
   same three. No further server change.
5. **Managed App Configuration contract:** the app reads
   `com.apple.configuration.managed` → `{ apiBaseUrl }`. Nothing else is
   pushed; sign-in stays interactive. (Per-user auto-pairing via MDM variables
   is a later enhancement.)

## 3. App (`apps/cti-ios` → target `Callsign`)

**Targets:** `Callsign` (app), `CallDirectory` (extension, unchanged logic),
`CallsignTests`. New capabilities: Push Notifications, Background Modes
(`voip`, `audio`, `fetch`), App Group (existing). SPM dependency:
`twilio-voice-ios` (Twilio Voice iOS SDK, latest 6.x).

**Screens (SwiftUI):**

- **Sign In** — one button: opens `ASWebAuthenticationSession` on the
  `authUrl` from `login/start`; polls `login/status` every 2s until
  `connected`; stores the bearer in the Keychain (same accessibility class as
  the existing device token). Managed config supplies the API base; a dev
  build allows overriding it.
- **Dial** (home) — keypad, recents (from `GET /calls?mine`), and a
  "Call from Salesforce" note: click-to-dial from the Salesforce app is v2; v1
  dials by keypad/recents. Tapping call → `POST /calls { toNumber }` →
  on `ALLOW`: `TwilioVoice.connect` with `To` + `callId`; on `BLOCK`/refusal:
  the server's `blockReason` shown verbatim (the same specific messages the
  web softphone now shows — day/hour/state/cap).
- **In-call card** (over CallKit's system UI when the app is foregrounded):
  caller name · record type · number · timer · mute / speaker / keypad /
  hang up · **Open in Salesforce** (deep link; hidden when no record).
- **Wrap-up** — presented after every **outbound** call; answered **inbound**
  calls auto-log server-side with no wrap-up, exactly like the web softphone
  (the server's pending-disposition sweep tracks outbound only —
  `findPendingDisposition` in `services/cti-api/src/routes/calls.ts` filters
  `direction = 'outbound'`). Disposition picker (same list the web softphone
  uses, fetched from `/auth/me`/campaign config), notes, Finish → `POST
  /calls/:id/disposition`. Skipping wrap-up leaves the call in
  `pending-disposition`, which the existing server sweep auto-dispositions —
  identical to the web — and until it does, the rep's next dial is refused
  with a 409 carrying that call, which reopens its wrap-up rather than
  reading as a dead end.
- **Recents** — last 50 calls with outcome, tap to redial or open record.
- **Settings/Status** — signed-in user, numbers assigned (count), Call
  Directory extension status + the existing deep link to enable it, sign out.

**Call engine (`CallController`, testable by injection):**

- Registers with Twilio on sign-in and on every app launch:
  `TwilioVoiceSDK.register(accessToken, deviceToken: pushKitToken)`.
- **Inbound:** PushKit `didReceiveIncomingPush` → `TwilioVoiceSDK.handleNotification`
  → `CXProvider.reportNewIncomingCall` **synchronously in the same callback**
  (iOS kills the app otherwise) with `CXCallUpdate.localizedCallerName =
  "\(callerName) · \(recordType)"` when present, else the formatted number;
  `remoteHandle` = the E.164. Answer via `CXAnswerCallAction` →
  `callInvite.accept`. Decline → `callInvite.reject` (server side then routes
  to voicemail exactly as today via the dial-result handler).
- **Outbound:** `CXStartCallAction` → `TwilioVoiceSDK.connect(options)` with
  `params: ["To": e164, "CallDbId": callId]` — the same parameters the web
  softphone sends to `/telephony/twilio/voice`, so the server-side TwiML path
  is untouched.
- Audio session handled through CallKit's `didActivate/didDeactivate`
  audio-session callbacks (Twilio's documented pattern).
- Token refresh: tokens are 1h; refresh on foreground and when the SDK
  reports `tokenExpired`; re-register on refresh.

**Caller Directory extension:** unchanged behavior; its sync engine takes the
session bearer instead of a pairing token via the new server acceptance.

## 4. Data flow guarantees

- The app never sees a Twilio credential beyond a 1-hour access token.
- Every outbound dial is a `POST /calls` first — a refused call never
  reaches Twilio, so calling-day/hour, state, frequency-cap, and reputation
  gates apply identically to iPhone and web.
- Inbound answering on the iPhone produces the same `calls` row, dial-result
  callback, recording, and Task sync as answering on the web — the server
  cannot tell which client picked up. That row is the server's own, and the
  server logs it: the phone shows no inbound wrap-up and posts no inbound
  disposition, matching the web softphone exactly.

## 5. Distribution and setup

1. App Store Connect: new app record **Callsign** under the SJO Investments
   team (`CCY3R86SMX`); VoIP Services certificate → Twilio Push Credential.
2. Distribute as a **Custom App** to the GG Homes Apple Business Manager org.
3. Mosyle: license from Apps & Books; auto-install to the reps' device group;
   Managed App Configuration `{ "apiBaseUrl": "https://ctiapi-production.up.railway.app" }`.
4. Rep's first run: sign in with Salesforce, allow microphone + notifications,
   flip the Call Directory toggle once (Apple does not allow MDM to do this).

## 6. Testing

- **Unit (host-free, like the existing tests):** sign-in poller state
  machine; token refresh scheduling; `CallController` state transitions with
  injected fake SDK/CallKit; custom-parameter parsing (name/type/number
  fallbacks); deep-link URL builder; block-reason rendering; wrap-up
  submission payload.
- **Server:** token route iOS branch includes `pushCredentialSid`;
  `/mobile/voip-token` auth + persistence; caller-directory session-bearer
  acceptance; existing suites unchanged.
- **Device (manual, TestFlight internal):** inbound ring on locked phone with
  name; answer/decline; outbound through firewall incl. a refused call;
  wrap-up → Task appears; Open in Salesforce lands on the record; web + iPhone
  ringing together, first answer wins; recording link lands on the Task.

## Out of scope

In-app power dialer, SMS, admin/reputation views, in-app record pages, Android,
per-user MDM auto-pairing, silent-push directory refresh (still deferred).
