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
    private var push: PushRegistry?
    private var refresher: VoiceTokenRefresher?

    init(sessions: SessionTokenStoring = SessionTokenStore()) {
        self.sessions = sessions
    }

    /// Idempotent, and a no-op until there is a session to call with.
    func start() {
        guard controller == nil, let session = sessions.load() else { return }
        let baseURL = AppConfig.baseURL

        let refresher = VoiceTokenRefresher(fetch: { try await Self.mintVoiceToken(baseURL: baseURL) })
        let system = LiveCallSystem()
        let controller = CallController(
            sdk: sdk,
            system: system,
            api: LiveCallsAPI(baseURL: baseURL, sessionToken: session),
            // Synchronous by contract: a dial must not be able to await
            // between the server's "allowed" and `sdk.connect`. The cache is
            // kept warm by `refresh()` below.
            tokens: { refresher.cachedAccessToken }
        )
        system.controller = controller

        let push = PushRegistry(
            controller: controller, system: system, sdk: sdk, tokens: refresher, baseURL: baseURL
        )

        self.refresher = refresher
        self.system = system
        self.controller = controller
        self.push = push

        push.start()
        refresh()
    }

    /// Mints a token if the cached one is spent and re-registers for VoIP
    /// push. Cheap when everything is current; driven at launch and on every
    /// foreground, because both the token and Twilio's registration expire.
    func refresh() {
        guard let refresher, let push else { return }
        Task { [log] in
            do {
                _ = try await refresher.current()
            } catch {
                log.error("voice token mint failed: \(error.localizedDescription, privacy: .public)")
            }
            push.refreshRegistration()
        }
    }

    /// Sign-out. Drops the whole graph, including the PushKit registration —
    /// leaving it up would keep ringing this phone for an org it has left.
    func stop() {
        push?.stop()
        push = nil
        system?.shutDown()
        system = nil
        controller = nil
        refresher = nil
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
