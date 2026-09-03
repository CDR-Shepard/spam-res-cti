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

They share the App Group `group.com.gghomes.cti`. iOS 17 minimum, SwiftUI, no
third-party dependencies.

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

## Not here yet

Silent push (`POST /mobile/apns-token`) is a deferred fast-follow: the app
registers **no** push entitlement and no push handler, and does not post a
token. Directory updates arrive on the next foreground or background refresh.
