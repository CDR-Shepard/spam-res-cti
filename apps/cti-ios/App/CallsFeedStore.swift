import Combine
import Foundation

/// The two read-only calls-API `GET`s the tabs need. Separate from
/// `CallsAPIClient` (which is the *dial* seam `CallController` owns) so that
/// adding a screen never changes the protocol the state machine is built on.
protocol RecentCallsReading {
    func recent(limit: Int) async throws -> [CallSummary]
    func pendingDisposition() async throws -> CallSummary?
}

/// Wiring only — every request shape and every response reading is
/// `Shared/CallsAPI.swift`'s, already pinned by `CallsAPITests`.
/// `pendingDisposition()` comes for free from the `CallsAPIClient`
/// conformance this type already has.
extension LiveCallsAPI: RecentCallsReading {
    func recent(limit: Int) async throws -> [CallSummary] {
        let request = recentCallsRequest(baseURL: baseURL, sessionToken: sessionToken, limit: limit)
        let (data, status) = try await transport(request)
        return try decodeRecentCalls(data, status: status)
    }
}

/// What the Recents list and the Dial screen's "finish your last call" banner
/// read from. One store, shared by both tabs, so the pending row the dial
/// screen shows and the row Recents flags are never two different answers.
///
/// The rule this type exists to enforce: **a failed read is shown, never
/// swallowed.** An empty Recents list that actually means "your session
/// expired" is the kind of silence that gets reported a week later as "the app
/// lost my calls". Nothing here uses `try?`.
final class CallsFeedStore: ObservableObject {
    @Published private(set) var recents: [RecentsRowModel] = []
    @Published private(set) var recentsError: String?
    @Published private(set) var isLoadingRecents = false
    @Published private(set) var pending: CallSummary?
    @Published private(set) var pendingError: String?

    private let api: RecentCallsReading
    /// Both reads here are session-authenticated and both run on tab appear,
    /// so on a phone nobody is dialling from they are usually the first to
    /// notice the 30-day session has expired. See `isSessionExpired`.
    private let onSessionExpired: () -> Void

    init(api: RecentCallsReading, onSessionExpired: @escaping () -> Void = {}) {
        self.api = api
        self.onSessionExpired = onSessionExpired
    }

    /// The signed-in store. `RootView` only builds the tabs behind
    /// `engine.hasSession`, so the `nil` branch is unreachable in practice —
    /// it exists so a missing session surfaces as a readable line on the
    /// screen instead of an unauthenticated request the rep can't interpret.
    static func live(
        sessions: SessionTokenStoring = SessionTokenStore(),
        onSessionExpired: @escaping () -> Void = {}
    ) -> CallsFeedStore {
        guard let session = sessions.load() else {
            return CallsFeedStore(api: SignedOutFeed(), onSessionExpired: onSessionExpired)
        }
        return CallsFeedStore(
            api: LiveCallsAPI(baseURL: AppConfig.baseURL, sessionToken: session),
            onSessionExpired: onSessionExpired
        )
    }

    @MainActor
    func loadRecents(limit: Int = 50) async {
        isLoadingRecents = true
        defer { isLoadingRecents = false }
        do {
            recents = try await api.recent(limit: limit).map(RecentsRowModel.make)
            recentsError = nil
        } catch {
            // The rows already on screen were real; only the refresh failed, so
            // they stay and the failure is shown alongside them.
            recentsError = error.localizedDescription
            reportIfSessionExpired(error)
        }
    }

    @MainActor
    func loadPending() async {
        do {
            pending = try await api.pendingDisposition()
            pendingError = nil
        } catch {
            // Deliberately does not clear `pending`: a lookup that failed says
            // nothing about whether the rep still owes a disposition, and
            // dropping the banner would hide the reason their next dial gets
            // refused.
            pendingError = error.localizedDescription
            reportIfSessionExpired(error)
        }
    }

    private func reportIfSessionExpired(_ error: Error) {
        guard isSessionExpired(error) else { return }
        onSessionExpired()
    }
}

/// Stands in when there is no session to read with. Its message is what the
/// screen shows.
private struct SignedOutFeed: RecentCallsReading {
    struct NotSignedIn: LocalizedError {
        var errorDescription: String? { "Sign in to Salesforce to see your calls." }
    }

    func recent(limit: Int) async throws -> [CallSummary] { throw NotSignedIn() }
    func pendingDisposition() async throws -> CallSummary? { throw NotSignedIn() }
}
