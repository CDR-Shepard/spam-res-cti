import BackgroundTasks
import CallKit
import Foundation
import os

/// The app's one piece of behaviour: pull the directory, write the snapshot,
/// tell CallKit to reload the extension — and publish enough state for the UI
/// to show what happened.
///
/// A single shared instance because the SwiftUI scene's background-refresh
/// handler and the views must drive the same sync (and because two concurrent
/// syncs writing the same snapshot file would be pointless work).
@MainActor
final class SyncEngine: ObservableObject {
    static let shared = SyncEngine()

    enum Status: Equatable {
        case idle
        case syncing
        case failed(String)
    }

    /// The device token behind three closures rather than a direct call to
    /// `DeviceTokenStore`, so pairing and revocation can be driven from a test
    /// without touching the real Keychain.
    struct TokenStore {
        var load: () -> String?
        var save: (String) throws -> Void
        var delete: () -> Void

        static let keychain = TokenStore(
            load: DeviceTokenStore.load,
            save: DeviceTokenStore.save,
            delete: DeviceTokenStore.delete
        )
    }

    /// Pulls the whole directory; `nil` when the server says nothing changed
    /// since `since`.
    typealias Pull = (_ token: String, _ since: Int?) async throws -> (version: Int, entries: [DirectoryEntry])?
    /// Asks CallKit to reload the extension with that bundle identifier.
    typealias Reload = (_ extensionIdentifier: String) async throws -> Void
    /// Whether the user has the extension switched on in Settings.
    typealias EnabledStatusProbe = (_ extensionIdentifier: String) async -> CXCallDirectoryManager.EnabledStatus
    /// Trades a pairing code for this phone's device token.
    typealias Claim = (_ code: String, _ deviceLabel: String) async throws -> PairClaim

    @Published private(set) var isPaired: Bool
    @Published private(set) var pairedUserName: String?
    @Published private(set) var status: Status = .idle
    @Published private(set) var version: Int?
    @Published private(set) var entryCount: Int = 0
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var extensionEnabled: CXCallDirectoryManager.EnabledStatus = .unknown

    private let store: DirectoryStore?
    private let defaults: UserDefaults
    private let tokens: TokenStore
    private let pull: Pull
    private let reload: Reload
    private let enabledStatus: EnabledStatusProbe
    private let claim: Claim
    private let log = Logger(subsystem: "com.gghomes.cti.callerid", category: "SyncEngine")

    private enum Keys {
        static let lastSyncedAt = "lastSyncedAt"
        static let pairedUserName = "pairedUserName"
        /// The snapshot version CallKit was last confirmed to have loaded.
        static let reloadedVersion = "reloadedVersion"
        /// Set while an unpair's directory wipe has not finished. Persisted
        /// because the retry has to survive the app being killed.
        static let purgePending = "purgePending"
    }

    /// Everything the sync reaches outside itself is injected — CallKit and
    /// the Keychain included — because the invariants this engine invents (the
    /// reload-retry key, the single-flight guard, the 401 → unpair path) are
    /// only worth having if a test can drive them. Production calls
    /// `SyncEngine()` and takes every default.
    init(
        store: DirectoryStore? = DirectoryStore.appGroup(),
        defaults: UserDefaults = UserDefaults(suiteName: AppConfig.appGroupIdentifier) ?? .standard,
        tokens: TokenStore = .keychain,
        pull: @escaping Pull = SyncEngine.livePull,
        reload: @escaping Reload = SyncEngine.liveReload,
        enabledStatus: @escaping EnabledStatusProbe = SyncEngine.liveEnabledStatus,
        claim: @escaping Claim = SyncEngine.liveClaim
    ) {
        self.store = store
        self.defaults = defaults
        self.tokens = tokens
        self.pull = pull
        self.reload = reload
        self.enabledStatus = enabledStatus
        self.claim = claim
        self.isPaired = tokens.load() != nil
        self.pairedUserName = defaults.string(forKey: Keys.pairedUserName)
        self.lastSyncedAt = defaults.object(forKey: Keys.lastSyncedAt) as? Date

        // Header only: the app never needs the records, and reading a
        // six-figure directory to populate two labels on a status screen is
        // exactly the cost the binary format exists to avoid.
        if let header = store?.loadHeader() {
            self.version = header.version
            self.entryCount = header.entryCount
        }
    }

    /// The failure worth putting in front of the user, or `nil`. Both screens
    /// render it — StatusView inline, PairView above the code field, which is
    /// where a revoked device lands the moment `sync()` unpairs it.
    var failureMessage: String? {
        if case let .failed(message) = status { return message }
        return nil
    }

    // MARK: - Pairing

    func pair(code: String, deviceLabel: String) async throws {
        // A fresh attempt starts clean: otherwise the revocation message from
        // the sync that just unpaired this phone would sit under the new code
        // the user is typing.
        status = .idle
        let claimed = try await claim(code, deviceLabel)
        // A successful pairing satisfies any wipe still pending from the last
        // unpair: the full sync below replaces the snapshot wholesale, and a
        // late-firing retryPendingPurge must not blank the directory we are
        // about to install.
        defaults.removeObject(forKey: Keys.purgePending)
        try tokens.save(claimed.deviceToken)
        pairedUserName = claimed.user.displayName
        defaults.set(claimed.user.displayName, forKey: Keys.pairedUserName)
        isPaired = true
        // A FULL first sync, never `since`. This phone has just changed
        // identity, and the snapshot still on disk belongs to the previous
        // pairing — possibly a different org, if the wipe below ever failed.
        // Directory versions are small per-org integers, so a stale version
        // that happens to equal the new org's latest would make the server
        // answer "unchanged" and leave the previous org's names and numbers
        // being served on this handset until that org next republishes.
        await sync(forcingFullResync: true)
    }

    /// Drops the token AND the snapshot, then reloads the extension so the
    /// phone stops identifying this org's numbers straight away.
    ///
    /// The wipe is marked pending until it actually completes. It can fail —
    /// CallKit answers `.currentlyLoading` if a reload is already in flight,
    /// or `.extensionDisabled`, or the empty save throws — and a swallowed
    /// failure would leave the whole org's directory (every Lead/Opp/Deal name
    /// paired with a phone number) on a handset that is no longer authorized,
    /// with nothing left to retry it: `sync()` returns early once unpaired, so
    /// no later sync would ever notice.
    func unpair() {
        tokens.delete()
        isPaired = false
        pairedUserName = nil
        version = nil
        entryCount = 0
        lastSyncedAt = nil
        status = .idle
        defaults.removeObject(forKey: Keys.pairedUserName)
        defaults.removeObject(forKey: Keys.lastSyncedAt)
        defaults.removeObject(forKey: Keys.reloadedVersion)
        defaults.set(true, forKey: Keys.purgePending)

        Task { await purgeDirectory() }
    }

    /// True while an unpair's directory wipe still has to be finished.
    var isPurgePending: Bool {
        defaults.bool(forKey: Keys.purgePending)
    }

    /// Wipes the shared snapshot and makes CallKit drop what it holds. Clears
    /// the pending flag only when BOTH halves succeed.
    func purgeDirectory() async {
        guard let store else {
            // No shared container at all: there is no snapshot on disk and the
            // extension has nothing to read. Nothing to retry.
            defaults.removeObject(forKey: Keys.purgePending)
            return
        }
        do {
            try store.save(version: 0, entries: [])
            try await reload(AppConfig.extensionBundleIdentifier)
            defaults.removeObject(forKey: Keys.purgePending)
            log.info("directory purged after unpair")
        } catch {
            log.error("unpair purge failed, retrying on next foreground: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Finishes an interrupted unpair. Driven from `PairView`, which is the
    /// screen an unpaired phone lands on and comes back to on every foreground
    /// until it is paired again.
    func retryPendingPurge() async {
        guard isPurgePending else { return }
        await purgeDirectory()
    }

    // MARK: - Syncing

    /// Pull → store → reload. Safe to call from anywhere; failures land in
    /// `status` rather than propagating, because every caller (appear,
    /// button, background task) wants the same handling.
    func sync(forcingFullResync: Bool = false) async {
        // Four things drive a sync (appear, foregrounding, the button, the
        // background task) and two of them can land together — foregrounding
        // onto a screen that also syncs on appear. One at a time: the second
        // would only re-download what the first is already writing. (The sync
        // already in flight refreshes the extension status for both.)
        guard status != .syncing else { return }
        await pullStoreAndReload(forcingFullResync: forcingFullResync)
        // Every path lands here, refusals included — the Settings switch is
        // the one thing on the screen that has nothing to do with whether the
        // pull worked, and reading it only on success left it on "Unknown".
        await refreshExtensionStatus()
    }

    private func pullStoreAndReload(forcingFullResync: Bool) async {
        guard let token = tokens.load() else {
            status = .failed("This iPhone is not paired yet.")
            return
        }
        guard let store else {
            status = .failed("The shared app group container is unavailable.")
            return
        }

        status = .syncing
        do {
            let known = forcingFullResync ? nil : store.loadHeader()?.version
            if let pulled = try await pull(token, known) {
                try store.save(version: pulled.version, entries: pulled.entries)
                // Read back rather than trusting the pull: the store is what
                // the extension will actually publish, so its count and
                // version are the honest ones to show. (Dedupe and the write
                // ceiling both live on the write side, so the header's count
                // is routinely smaller than the number of rows pulled.)
                let stored = store.loadHeader()
                version = stored?.version ?? pulled.version
                entryCount = stored?.entryCount ?? pulled.entries.count
                log.info("stored version \(self.version ?? -1) with \(self.entryCount) entries")
            } else {
                version = known
                log.info("directory unchanged at version \(known ?? -1)")
            }

            // Reload whenever CallKit is not known to be holding what the
            // store holds. Keyed on the version rather than on "we just
            // pulled something", because a reload that failed last time must
            // be retried — otherwise a stored-but-never-loaded directory would
            // sit there until the next version bump, with every sync in
            // between answering "unchanged" and doing nothing.
            if let current = version, defaults.object(forKey: Keys.reloadedVersion) as? Int != current {
                do {
                    try await reload(AppConfig.extensionBundleIdentifier)
                } catch {
                    // A failing reload can mean CallKit is merely busy — or
                    // that the snapshot's body is torn under a valid header
                    // (power loss after the rename's metadata landed but
                    // before the data blocks flushed). The header alone can't
                    // tell them apart, and a torn snapshot wedges forever
                    // otherwise: `loadHeader` keeps succeeding, the server
                    // keeps answering "unchanged", and the extension keeps
                    // refusing the same bytes.
                    discardSnapshotIfCorrupt(store)
                    throw error
                }
                defaults.set(current, forKey: Keys.reloadedVersion)
                log.info("call directory reloaded at version \(current)")
            }

            lastSyncedAt = Date()
            defaults.set(lastSyncedAt, forKey: Keys.lastSyncedAt)
            status = .idle
        } catch FeedError.http(status: 401) {
            // The device was revoked from the softphone's device list. This
            // drops the phone back to PairView, which renders `failureMessage`
            // — without that the swap would look like the app resetting itself.
            unpair()
            status = .failed("This iPhone was unpaired. Enter a new pairing code.")
        } catch {
            log.error("sync failed: \(error.localizedDescription, privacy: .public)")
            status = .failed(Self.message(for: error))
        }
    }

    /// Stream-verifies the snapshot after a failed reload; a body that can't
    /// be read end to end is discarded so the next sync starts from nothing
    /// and pulls the full directory again. A snapshot that verifies is left
    /// alone — the reload failure was CallKit's, not the file's.
    private func discardSnapshotIfCorrupt(_ store: DirectoryStore) {
        do {
            try store.verify()
        } catch {
            log.error("snapshot failed verification after a reload failure; discarding: \(error.localizedDescription, privacy: .public)")
            store.removeSnapshot()
            version = nil
            entryCount = 0
        }
    }

    // MARK: - The Call Directory extension

    func refreshExtensionStatus() async {
        extensionEnabled = await enabledStatus(AppConfig.extensionBundleIdentifier)
    }

    /// The real feed pull. `nonisolated` so its unapplied reference is a plain
    /// async function rather than a main-actor-isolated one.
    nonisolated static func livePull(
        token: String,
        since: Int?
    ) async throws -> (version: Int, entries: [DirectoryEntry])? {
        try await fetchAll(baseURL: AppConfig.baseURL, token: token, since: since)
    }

    /// The real pairing claim. `nonisolated` for the same reason as `livePull`.
    nonisolated static func liveClaim(code: String, deviceLabel: String) async throws -> PairClaim {
        try await claimPairingCode(code: code, deviceLabel: deviceLabel)
    }

    nonisolated static func liveReload(_ extensionIdentifier: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            CXCallDirectoryManager.sharedInstance
                .reloadExtension(withIdentifier: extensionIdentifier) { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
        }
    }

    nonisolated static func liveEnabledStatus(
        _ extensionIdentifier: String
    ) async -> CXCallDirectoryManager.EnabledStatus {
        await withCheckedContinuation { continuation in
            CXCallDirectoryManager.sharedInstance
                .getEnabledStatusForExtension(withIdentifier: extensionIdentifier) { status, _ in
                    continuation.resume(returning: status)
                }
        }
    }

    // MARK: - Background refresh

    /// Asks the system for another background window. iOS decides when (or
    /// whether) to grant it; a rejection is logged, never fatal — the app
    /// still syncs on foreground and on the Refresh button.
    func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: AppConfig.backgroundRefreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: AppConfig.backgroundRefreshInterval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            log.notice("background refresh not scheduled: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The body of the registered `BGAppRefreshTask`: schedule the next window
    /// first (so a failure below cannot end the chain), then sync.
    func runBackgroundRefresh() async {
        scheduleBackgroundRefresh()
        guard isPaired else { return }
        await sync()
    }

    // MARK: - Errors

    private static func message(for error: Error) -> String {
        switch error {
        case FeedError.http(let status):
            return "The server refused the request (HTTP \(status))."
        case FeedError.versionUnstable:
            return "The directory was being republished. Try again in a moment."
        case FeedError.malformedResponse, FeedError.invalidURL:
            return "The server sent an unexpected response."
        default:
            return error.localizedDescription
        }
    }
}
