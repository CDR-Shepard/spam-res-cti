# Callsign (iOS)

The rep's iPhone half of the caller-ID feature. It pairs with the CTI API,
pulls the org's caller directory, and hands it to iOS as a **Call Directory
extension** so an incoming call from a lead in the CRM shows "Lead: Jane Doe"
instead of an unknown number.

Two targets plus a test bundle:

| Target | Bundle id | What it does |
| --- | --- | --- |
| `Callsign` (app) | `com.gghomes.callsign` | Pairing, syncing, status UI |
| `CallDirectory` (extension) | `com.gghomes.callsign.directory` | Streams the snapshot to CallKit |
| `CallsignTests` | — | Logic tests (paging, store, sync engine) |

They share the App Group `group.com.gghomes.cti`. iOS 17 minimum, SwiftUI, one
third-party dependency: the Twilio Voice iOS SDK (SPM, product `TwilioVoice`),
used by the app target only — the Call Directory extension still has none.

## Building

The `.xcodeproj` is **generated, not committed** — so are the `Info.plist` and
`.entitlements` files next to the sources. `project.yml` is the single source
of truth; regenerate after cloning, after editing `project.yml`, and after
adding or removing a source file:

```sh
brew install xcodegen        # once
cd apps/cti-ios
xcodegen generate            # writes Callsign.xcodeproj + the plists
open Callsign.xcodeproj
```

## Tests

```sh
# Everything: builds the app + extension, then runs the tests.
xcodebuild test -project Callsign.xcodeproj -scheme Callsign \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

# Fast inner loop: the logic tests alone, no app build.
xcodebuild test -project Callsign.xcodeproj -scheme CallsignTests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

The tests are host-free on purpose. Everything under test takes its
collaborators by injection — paging over a transport, the store over a
container URL, and `SyncEngine` over a token store, a pull, and CallKit — so
they need neither a network, nor the Keychain, nor a provisioned App Group on
the simulator. `SyncEngineTests` is what keeps the engine's own inventions
honest: the reload is retried after CallKit refuses it (and not repeated once
it sticks), a second sync is absorbed while one is in flight, and a 401 unpairs
the phone with a reason `PairView` can show.

`CallControllerTests` covers the softphone's own state machine the same way —
the Twilio SDK, CallKit and the calls API are all protocols, so a whole call
runs in microseconds with no simulator permissions. What it exists to prove is
that **the phone never dials on its own judgement**: every outbound path runs
the server's pre-call firewall audit first, and a BLOCK, an unacknowledged
REQUIRE_REVIEW, a refusal or a thrown error all leave `connect` untouched and a
reason on screen.

## How a phone gets a directory

1. **Pair.** The rep opens the softphone, chooses "Pair iPhone", and reads a
   6-digit code. The app posts it to `POST /mobile/pair/claim` and stores the
   returned device token in the **Keychain**
   (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: a background refresh
   still works on a locked phone, and the token never travels in a backup or
   onto a restored handset). The extension never reads the Keychain.
2. **Sync.** `SyncEngine` calls `GET /mobile/caller-directory?since=<version>`.
   `unchanged` ends it there; otherwise `fetchAll` walks pages 1..pageCount.
3. **Store.** `DirectoryStore` writes one **binary** snapshot
   (`caller-directory.bin`) into the App Group container — temp file, then
   rename — so a reader only ever opens a whole snapshot.
4. **Reload.** `CXCallDirectoryManager.reloadExtension(withIdentifier:)` asks
   iOS to run the extension, which streams the snapshot back to CallKit.

### The snapshot format

Little-endian throughout. A 20-byte header — magic `CTID`, `formatVersion`
`UInt32`, `directoryVersion` `Int64`, `entryCount` `UInt32` — then exactly
`entryCount` records, strictly ascending by number and deduped: `number`
`Int64`, `labelLen` `UInt16`, `labelLen` bytes of UTF-8. No footer; anything
after the last record is corruption.

It is binary so the extension can **stream** it. The previous JSON snapshot had
to be decoded whole before the first entry could be published — about 0.5 KB of
footprint per entry against an app extension's ~12 MB budget — which is where
the old 15,000-entry cap came from, and that cap kept the ascending-*lowest*
numbers, i.e. mostly not the ones reps get called from. Reading splits in two:

- `loadHeader()` reads 20 bytes and nothing else. It is all the app and
  `StatusView` ever wanted (version, entry count), whatever the directory's
  size.
- `streamEntries` parses in 64 KiB chunks and yields one record at a time,
  never materializing an entry array. Measured `phys_footprint` over baseline:
  **0.42 MB at 150,000 entries, 0.39 MB at 250,000** — flat in entry count.

Each chunk read runs inside its own `autoreleasepool`. That is load-bearing,
not tidiness: `FileHandle.read(upToCount:)` returns autoreleased-backed `Data`,
nothing drains the extension's pool until `beginRequest` returns, and without
the pool every chunk stays live — 9.94 MB at 250,000 entries, i.e. the whole
budget, with tests passing regardless.

Anything the parser cannot vouch for throws a `DirectoryStoreError` (bad magic,
unknown format version, truncated record, a `labelLen` past EOF, a label that
is not UTF-8, a non-ascending number, a record count that disagrees with the
header, trailing bytes) and the extension cancels the request.

Sync runs on foreground appear, on the **Refresh now** button, on pull to
refresh, and from a `BGAppRefreshTask`
(`com.gghomes.callsign.refresh`, declared in
`BGTaskSchedulerPermittedIdentifiers`; `fetch` is one of the app's background
modes, alongside `voip`/`audio` for the softphone).

The rep must switch the extension on once, by hand:
**Settings → Phone → Call Blocking & Identification → Callsign** on iOS 17
(the deployment target), or **Settings → Apps → Phone → Call Blocking &
Identification** on iOS 18 and later, which moved the per-app settings under
"Apps". `StatusView` names both and deep-links there.

## Two rules that are easy to get wrong

**The feed version can move mid-pagination.** The server re-reads the latest
version on every request, so page 1 can come back at v3 and page 2 at v4.
Stitching those together publishes half of one directory and half of another,
with no way to tell. `fetchAll` therefore compares every page's `version` and
restarts the whole fetch from page 1 when it changes — at most
`maxFeedFetchRestarts` times, then it throws `FeedError.versionUnstable`.
`FeedTests.testVersionChangeMidPaginationRestartsTheWholeFetch` pins it.

**CallKit demands strictly ascending numbers.** `CXCallDirectoryPhoneNumber` is
the e164's digits as an `Int64` (`+16195550100` → `16195550100`), and ordering
is by that number — never by the e164 text, which stops tracking magnitude the
moment two numbers differ in digit count. The server already sorts this way;
`DirectoryStore` sorts defensively anyway, drops rows with no usable number or
a number an earlier row already used, and checks the order again on the way
out — `streamEntries` throws the moment a number fails to exceed its
predecessor. A snapshot that is missing, corrupt, or out of order makes the
extension `cancelRequest(withError:)` rather than publish a partial directory
over a good one.

## The softphone's live parts

`LiveVoiceSDK`, `LiveCallSystem` and `PushRegistry` are the adapters behind
`CallController`'s protocols. Almost all of what they do is translation, and
what is left is about *ordering*, because two deadlines run through them:

**A VoIP push must produce a CallKit report before the delegate method
returns.** iOS terminates an app that does not, and eventually revokes its VoIP
entitlement — so `pushRegistry(_:didReceiveIncomingPushWith:for:completion:)`
runs the whole chain on its own stack: `CallController.handleIncomingPush` →
`LiveVoiceSDK.handleIncomingPush` (`TwilioVoiceSDK.handleNotification`, which
Twilio's own header documents as calling the delegate "synchronously on the
same dispatch queue") → `CallSystem.reportIncoming`
(`CXProvider.reportNewIncomingCall`) → `completion()`. Nothing on that path
awaits anything. When the payload is a `twilio.voice.call` and no ring results
anyway — the phone was already on a call, or the SDK produced no invite —
`PushRegistry` reports it as a missed call rather than letting the app be
killed. A `twilio.voice.cancel` deliberately does not: there is no ring to
report, only one to end.

**A caller who gives up does not arrive by push.** The obvious route — handling
that `twilio.voice.cancel` payload — is dead in the SDK this app ships:
`TwilioVoice.h` lists the Insights event `unsupported-cancel-message-error`,
"This version of the SDK does not support 'cancel' push notifications". The live
signal is the SDK's own out-of-band `cancelledCallInviteReceived:error:`, which
only fires if the invite is still retained ("the TVOCallInvite must be retained
until the call is accepted or rejected") — hence
`LiveVoiceSDK.outstandingInvites`. It carries a call SID and no UUID, and
`CallController` keeps its invite private, so `shouldDeclineCancelledInvite`
makes the match, and refuses to guess whenever two invites are outstanding:
declining the wrong one drops a live conversation, while missing a cancellation
costs a ring that stops by itself.

**CallKit owns the audio session, not Twilio.** `TVODefaultAudioDevice` ships
`enabled` and "activates the audio session while connecting to a Call", which
would put the session up before CallKit has decided the call may be heard. So
`LiveCallSystem` takes the SDK's own device, disables it at construction —
before anything can connect — and drives it purely from
`didActivate`/`didDeactivate`. The one exception is a refused
`CXStartCallAction`: no activation is coming, so the app enables the device
itself rather than leave the rep on a call that is silent both ways.

**An outbound call returns at ringback, not at answer.** The server dials with
`answerOnBridge: true`, so `callDidConnect` does not arrive until the callee
picks up. Waiting for it would park the whole ringback inside `sdk.connect`:
no `ActiveCall`, so no CallKit call and no way to give up on a phone that rings
out. `ConnectGate` lets `callDidStartRinging` answer the connect instead —
whichever of ringing/connect/failure lands first, exactly once — and everything
after it is routed onward to the disconnect latch. CallKit gets
`startedConnectingAt` then, and `connectedAt` when the callee really answers, so
the call timer measures the conversation rather than the ringing.

**A call can end before anyone is listening for the end.** `CallController`
attaches `onDisconnect` after the SDK hands the call back, and an outbound leg
can die inside that gap. `DisconnectLatch` remembers the end and replays it on
attach — once, and once only. Without it the app sits in `.active` on dead
media, the rep gets no wrap-up, and their next dial is refused by the server's
disposition gate with nothing on screen to explain it.

The Twilio access token is minted by `VoiceTokenRefresher` and reused until it
has less than five minutes left. `CallController.tokens` is synchronous by
design — nothing may await between the server's "allowed" and `sdk.connect` —
so a dial reads the cached token, and `VoiceRuntime` keeps that cache warm at
launch and on every foreground (which is also when the Twilio VoIP
registration, which expires with the token that made it, is renewed).

VoIP push can only be exercised on a real device. The simulator builds and runs
everything else.

## Not here yet

Silent push for directory updates (`POST /mobile/apns-token`) is a deferred
fast-follow: nothing posts an APNs token, and directory updates still arrive on
the next foreground or background refresh. The **VoIP** push token
(`POST /mobile/voip-token`) is posted — that is what makes the phone ring.
