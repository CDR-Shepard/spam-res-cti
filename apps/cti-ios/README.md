# CTI Caller ID (iOS)

The rep's iPhone half of the caller-ID feature. It pairs with the CTI API,
pulls the org's caller directory, and hands it to iOS as a **Call Directory
extension** so an incoming call from a lead in the CRM shows "Lead: Jane Doe"
instead of an unknown number.

Two targets plus a test bundle:

| Target | Bundle id | What it does |
| --- | --- | --- |
| `CTICallerID` (app) | `com.gghomes.cti.callerid` | Pairing, syncing, status UI |
| `CallDirectory` (extension) | `com.gghomes.cti.callerid.directory` | Streams the snapshot to CallKit |
| `CTICallerIDTests` | — | Logic tests (paging, store, sync engine) |

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
xcodegen generate            # writes CTICallerID.xcodeproj + the plists
open CTICallerID.xcodeproj
```

## Tests

```sh
# Everything: builds the app + extension, then runs the tests.
xcodebuild test -project CTICallerID.xcodeproj -scheme CTICallerID \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

# Fast inner loop: the logic tests alone, no app build.
xcodebuild test -project CTICallerID.xcodeproj -scheme CTICallerIDTests \
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
   (`kSecAttrAccessibleAfterFirstUnlock`, so a background refresh still works
   on a locked phone). The extension never reads the Keychain.
2. **Sync.** `SyncEngine` calls `GET /mobile/caller-directory?since=<version>`.
   `unchanged` ends it there; otherwise `fetchAll` walks pages 1..pageCount.
3. **Store.** `DirectoryStore` writes one JSON snapshot into the App Group
   container — temp file, then rename — so a reader only ever opens a whole
   snapshot.
4. **Reload.** `CXCallDirectoryManager.reloadExtension(withIdentifier:)` asks
   iOS to run the extension, which streams the snapshot back to CallKit.

Sync runs on foreground appear, on the **Refresh now** button, on pull to
refresh, and from a `BGAppRefreshTask`
(`com.gghomes.cti.callerid.refresh`, declared in
`BGTaskSchedulerPermittedIdentifiers`; `fetch` is the app's only background
mode).

The rep must switch the extension on once, by hand:
**Settings → Apps → Phone → Call Blocking & Identification → CTI Caller ID.**
`StatusView` reports whether iOS has it enabled and deep-links there.

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
a number an earlier row already used, and refuses to *load* a snapshot that is
out of order. A snapshot that is missing, corrupt, or out of order makes the
extension `cancelRequest(withError:)` rather than publish a partial directory
over a good one.

## Not here yet

Silent push (`POST /mobile/apns-token`) is a deferred fast-follow: the app
registers **no** push entitlement and no push handler, and does not post a
token. Directory updates arrive on the next foreground or background refresh.
