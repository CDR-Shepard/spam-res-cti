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

    // MARK: - Fixtures

    private func makeEngine(
        tokens: TokenBox = TokenBox(token: "device-token"),
        pull: @escaping SyncEngine.Pull,
        reload: @escaping SyncEngine.Reload
    ) -> SyncEngine {
        let containerURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("SyncEngineTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: containerURL, withIntermediateDirectories: true)

        let suiteName = "SyncEngineTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard

        addTeardownBlock {
            try? FileManager.default.removeItem(at: containerURL)
            UserDefaults.standard.removePersistentDomain(forName: suiteName)
        }

        return SyncEngine(
            store: DirectoryStore(containerURL: containerURL),
            defaults: defaults,
            tokens: tokens.store,
            pull: pull,
            reload: reload,
            // CallKit's real probe needs a device; the screen's copy of the
            // switch is not what these tests are about.
            enabledStatus: { _ in .unknown }
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
