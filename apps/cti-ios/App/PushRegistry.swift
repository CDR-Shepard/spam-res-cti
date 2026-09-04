import Foundation
import PushKit
import os

/// VoIP push: getting the token, and turning a push into a ringing phone.
///
/// The receive path has a deadline attached to it. iOS gives an app one
/// delegate call to report an incoming call to CallKit, and an app that takes
/// a VoIP push without reporting one is terminated — repeatedly, until the
/// system revokes its VoIP entitlement. So
/// `pushRegistry(_:didReceiveIncomingPushWith:for:completion:)` does the whole
/// thing on its own stack: hand the payload to the Twilio SDK, let
/// `CallController` report the ring, and only then call `completion()`.
/// Nothing on that path awaits anything.
///
/// The registration path has no deadline and does await: mint a voice token,
/// register it with Twilio against the PushKit token, and tell our own server
/// about the PushKit token so the softphone can see the device is reachable.
final class PushRegistry: NSObject {
    private enum Keys {
        /// The PushKit token, kept in `UserDefaults` on purpose: it is a
        /// routing address, not a credential — unlike the device and session
        /// tokens, which are Keychain-only.
        static let voipToken = "voipPushToken"
    }

    private let controller: CallController
    private let system: CallSystem
    private let sdk: VoiceSDK
    private let tokens: VoiceTokenRefresher
    private let baseURL: URL
    /// The paired-device bearer for `POST /mobile/voip-token`. A closure, not
    /// a value, so an unpair-and-repair is picked up without rebuilding this.
    private let deviceToken: () -> String?
    private let transport: PairingTransport
    private let defaults: UserDefaults
    private let log = Logger(subsystem: AppConfig.loggingSubsystem, category: "VoIPPush")

    private var registry: PKPushRegistry?
    private var pushToken: Data?

    init(
        controller: CallController,
        system: CallSystem,
        sdk: VoiceSDK,
        tokens: VoiceTokenRefresher,
        baseURL: URL,
        deviceToken: @escaping () -> String? = DeviceTokenStore.load,
        transport: @escaping PairingTransport = livePairingTransport,
        defaults: UserDefaults = .standard
    ) {
        self.controller = controller
        self.system = system
        self.sdk = sdk
        self.tokens = tokens
        self.baseURL = baseURL
        self.deviceToken = deviceToken
        self.transport = transport
        self.defaults = defaults
    }

    /// Starts listening for VoIP pushes. Idempotent.
    func start() {
        guard registry == nil else { return }
        // `nil` queue means the main queue, which is what the receive path
        // needs: `CallController` is main-actor isolated and the CallKit
        // report has to happen without leaving this thread.
        let registry = PKPushRegistry(queue: nil)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    /// Stops listening. Sign-out only: a phone that is no longer signed in
    /// must not go on ringing for the org it left.
    func stop() {
        registry?.desiredPushTypes = []
        registry?.delegate = nil
        registry = nil
    }

    /// Registers the PushKit token against a current voice token, minting one
    /// if the cached token is spent.
    ///
    /// Driven at launch and on every foreground, not just once: Twilio ties a
    /// registration to the access token it was made with, so a phone that
    /// registered only at install stops ringing when that token expires.
    func refreshRegistration() {
        guard let pushToken else { return }
        Task { await register(pushToken: pushToken) }
    }

    // MARK: - Registration

    private func register(pushToken: Data) async {
        do {
            let accessToken = try await tokens.current()
            try await sdk.register(accessToken: accessToken, deviceToken: pushToken)
        } catch {
            // Logged, never swallowed silently: a failed registration is the
            // difference between a phone that rings and one that does not, and
            // there is nothing on screen that would otherwise show it.
            log.error("Twilio VoIP registration failed: \(error.localizedDescription, privacy: .public)")
        }
        do {
            try await postVoipToken(pushToken)
        } catch {
            log.error("POST /mobile/voip-token failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// `POST /mobile/voip-token` — device-token auth (`resolveDevice`), body
    /// `{ token: <hex> }`. The bearer here is the *paired device* token, not
    /// the Salesforce session: this route authenticates a phone.
    private func postVoipToken(_ token: Data) async throws {
        guard let bearer = deviceToken() else { throw VoipTokenPostFailed.notPaired }
        let body = try JSONEncoder().encode(["token": token.hexEncoded])
        let request = authedRequest(
            baseURL: baseURL, path: "mobile/voip-token", sessionToken: bearer, method: "POST", body: body
        )
        let (_, status) = try await transport(request)
        guard (200..<300).contains(status) else { throw VoipTokenPostFailed.server(status: status) }
    }
}

// MARK: - PKPushRegistryDelegate

extension PushRegistry: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        pushToken = credentials.token
        defaults.set(credentials.token.hexEncoded, forKey: Keys.voipToken)
        refreshRegistration()
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        let stale = pushToken
        pushToken = nil
        defaults.removeObject(forKey: Keys.voipToken)
        guard let stale else { return }
        Task { [sdk, tokens, log] in
            do {
                let accessToken = try await tokens.current()
                try await sdk.unregister(accessToken: accessToken, deviceToken: stale)
            } catch {
                log.error("Twilio VoIP unregistration failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// The deadline path.
    ///
    /// Order, and it is the whole point of this method:
    /// 1. `controller.handleIncomingPush` — synchronous, and inside it
    ///    `LiveVoiceSDK.handleIncomingPush` (synchronous, per Twilio's header)
    ///    then `CallSystem.reportIncoming` → `CXProvider.reportNewIncomingCall`
    ///    (synchronous, per `CallSystem`'s contract).
    /// 2. The cancel / no-ring cases below, which still owe CallKit something.
    /// 3. `completion()`, exactly once, on every path.
    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else {
            completion()
            return
        }
        let dictionary = payload.dictionaryPayload
        onMainActorSynchronously { [self] in
            deliver(dictionary)
        }
        completion()
    }

    @MainActor
    private func deliver(_ payload: [AnyHashable: Any]) {
        // Every payload goes to the SDK first, cancels included — that is how
        // Twilio retires its own invite state.
        controller.handleIncomingPush(payload)

        switch voicePushKind(of: payload) {
        case .cancel:
            // The caller gave up, or another device answered. `decline()`
            // rejects the dead invite and reports the call ended to CallKit;
            // it is a no-op when nothing is ringing.
            controller.decline()

        case .callInvite:
            // If the controller is not ringing, no call was reported: either
            // the SDK gave back no invite, or the phone was already on a call
            // and refused this one. Either way iOS is owed a report, so it
            // gets a real missed call rather than a terminated app.
            if case .ringing = controller.phase { return }
            reportMissedCall(payload)

        case .other:
            break
        }
    }

    /// The last-resort CallKit report: shown and immediately ended, so the rep
    /// sees a missed call from the number that rang and iOS sees the report it
    /// requires.
    @MainActor
    private func reportMissedCall(_ payload: [AnyHashable: Any]) {
        // `CallerInfo`'s own conventions, so a fallback ring is labelled the
        // same way a real one is — including the empty handle a withheld
        // caller gets.
        let info = CallerInfo(
            number: voicePushCallerNumber(in: payload) ?? "", name: nil, recordId: nil, recordType: nil
        )
        let uuid = UUID()
        log.notice("VoIP call push produced no ring; reporting it as missed")
        system.reportIncoming(uuid: uuid, title: info.displayTitle, handle: info.number) { [system] _ in
            // Ended whether or not CallKit accepted it: if it refused, there
            // is no call and this does nothing.
            system.reportEnded(uuid: uuid)
        }
    }

    /// Runs `body` on the main actor **without returning first**.
    ///
    /// `Task { @MainActor in }` would not do: it runs after this delegate
    /// method returns, which is exactly the ordering iOS kills the app for.
    /// The registry's queue is `nil` (the main queue), so in practice this is
    /// always the first branch.
    private func onMainActorSynchronously(_ body: @MainActor () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { body() }
        } else {
            DispatchQueue.main.sync { MainActor.assumeIsolated { body() } }
        }
    }
}

/// Why the server would not take this phone's VoIP token. Both are worth
/// distinguishing in a log: one means the phone is not paired at all, the
/// other means it is and the server said no.
enum VoipTokenPostFailed: LocalizedError, Equatable {
    case notPaired
    case server(status: Int)

    var errorDescription: String? {
        switch self {
        case .notPaired: return "This iPhone is not paired, so its VoIP token cannot be registered."
        case let .server(status): return "The server refused the VoIP token (HTTP \(status))."
        }
    }
}

private extension Data {
    /// Lowercase hex, which is what `POST /mobile/voip-token` expects (and
    /// what Twilio's console shows for a device binding).
    var hexEncoded: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
