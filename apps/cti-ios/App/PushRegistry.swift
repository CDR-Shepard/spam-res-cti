import Foundation
import PushKit
import os

/// VoIP push: getting the token, and turning a push into a ringing phone.
///
/// **App-lifetime, and armed at launch.** `desiredPushTypes = [.voIP]` is set
/// from `application(_:didFinishLaunchingWithOptions:)` (see `AppDelegate`),
/// signed in or not, because that is what Apple requires and what makes a push
/// that COLD-LAUNCHES the app — after a force-quit, or a jetsam kill —
/// delivered at all. Arming it from a SwiftUI `.task` instead meant a phone
/// that had been force-quit simply never rang.
///
/// The consequence is that a push can arrive before there is anything to ring
/// it with, so the receive path is split: `attach`/`detach` hand it the
/// softphone graph when the rep signs in and take it away when they sign out,
/// and `voicePushRoute` decides what a push is owed either way.
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
    /// One per process, because PushKit is: a second `PKPushRegistry` asking
    /// for `.voIP` would race this one for every push.
    static let shared = PushRegistry()

    /// The softphone graph, present only while signed in. Everything that can
    /// actually ring a call lives in here, so "is anything attached" is one
    /// question with one answer.
    private struct Attachment {
        let controller: CallController
        let system: CallSystem
        let sdk: VoiceSDK
        let tokens: VoiceTokenRefresher
        let baseURL: URL
    }

    private var attachment: Attachment?

    /// The paired-device bearer for `POST /mobile/voip-token`. A closure, not
    /// a value, so an unpair-and-repair is picked up without rebuilding this.
    private let deviceToken: () -> String?
    private let transport: PairingTransport
    private let log = Logger(subsystem: AppConfig.loggingSubsystem, category: "VoIPPush")

    private var registry: PKPushRegistry?
    /// In memory only, deliberately. PushKit re-delivers the credentials
    /// through `didUpdate` every time `desiredPushTypes` is set — i.e. on
    /// every launch, before any push can arrive — so a persisted copy would be
    /// a second source of truth that buys nothing and can go stale.
    /// Registering a token iOS has since invalidated is worse than waiting a
    /// moment for the real one.
    private var pushToken: Data?

    /// CallKit for a push that arrived with nothing attached. Built at most
    /// once per process, and only if that ever actually happens — a
    /// `CXProvider` retains its delegate, so one is not something to create
    /// per push and drop.
    private var fallbackSystem: LiveCallSystem?

    init(
        deviceToken: @escaping () -> String? = DeviceTokenStore.load,
        transport: @escaping PairingTransport = livePairingTransport
    ) {
        self.deviceToken = deviceToken
        self.transport = transport
    }

    /// Arms PushKit. **Call this synchronously from
    /// `application(_:didFinishLaunchingWithOptions:)`**, whether or not
    /// anyone is signed in: setting `desiredPushTypes` is what registers this
    /// process as the recipient of VoIP pushes, and a push that launched the
    /// app is delivered right after this returns. Idempotent.
    func activate() {
        guard registry == nil else { return }
        // `nil` queue means the main queue, which is what the receive path
        // needs: `CallController` is main-actor isolated and the CallKit
        // report has to happen without leaving this thread.
        let registry = PKPushRegistry(queue: nil)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    /// Hands over the signed-in softphone graph. From here a push rings a call
    /// instead of falling through to the missed-call safety net.
    @MainActor
    func attach(
        controller: CallController,
        system: CallSystem,
        sdk: VoiceSDK,
        tokens: VoiceTokenRefresher,
        baseURL: URL
    ) {
        attachment = Attachment(
            controller: controller, system: system, sdk: sdk, tokens: tokens, baseURL: baseURL
        )
        // The real graph is CallKit's owner now; a provider left over from a
        // cold-launch fallback would sit there holding its own delegate.
        fallbackSystem?.shutDown()
        fallbackSystem = nil
        refreshRegistration()
    }

    /// Sign-out. Drops the graph and tells Twilio, best effort — without that
    /// the binding survives on Twilio's side and this handset keeps being a
    /// valid destination for the org's inbound calls.
    ///
    /// **`desiredPushTypes` is deliberately left set.** Clearing it would stop
    /// pushes that are already in flight from being delivered *to an app that
    /// must still report them* — iOS does not care that the rep signed out.
    /// The safety net below is what answers them now.
    func detach() {
        let stale = pushToken
        let tokens = attachment?.tokens
        let sdk = attachment?.sdk
        attachment = nil
        guard let stale, let tokens, let sdk else { return }

        // The *cached* access token, never a fresh mint: sign-out has usually
        // cleared the Salesforce session by the time this runs, so minting
        // would fail and take the unregistration with it.
        let accessToken = tokens.cachedAccessToken
        guard !accessToken.isEmpty else { return }
        Task { [log] in
            do {
                try await sdk.unregister(accessToken: accessToken, deviceToken: stale)
            } catch {
                // Deliberately not logging the error itself: sign-out is not a
                // place to risk putting an account identifier in the log, and
                // there is nothing to retry against — the session is gone.
                log.notice("Twilio VoIP unregistration on sign-out did not complete")
            }
        }
    }

    /// Registers the PushKit token against a current voice token, minting one
    /// if the cached token is spent.
    ///
    /// Driven at launch and on every foreground, not just once: Twilio ties a
    /// registration to the access token it was made with, so a phone that
    /// registered only at install stops ringing when that token expires. A
    /// no-op until someone is signed in — there is no token to register with.
    func refreshRegistration() {
        guard let pushToken, attachment != nil else { return }
        Task { await register(pushToken: pushToken) }
    }

    // MARK: - Registration

    private func register(pushToken: Data) async {
        guard let attachment = await currentAttachment() else { return }
        do {
            let accessToken = try await attachment.tokens.current()
            try await attachment.sdk.register(accessToken: accessToken, deviceToken: pushToken)
        } catch {
            // Logged, never swallowed silently: a failed registration is the
            // difference between a phone that rings and one that does not, and
            // there is nothing on screen that would otherwise show it.
            log.error("Twilio VoIP registration failed: \(error.localizedDescription, privacy: .public)")
        }
        do {
            try await postVoipToken(pushToken, baseURL: attachment.baseURL)
        } catch {
            log.error("POST /mobile/voip-token failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    @MainActor
    private func currentAttachment() -> Attachment? { attachment }

    /// `POST /mobile/voip-token` — device-token auth (`resolveDevice`), body
    /// `{ token: <hex> }`. The bearer here is the *paired device* token, not
    /// the Salesforce session: this route authenticates a phone.
    private func postVoipToken(_ token: Data, baseURL: URL) async throws {
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
        refreshRegistration()
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        let stale = pushToken
        pushToken = nil
        guard let stale, let attachment else { return }
        Task { [log] in
            do {
                let accessToken = try await attachment.tokens.current()
                try await attachment.sdk.unregister(accessToken: accessToken, deviceToken: stale)
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
        let kind = voicePushKind(of: payload)
        switch voicePushRoute(kind: kind, runtimeAttached: attachment != nil) {
        case .ignore:
            return

        case .reportMissed:
            // Cold launch, or a signed-out phone. Nothing here can ring, and
            // iOS still requires a CallKit report before `completion()`.
            reportMissedCall(payload)

        case .ring:
            guard let controller = attachment?.controller else {
                // Unreachable — the route was decided from `attachment` on
                // this same stack — but falling through to the safety net
                // rather than returning keeps the invariant absolute: a call
                // push always produces a CallKit report.
                if kind == .callInvite { reportMissedCall(payload) }
                return
            }
            // Every payload goes to the SDK first, cancels included — that is
            // how Twilio retires its own invite state.
            controller.handleIncomingPush(payload)

            switch kind {
            case .cancel:
                // The caller gave up, or another device answered. `decline()`
                // rejects the dead invite and reports the call ended to
                // CallKit; it is a no-op when nothing is ringing.
                controller.decline()

            case .callInvite:
                // If the controller is not ringing, no call was reported:
                // either the SDK gave back no invite, or the phone was already
                // on a call and refused this one. Either way iOS is owed a
                // report, so it gets a real missed call rather than a
                // terminated app.
                if case .ringing = controller.phase { return }
                reportMissedCall(payload)

            case .other:
                break
            }
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
        let system = callKitForFallback()
        log.notice("VoIP call push produced no ring; reporting it as missed")
        system.reportIncoming(uuid: uuid, title: info.displayTitle, handle: info.number) { _ in
            // Ended whether or not CallKit accepted it: if it refused, there
            // is no call and this does nothing.
            system.reportEnded(uuid: uuid)
        }
    }

    /// The signed-in graph's CallKit when there is one; otherwise a provider of
    /// this registry's own, built once and kept, because a cold-launch push has
    /// to be reported before anything else in this app exists.
    @MainActor
    private func callKitForFallback() -> CallSystem {
        if let system = attachment?.system { return system }
        if let fallbackSystem { return fallbackSystem }
        let system = LiveCallSystem()
        fallbackSystem = system
        return system
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
