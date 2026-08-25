import XCTest

/// The engine's own inventions — the reload-retry key, the single-flight
/// guard, and the 401 → unpair path — driven end to end. Nothing here touches
/// the Keychain, CallKit or the network: the engine takes all three by
/// injection, so these run against a temp container and a scratch defaults
/// suite exactly as the shipping code path does.
@MainActor
final class SyncEngineTests: XCTestCase {
    private let extensionIdentifier = AppConfig.extensionBundleIdentifier

    // MARK: - Reload retry

    func testARefusedReloadIsRetriedOnTheNextSyncEvenThoughTheDirectoryIsUnchanged() async throws {
        // This is the failure mode the retry key exists for: CallKit refuses
        // one reload, and every sync afterwards answers "unchanged" — so
        // without the key the phone would hold a directory iOS never loaded,
        // silently, until the next version bump.
        let log = CallLog()
        let engine = makeEngine(
            pull: { _, since in
                await log.recordPull(since: since)
                return since == nil ? version5 : nil
            },
            reload: { identifier in
                if await log.recordReload(identifier) == 1 { throw ReloadFailure.refused }
            }
        )

        await engine.sync()

        var reloads = await log.reloads
        XCTAssertEqual(reloads, [extensionIdentifier])
        XCTAssertNotNil(engine.failureMessage, "a refused reload must not read as a clean sync")

        await engine.sync()

        let pulls = await log.pulls
        XCTAssertEqual(pulls, [nil, 5], "the second sync asks what changed since the stored version")
        reloads = await log.reloads
        XCTAssertEqual(
            reloads,
            [extensionIdentifier, extensionIdentifier],
            "the refused reload must be retried even though the server answered unchanged"
        )
        XCTAssertNil(engine.failureMessage)
        XCTAssertEqual(engine.version, 5)
        XCTAssertEqual(engine.entryCount, 1)
    }

    func testAReloadThatSucceededIsNotRepeatedOnEverySync() async {
        // The other half of the same key: once CallKit holds the version the
        // store holds, syncing again must be free. A retry loop that never
        // settles would reload the extension on every foreground.
        let log = CallLog()
        let engine = makeEngine(
            pull: { _, since in
                await log.recordPull(since: since)
                return since == nil ? version5 : nil
            },
            reload: { identifier in _ = await log.recordReload(identifier) }
        )

        await engine.sync()
        await engine.sync()
        await engine.sync()

        let reloads = await log.reloads
        XCTAssertEqual(reloads.count, 1, "an unchanged directory CallKit already holds must not be reloaded again")
        XCTAssertNil(engine.failureMessage)
    }

    // MARK: - Single flight

    func testASecondSyncIsIgnoredWhileOneIsInFlight() async {
        // Foregrounding onto a screen that also syncs on appear fires two at
        // once; the second would only re-download what the first is writing.
        let log = CallLog()
        let gate = Gate()
        let started = expectation(description: "the first pull started")
        let engine = makeEngine(
            pull: { _, since in
                // Only the first pull hangs about. A second one — which is
                // exactly what the guard exists to prevent — returns straight
                // away, so a broken guard fails this test instead of wedging it.
                if await log.recordPull(since: since) == 1 {
                    started.fulfill()
                    await gate.wait()
                }
                return nil
            },
            reload: { identifier in _ = await log.recordReload(identifier) }
        )

        let first = Task { await engine.sync() }
        await fulfillment(of: [started], timeout: 5)

        await engine.sync()

        await gate.open()
        await first.value

        let pulls = await log.pulls
        XCTAssertEqual(pulls.count, 1, "a sync already in flight must absorb the second call")
    }

    // MARK: - Revocation

    func testARevokedDeviceIsUnpairedWithAReasonThePairingScreenCanShow() async {
        // 401 means the rep's device was removed from the softphone's device
        // list. `failureMessage` is what PairView renders, and it is the only
        // thing standing between the rep and an unexplained empty form.
        let tokens = TokenBox(token: "device-token")
        let engine = makeEngine(
            tokens: tokens,
            pull: { _, _ in throw FeedError.http(status: 401) },
            reload: { _ in }
        )
        XCTAssertTrue(engine.isPaired)

        await engine.sync()

        XCTAssertFalse(engine.isPaired)
        XCTAssertNil(tokens.token, "a revoked token must not be left in the Keychain")
        XCTAssertEqual(engine.failureMessage, "This iPhone was unpaired. Enter a new pairing code.")
    }

    func testAnUnpairedPhoneSaysSoRatherThanPullingAnything() async {
        let log = CallLog()
        let engine = makeEngine(
            tokens: TokenBox(token: nil),
            pull: { _, since in
                await log.recordPull(since: since)
                return nil
            },
            reload: { _ in }
        )

        await engine.sync()

        let pulls = await log.pulls
        XCTAssertTrue(pulls.isEmpty, "no token, no request")
        XCTAssertEqual(engine.failureMessage, "This iPhone is not paired yet.")
    }

    // MARK: - Pairing

    func testPairingStoresTheMintedTokenAndPullsTheDirectory() async throws {
        let tokens = TokenBox(token: nil)
        let log = CallLog()
        let engine = makeEngine(
            tokens: tokens,
            pull: { _, since in
                await log.recordPull(since: since)
                return version5
            },
            reload: { identifier in _ = await log.recordReload(identifier) },
            claim: { code, label in
                await log.recordClaim(code: code, label: label)
                return PairClaim(deviceToken: "minted-token", user: .init(displayName: "Jane Rep"))
            }
        )
        XCTAssertFalse(engine.isPaired)

        try await engine.pair(code: "123456", deviceLabel: "Jane's iPhone")

        let claims = await log.claims
        XCTAssertEqual(claims.map(\.code), ["123456"])
        XCTAssertEqual(claims.map(\.label), ["Jane's iPhone"])
        XCTAssertEqual(tokens.token, "minted-token", "the minted token is what every later feed request carries")
        XCTAssertTrue(engine.isPaired)
        XCTAssertEqual(engine.pairedUserName, "Jane Rep")
        XCTAssertEqual(engine.version, 5)
        XCTAssertEqual(engine.entryCount, 1)
        XCTAssertNil(engine.failureMessage)
    }

    func testPairingIgnoresTheSnapshotAlreadyOnDiskAndAsksForTheWholeDirectory() async throws {
        // A phone that has just changed identity must not tell the server "I
        // already have version 5". Directory versions are small per-org
        // integers, so a version left over from a PREVIOUS pairing can equal
        // the new org's latest — the server would answer `unchanged` and the
        // phone would go on serving the previous org's names and numbers until
        // that org next republished.
        let store = makeStore()
        try store.save(version: 5, entries: [DirectoryEntry(e164: "+16195550100", label: "Lead: Previous Org")])
        let log = CallLog()
        let engine = makeEngine(
            store: store,
            tokens: TokenBox(token: nil),
            pull: { _, since in
                await log.recordPull(since: since)
                return (version: 5, entries: [DirectoryEntry(e164: "+12135550200", label: "Lead: New Org")])
            },
            reload: { identifier in _ = await log.recordReload(identifier) },
            claim: { _, _ in PairClaim(deviceToken: "minted-token", user: .init(displayName: "Jane Rep")) }
        )

        try await engine.pair(code: "123456", deviceLabel: "Jane's iPhone")

        let pulls = await log.pulls
        XCTAssertEqual(pulls, [nil], "the first sync after pairing must ask for everything, never `since`")
        XCTAssertEqual(try labels(in: store), ["Lead: New Org"])
    }

    func testPairingSatisfiesAWipeStillPendingFromTheLastUnpair() async throws {
        // The pending wipe and the new pairing want opposite things from the
        // store, and a late-firing retryPendingPurge must not blank the
        // directory pair() is installing. Installing a new directory is what
        // the wipe was for, so a successful claim clears the flag.
        let callKit = ReloadBox(shouldFail: true)
        let engine = makeEngine(
            tokens: TokenBox(token: nil),
            pull: { _, _ in (version: 1, entries: [DirectoryEntry(e164: "+12135550200", label: "Lead: New Org")]) },
            reload: { identifier in try await callKit.reload(identifier) },
            claim: { _, _ in PairClaim(deviceToken: "minted-token", user: .init(displayName: "Jane Rep")) }
        )

        engine.unpair()
        XCTAssertTrue(engine.isPurgePending, "the wipe is pending until it completes — CallKit keeps refusing here")

        try await engine.pair(code: "123456", deviceLabel: "Jane's iPhone")

        XCTAssertTrue(engine.isPaired)
        XCTAssertFalse(engine.isPurgePending, "a successful claim satisfies the pending wipe")
    }

    func testAFailedClaimLeavesThePhoneUnpairedAndPullsNothing() async {
        let tokens = TokenBox(token: nil)
        let log = CallLog()
        let engine = makeEngine(
            tokens: tokens,
            pull: { _, since in
                await log.recordPull(since: since)
                return version5
            },
            reload: { _ in },
            claim: { _, _ in throw PairingError.invalidCode }
        )

        do {
            try await engine.pair(code: "000000", deviceLabel: "Jane's iPhone")
            XCTFail("a refused claim must propagate so PairView can show it")
        } catch {
            XCTAssertEqual(error as? PairingError, .invalidCode)
        }

        XCTAssertFalse(engine.isPaired)
        XCTAssertNil(tokens.token)
        let pulls = await log.pulls
        XCTAssertTrue(pulls.isEmpty, "no token, no request")
    }

    // MARK: - Unpair purge

    func testAnUnpairWhoseWipeFailsStaysPendingInsteadOfLeavingTheDirectoryBehind() async {
        // CallKit answers `.currentlyLoading` if a reload is already in flight,
        // and `.extensionDisabled` if the rep turned the switch off. Either
        // one used to be swallowed — leaving the whole org's directory on a
        // handset that is no longer authorized, with nothing that would ever
        // retry the wipe (`sync()` returns early once unpaired).
        let store = makeStore()
        try? store.save(version: 5, entries: [DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe")])
        let engine = makeEngine(
            store: store,
            pull: { _, _ in nil },
            reload: { _ in throw ReloadFailure.refused }
        )

        engine.unpair()
        XCTAssertTrue(engine.isPurgePending, "the wipe is pending the moment the token is dropped")

        await engine.retryPendingPurge()

        XCTAssertTrue(engine.isPurgePending, "a wipe CallKit still refuses must stay pending")
        XCTAssertEqual(
            store.loadHeader()?.entryCount,
            0,
            "the snapshot on disk is wiped even when the reload fails"
        )
    }

    func testTheNextForegroundFinishesAWipeThatFailedEarlier() async {
        let store = makeStore()
        try? store.save(version: 5, entries: [DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe")])
        let callKit = ReloadBox(shouldFail: true)
        let engine = makeEngine(
            store: store,
            pull: { _, _ in nil },
            reload: { identifier in try await callKit.reload(identifier) }
        )

        engine.unpair()
        XCTAssertTrue(engine.isPurgePending)

        // The rep reopens the app: CallKit is no longer busy.
        await callKit.stopFailing()
        await engine.retryPendingPurge()

        XCTAssertFalse(engine.isPurgePending, "a completed wipe must clear the flag so it isn't retried forever")
        let reloads = await callKit.attempts
        XCTAssertGreaterThanOrEqual(reloads, 1)
    }

    func testRetryWithNothingPendingDoesNothing() async {
        let log = CallLog()
        let idle = makeEngine(pull: { _, _ in nil }, reload: { identifier in _ = await log.recordReload(identifier) })
        await idle.retryPendingPurge()
        let reloads = await log.reloads
        XCTAssertTrue(reloads.isEmpty, "nothing pending, nothing to do")
    }

    func testATornSnapshotIsDiscardedSoTheNextSyncRepairsIt() async {
        // A valid header over a truncated body — power loss after the
        // rename's metadata landed but before the data blocks flushed.
        // Without the discard this wedges forever: `loadHeader` keeps
        // succeeding, the server keeps answering "unchanged", and the
        // extension keeps refusing the same bytes.
        let store = makeStore()
        try? store.save(version: 5, entries: [
            DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe"),
            DirectoryEntry(e164: "+16195550101", label: "Lead: John Doe"),
        ])
        let whole = (try? Data(contentsOf: store.fileURL)) ?? Data()
        try? whole.prefix(whole.count - 3).write(to: store.fileURL)
        XCTAssertNotNil(store.loadHeader(), "the tear must be invisible to the header for this test to mean anything")

        let callKit = ReloadBox(shouldFail: true)
        let log = CallLog()
        let engine = makeEngine(
            store: store,
            pull: { _, since in
                await log.recordPull(since: since)
                if since == nil {
                    return (version: 6, entries: [DirectoryEntry(e164: "+12135550200", label: "Lead: Repaired")])
                }
                return nil // the server rightly answers "unchanged" at version 5
            },
            reload: { identifier in try await callKit.reload(identifier) }
        )

        await engine.sync()
        XCTAssertNil(store.loadHeader(), "a snapshot that fails verification after a failed reload must be discarded")

        await callKit.stopFailing()
        await engine.sync()

        XCTAssertEqual(store.loadHeader()?.version, 6)
        let pulls = await log.pulls
        XCTAssertEqual(pulls, [5, nil], "the discard is what turns the wedged 'unchanged' answer into a full re-pull")
    }

    func testAHealthySnapshotSurvivesAReloadThatMerelyFailed() async {
        // The discard must key on the FILE being bad, not on the reload
        // failing — CallKit answering `.currentlyLoading` is routine.
        let store = makeStore()
        try? store.save(version: 5, entries: [DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe")])
        let callKit = ReloadBox(shouldFail: true)
        let engine = makeEngine(
            store: store,
            pull: { _, _ in nil },
            reload: { identifier in try await callKit.reload(identifier) }
        )

        await engine.sync()

        XCTAssertEqual(store.loadHeader()?.version, 5, "a snapshot that verifies must be left alone")
    }

    // MARK: - Fixtures

    /// The labels actually on disk. The store is streamed rather than loaded
    /// whole — `loadHeader` deliberately reads no records — so a test that
    /// cares WHICH directory was installed has to walk it.
    private func labels(in store: DirectoryStore) throws -> [String] {
        var out: [String] = []
        try store.streamEntries { _, label in out.append(label) }
        return out
    }

    /// A throwaway App Group stand-in, cleaned up after the test.
    private func makeStore() -> DirectoryStore {
        let containerURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("SyncEngineTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: containerURL, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: containerURL)
        }
        return DirectoryStore(containerURL: containerURL)
    }

    private func makeEngine(
        store: DirectoryStore? = nil,
        tokens: TokenBox = TokenBox(token: "device-token"),
        pull: @escaping SyncEngine.Pull,
        reload: @escaping SyncEngine.Reload,
        claim: @escaping SyncEngine.Claim = { _, _ in
            XCTFail("this test should never claim a pairing code")
            throw PairingError.malformedResponse
        }
    ) -> SyncEngine {
        let suiteName = "SyncEngineTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard

        addTeardownBlock {
            UserDefaults.standard.removePersistentDomain(forName: suiteName)
        }

        return SyncEngine(
            store: store ?? makeStore(),
            defaults: defaults,
            tokens: tokens.store,
            pull: pull,
            reload: reload,
            // CallKit's real probe needs a device; the screen's copy of the
            // switch is not what these tests are about.
            enabledStatus: { _ in .unknown },
            claim: claim
        )
    }
}

// MARK: - Doubles

/// The one directory these tests publish. File scope, not a static on the test
/// case: the pull closures read it from off the main actor.
private let version5: (version: Int, entries: [DirectoryEntry]) = (
    version: 5,
    entries: [DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe")]
)

private enum ReloadFailure: Error {
    case refused
}

/// The device token, in memory. A plain class (not an actor): the token
/// closures are synchronous and only ever called from the engine's main actor.
private final class TokenBox {
    var token: String?

    init(token: String?) {
        self.token = token
    }

    var store: SyncEngine.TokenStore {
        SyncEngine.TokenStore(
            load: { self.token },
            save: { self.token = $0 },
            delete: { self.token = nil }
        )
    }
}

/// What the engine asked of its collaborators. An actor because `Pull` and
/// `Reload` are plain async closures — they do not inherit the engine's
/// main-actor isolation, so they can land on any executor.
private actor CallLog {
    private(set) var pulls: [Int?] = []
    private(set) var reloads: [String] = []
    private(set) var claims: [(code: String, label: String)] = []

    func recordClaim(code: String, label: String) {
        claims.append((code: code, label: label))
    }

    /// Returns which pull this was, so a test can treat the first differently.
    @discardableResult
    func recordPull(since: Int?) -> Int {
        pulls.append(since)
        return pulls.count
    }

    /// Returns which attempt this was, so a test can fail only the first one.
    func recordReload(_ identifier: String) -> Int {
        reloads.append(identifier)
        return reloads.count
    }
}

/// A CallKit reload that can be told to start working, so a test can drive
/// "refused, then accepted" without depending on which of two tasks got there
/// first.
private actor ReloadBox {
    private var shouldFail: Bool
    private(set) var attempts = 0

    init(shouldFail: Bool) {
        self.shouldFail = shouldFail
    }

    func stopFailing() {
        shouldFail = false
    }

    func reload(_ identifier: String) throws {
        attempts += 1
        if shouldFail { throw ReloadFailure.refused }
    }
}

/// One-shot gate: `wait()` suspends until `open()`.
private actor Gate {
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func open() {
        isOpen = true
        for continuation in waiting { continuation.resume() }
        waiting = []
    }

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiting.append($0) }
    }
}
