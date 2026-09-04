import Foundation
import os

/// Builds the softphone out of its live parts, once the phone is signed in,
/// and takes it apart again when it is not.
///
/// The graph is small and the order in it matters:
///
/// ```
/// LiveVoiceSDK ─┐
/// LiveCallSystem├─→ CallController ←─weak─ LiveCallSystem.controller
/// LiveCallsAPI ─┘         ↑
/// VoiceTokenRefresher ────┘ (cached token, read synchronously at dial time)
/// PushRegistry ───────────┘ (pushes in, registration out)
/// ```
///
/// `LiveCallSystem` needs the controller and the controller needs the system,
/// so the back-link is made after construction and is **weak** — CallKit's
/// provider outlives any one call, and a strong link would pin a controller
/// behind it forever.
@MainActor
final class VoiceRuntime: ObservableObject {
    static let shared = VoiceRuntime()

    /// The live call state machine, once signed in. Task 10's UI observes it;
    /// until then it exists so that an inbound call still rings.
    @Published private(set) var controller: CallController?

    private let sdk = LiveVoiceSDK()
    private let sessions: SessionTokenStoring
    private let log = Logger(subsystem: AppConfig.loggingSubsystem, category: "VoiceRuntime")

    private var system: LiveCallSystem?
    private var refresher: VoiceTokenRefresher?
    /// Fires the sign-out once, however many calls report the 401 — see
    /// `SessionExpiryLatch`. Rebuilt by every `start()`, so the next sign-in
    /// begins unfired.
    private var expiry: SessionExpiryLatch?

    init(sessions: SessionTokenStoring = SessionTokenStore()) {
        self.sessions = sessions
    }

    /// Idempotent, and a no-op until there is a session to call with.
    func start() {
        guard controller == nil, let session = sessions.load() else { return }
        let baseURL = AppConfig.baseURL

        let expiry = SessionExpiryLatch { [weak self] in self?.signOutAfterExpiry() }
        let refresher = VoiceTokenRefresher(fetch: sessionExpiryWatching(
            { try await Self.mintVoiceToken(baseURL: baseURL) },
            onSessionExpired: { expiry.fire() }
        ))
        let system = LiveCallSystem()
        let controller = CallController(
            sdk: sdk,
            system: system,
            api: LiveCallsAPI(baseURL: baseURL, sessionToken: session),
            // Synchronous by contract: a dial must not be able to await
            // between the server's "allowed" and `sdk.connect`. The cache is
            // kept warm by `refresh()` below.
            tokens: { refresher.cachedAccessToken },
            onSessionExpired: { expiry.fire() }
        )
        system.controller = controller

        // The caller gave up before the rep answered. This is the only live
        // cancellation signal the SDK has (`RingCancellation.swift`), and it
        // arrives with a UUID and nothing else — hence the match here, where
        // both the outstanding invites and the controller's phase are visible.
        sdk.onCancelledInvite = { [weak self] uuid in
            guard let self, let controller = self.controller else { return }
            var isRinging = false
            if case .ringing = controller.phase { isRinging = true }
            guard shouldDeclineCancelledInvite(
                uuid, outstanding: self.sdk.outstandingInviteIDs, controllerIsRinging: isRinging
            ) else { return }
            controller.decline()
        }

        // `sdk.connect` now returns at ringback, so CallKit has to be told
        // separately when the callee actually picks up.
        sdk.onOutboundCallConnected = { [weak system] uuid in
            system?.reportOutgoingConnected(uuid: uuid)
        }

        self.refresher = refresher
        self.system = system
        self.controller = controller
        self.expiry = expiry

        // The registry itself was started at launch (see `AppDelegate`); this
        // only hands it the graph that can actually ring a call.
        PushRegistry.shared.attach(
            controller: controller, system: system, sdk: sdk, tokens: refresher, baseURL: baseURL
        )
        refresh()
    }

    /// Mints a token if the cached one is spent and re-registers for VoIP
    /// push. Cheap when everything is current; driven at launch and on every
    /// foreground, because both the token and Twilio's registration expire.
    func refresh() {
        guard let refresher else { return }
        Task { [log] in
            do {
                _ = try await refresher.current()
            } catch {
                log.error("voice token mint failed: \(error.localizedDescription, privacy: .public)")
            }
            PushRegistry.shared.refreshRegistration()
        }
    }

    /// A session-authenticated call came back 401 — see `isSessionExpired`.
    ///
    /// Also reachable from `CallsFeedStore` (the Recents/pending reads), which
    /// has no runtime of its own to report to. Safe before `start()`: with no
    /// latch there is no signed-in graph to tear down.
    func noteSessionExpired() {
        expiry?.fire()
    }

    /// What an expired session actually costs: the same sequence the Sign out
    /// button runs. Signing in again is the only fix, so the phone goes there
    /// in one step rather than retrying a session that is gone — and
    /// `SyncEngine.sessionExpired` is what makes that screen say why.
    private func signOutAfterExpiry() {
        let engine = SyncEngine.shared
        engine.noteSessionExpired()
        Task { [weak self] in
            await SignOutFlow.run(
                revokeDevice: SignOutFlow.liveDeviceRevoker(deviceId: engine.deviceId),
                stopVoice: { self?.stop() },
                unpair: engine.unpair
            )
        }
    }

    /// Sign-out. Drops the whole graph and detaches from the push registry —
    /// leaving it attached would keep ringing this phone for an org it has
    /// left. The registry itself stays alive and still wants `[.voIP]`: a push
    /// that arrives for a signed-out phone must still be reported to CallKit,
    /// or iOS terminates the app for taking it silently.
    func stop() {
        sdk.onCancelledInvite = nil
        sdk.onOutboundCallConnected = nil
        // Before the graph is dropped: this is what tells Twilio to stop
        // routing this org's calls to this handset.
        PushRegistry.shared.detach()
        system?.shutDown()
        system = nil
        controller = nil
        refresher = nil
        expiry = nil
    }

    /// `POST /telephony/token`, composed from the pure pieces Task 7 pinned.
    ///
    /// Reads the session from the Keychain on every mint rather than capturing
    /// it: a token minted against a session that has since been replaced would
    /// fail at the worst possible moment.
    private static func mintVoiceToken(baseURL: URL) async throws -> VoiceToken {
        guard let session = SessionTokenStore().load() else { throw VoiceRuntimeError.notSignedIn }
        let request = try voiceTokenRequest(baseURL: baseURL, sessionToken: session)
        let (data, status) = try await livePairingTransport(request)
        return try decodeVoiceToken(data, status: status)
    }
}

enum VoiceRuntimeError: LocalizedError, Equatable {
    case notSignedIn

    var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Sign in to Salesforce before placing or receiving calls."
        }
    }
}
