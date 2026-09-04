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
    /// Whether a Salesforce session token is on file. `RootView` routes on
    /// this rather than reading the Keychain itself, so it re-renders the
    /// instant `unpair()` (or a fresh sign-in) changes the answer.
    @Published private(set) var hasSession: Bool
    @Published private(set) var pairedUserName: String?
    @Published private(set) var status: Status = .idle
    @Published private(set) var version: Int?
    @Published private(set) var entryCount: Int = 0
    @Published private(set) var lastSyncedAt: Date?
    @Published private(set) var extensionEnabled: CXCallDirectoryManager.EnabledStatus = .unknown
    /// True when the phone was signed out because its Salesforce session
    /// expired, rather than because the rep asked. `SignInView` reads it: the
    /// two land on the same screen, and the rep who did not tap anything is
    /// owed the reason they are suddenly looking at it.
    @Published private(set) var sessionExpired = false

    private let store: DirectoryStore?
    private let defaults: UserDefaults
    private let tokens: TokenStore
    private let sessions: SessionTokenStoring
    private let pull: Pull
    private let reload: Reload
    private let enabledStatus: EnabledStatusProbe
    private let claim: Claim
    private let log = Logger(subsystem: AppConfig.loggingSubsystem, category: "SyncEngine")

    private enum Keys {
        static let lastSyncedAt = "lastSyncedAt"
        static let pairedUserName = "pairedUserName"
        /// The snapshot version CallKit was last confirmed to have loaded.
        static let reloadedVersion = "reloadedVersion"
        /// Set while an unpair's directory wipe has not finished. Persisted
        /// because the retry has to survive the app being killed.
        static let purgePending = "purgePending"
        /// This phone's own `mobile_devices` row id — see `deviceId`.
        static let deviceId = "deviceRowId"
    }

    /// The id of THIS phone's `mobile_devices` row, when it has one: what
    /// sign-out sends to `DELETE /mobile/devices/:id` so the row is revoked
    /// server-side rather than left live for a handset nobody is signed in to.
    ///
    /// `UserDefaults`, deliberately, not the Keychain: it is a row identifier,
    /// not a credential — it authenticates nothing on its own, and the route
    /// that takes it authenticates the *session*. `nil` for a phone paired
    /// with a 6-digit code, which predates `/mobile/register` and never
    /// learned its own id.
    var deviceId: String? { defaults.string(forKey: Keys.deviceId) }

    /// Everything the sync reaches outside itself is injected — CallKit and
    /// the Keychain included — because the invariants this engine invents (the
    /// reload-retry key, the single-flight guard, the 401 → unpair path) are
    /// only worth having if a test can drive them. Production calls
    /// `SyncEngine()` and takes every default.
    init(
        store: DirectoryStore? = DirectoryStore.appGroup(),
        defaults: UserDefaults = UserDefaults(suiteName: AppConfig.appGroupIdentifier) ?? .standard,
        tokens: TokenStore = .keychain,
        sessions: SessionTokenStoring = SessionTokenStore(),
        pull: @escaping Pull = SyncEngine.livePull,
        reload: @escaping Reload = SyncEngine.liveReload,
        enabledStatus: @escaping EnabledStatusProbe = SyncEngine.liveEnabledStatus,
        claim: @escaping Claim = SyncEngine.liveClaim
    ) {
        self.store = store
        self.defaults = defaults
        self.tokens = tokens
        self.sessions = sessions
        self.pull = pull
        self.reload = reload
        self.enabledStatus = enabledStatus
        self.claim = claim
        self.isPaired = tokens.load() != nil
        self.hasSession = sessions.load() != nil
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
    /// render it — `StatusView` inline, and `SignInView`, which is where a
    /// revoked device lands the moment `sync()` unpairs it.
    var failureMessage: String? {
        if case let .failed(message) = status { return message }
        return nil
    }

    /// A device token from before Salesforce sign-in existed, with no session
    /// token on file. `RootView` already routes this phone to `SignInView`
    /// (same as a brand-new install) because `hasSession` is false either
    /// way — this flag is only so that screen can say the truer thing to a
    /// rep who already set calling up once: sign in again to keep using it,
    /// rather than the fresh-install "set up this iPhone" copy.
    var isLegacyPairedDevice: Bool { isPaired && !hasSession }

    /// A session-authenticated call came back 401. Recorded here (rather than
    /// in `status`, which `unpair()` clears) so it survives the sign-out that
    /// follows it and is still there when `SignInView` draws.
    func noteSessionExpired() {
        sessionExpired = true
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
        // A code-paired phone has no row id of its own, and the one left over
        // from a previous sign-in points at a row this pairing does not own.
        defaults.removeObject(forKey: Keys.deviceId)
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

    /// Sign-in path: the app already holds a session and asked the server to
    /// mint a device token for this phone — no 6-digit code involved.
    ///
    /// Deliberately does not sync, unlike `pair(code:)`: the caller
    /// (`SignInView`) drives the first sync itself once it hands off to the
    /// main UI, the same way a cold launch's `StatusView.task` does for a
    /// phone that was already paired.
    /// `deviceId` is the row `/mobile/register` just inserted — kept so that
    /// signing out can revoke it (see `deviceId`).
    func adoptDeviceToken(_ token: String, displayName: String?, deviceId: String) throws {
        try tokens.save(token)
        defaults.set(deviceId, forKey: Keys.deviceId)
        defaults.set(displayName, forKey: Keys.pairedUserName)
        pairedUserName = displayName
        isPaired = true
        // Whatever expired has just been replaced.
        sessionExpired = false
        // The session token itself was already written by `SignInFlow`
        // (before this is ever called) — this only brings the published flag
        // in line with what is now actually in the Keychain, so `RootView`
        // stops showing `SignInView` the moment adoption succeeds.
        hasSession = true
    }

    /// Drops the device token, the Salesforce session token, AND the
    /// snapshot, then reloads the extension so the phone stops identifying
    /// this org's numbers straight away.
    ///
    /// Clearing the session token (not just the device token) is what makes
    /// this a real sign-out: without it, `RootView` would have nowhere to
    /// route a tapped "Unpair" to — `hasSession` would still read true, and
    /// the phone would be stuck showing a "not paired" status screen with no
    /// way back to `SignInView`.
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
        // Best-effort: the concrete Keychain implementation never actually
        // throws here (`SecItemDelete` is fire-and-forget), and a phone
        // stuck mid-unpair with no device token but a stale session token
        // would be a worse outcome than swallowing a hypothetical failure.
        try? sessions.delete()
        isPaired = false
        hasSession = false
        pairedUserName = nil
        version = nil
        entryCount = 0
        lastSyncedAt = nil
        status = .idle
        defaults.removeObject(forKey: Keys.pairedUserName)
        defaults.removeObject(forKey: Keys.lastSyncedAt)
        defaults.removeObject(forKey: Keys.reloadedVersion)
        // The row this pointed at is revoked (or was already unreachable);
        // keeping the id would only offer the next sign-in somebody else's.
        defaults.removeObject(forKey: Keys.deviceId)
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
            // The DEVICE token was revoked from the softphone's device list —
            // a different event from an expired Salesforce session, which
            // `isSessionExpired` deliberately keeps separate. `unpair()` also
            // clears the session, so `RootView` shows `SignInView`, and this
            // message is what that screen renders: without it the swap would
            // look like the app resetting itself.
            unpair()
            status = .failed("Your sign-in is no longer valid. Sign in again.")
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
