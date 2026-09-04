import Foundation
import TwilioVoice
import os

/// The `VoiceSDK` the app actually ships: a thin shell over `TwilioVoiceSDK`.
///
/// Everything interesting about a call is in `CallController`; this file only
/// translates. Two translations are load-bearing and both are about *when*
/// things happen rather than what:
///
/// 1. `handleIncomingPush` has to answer synchronously, because PushKit gives
///    the app one stack frame to report a call to CallKit before iOS kills it.
///    Twilio's header makes that possible — see `handleIncomingPush` below.
/// 2. A call can end before `CallController` has attached its disconnect
///    handler, so `LiveCall` latches the end rather than firing into the void
///    (`DisconnectLatch`).
final class LiveVoiceSDK: NSObject, VoiceSDK {
    private let log = os.Logger(subsystem: AppConfig.loggingSubsystem, category: "Voice")

    /// The invite captured during the current `handleIncomingPush` call.
    ///
    /// Only ever written by `callInviteReceived`, only ever read by the
    /// `handleNotification` call that provoked it, and cleared either side —
    /// so it is a hand-off within one stack frame, not state.
    private var capturedInvite: CallInvite?

    /// The live call, held so its `TVOCallDelegate` outlives whatever else
    /// lets go of it: Twilio does not retain the delegate, and a wrapper that
    /// deallocates while media is still up takes the disconnect callback with
    /// it — which is exactly the signal the wrap-up depends on.
    private var liveCall: LiveCall?

    // MARK: - Registration

    func register(accessToken: String, deviceToken: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            TwilioVoiceSDK.register(accessToken: accessToken, deviceToken: deviceToken) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func unregister(accessToken: String, deviceToken: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            TwilioVoiceSDK.unregister(accessToken: accessToken, deviceToken: deviceToken) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    // MARK: - Outbound

    /// Returns only once the call is actually up.
    ///
    /// Twilio hands back a `Call` object immediately, in a connecting state,
    /// and reports the outcome through the delegate. Returning that early
    /// object would put `CallController` into `.active` on a call that may
    /// never connect — and, worse, would swallow the connect error, which is
    /// the one thing the rep needs to read. So the continuation is resumed by
    /// the delegate: `callDidConnect` returns the call, `callDidFailToConnect`
    /// (or a disconnect that beats it) throws.
    func connect(accessToken: String, params: [String: String]) async throws -> ActiveCall {
        let uuid = UUID()
        let wrapper = LiveCall(uuid: uuid, log: log)
        // Held before the SDK is touched, not after: the delegate can fire
        // while `connect` is still returning.
        liveCall = wrapper
        wrapper.onFinished = { [weak self, weak wrapper] in
            guard let self, self.liveCall === wrapper else { return }
            self.liveCall = nil
        }

        let options = ConnectOptions(accessToken: accessToken) { builder in
            builder.params = params
            // CallKit and Twilio must agree on the call's identity, or
            // `reportOutgoingStarted` names a call the SDK has never heard of.
            builder.uuid = uuid
        }

        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                wrapper.awaitConnection(continuation)
                wrapper.adopt(TwilioVoiceSDK.connect(options: options, delegate: wrapper))
            }
        } catch {
            if liveCall === wrapper { liveCall = nil }
            throw error
        }
        return wrapper
    }

    // MARK: - Inbound

    /// Turns a VoIP push into an invite **on the caller's own stack**.
    ///
    /// Twilio guarantees this is possible, in two places:
    ///
    /// - `TwilioVoice.h`, on `handleNotification:delegate:delegateQueue:` —
    ///   "This method will synchronously process call notification payload and
    ///   call the provided delegate on the same dispatch queue."
    /// - `TVONotificationDelegate.h`, on `callInviteReceived:` — "This method
    ///   gets invoked synchronously on the same dispatch queue where the
    ///   `[TwilioVoiceSDK handleNotification:delegate:delegateQueue:callMessageDelegate:]`
    ///   is called."
    ///
    /// So the invite is captured in the delegate callback and returned from
    /// the same frame: no semaphore, no timeout, nothing to block on. A `nil`
    /// return means the payload was a cancel or not Twilio's at all —
    /// `PushRegistry` handles both, including the CallKit report iOS demands
    /// for a call push that produced no ring.
    func handleIncomingPush(payload: [AnyHashable: Any]) -> IncomingInvite? {
        capturedInvite = nil
        let recognized = TwilioVoiceSDK.handleNotification(payload, delegate: self, delegateQueue: nil)
        if !recognized {
            log.notice("VoIP push was not a Twilio notification")
        }
        guard let invite = capturedInvite else { return nil }
        capturedInvite = nil
        return LiveInvite(invite: invite, sdk: self, log: log)
    }

    /// Called by `LiveInvite.accept()`, on the main actor, inside
    /// `CallController.answer()`.
    fileprivate func adopt(_ call: LiveCall) {
        liveCall = call
        call.onFinished = { [weak self, weak call] in
            guard let self, self.liveCall === call else { return }
            self.liveCall = nil
        }
    }
}

// MARK: - TVONotificationDelegate

extension LiveVoiceSDK: NotificationDelegate {
    func callInviteReceived(callInvite: CallInvite) {
        capturedInvite = callInvite
    }

    func cancelledCallInviteReceived(cancelledCallInvite: CancelledCallInvite, error: Error) {
        // Nothing to capture: the ring is over. `PushRegistry` reads the raw
        // payload's message type and ends the CallKit call — it cannot depend
        // on this callback, because a cancel for an invite the SDK never saw
        // (app relaunched between the two pushes) does not raise it at all.
        log.notice("call invite cancelled: \(error.localizedDescription, privacy: .public)")
    }
}

// MARK: - The ringing invite

/// One `TVOCallInvite`, as `CallController` sees it.
private final class LiveInvite: IncomingInvite {
    private let invite: CallInvite
    /// Weak: the SDK does not hold invites, and the controller holds this —
    /// a strong link back would outlive the ring.
    private weak var sdk: LiveVoiceSDK?
    private let log: os.Logger

    init(invite: CallInvite, sdk: LiveVoiceSDK, log: os.Logger) {
        self.invite = invite
        self.sdk = sdk
        self.log = log
    }

    var uuid: UUID { invite.uuid }
    var from: String? { invite.from }
    var customParameters: [String: String] { invite.customParameters ?? [:] }

    func accept() -> ActiveCall {
        let wrapper = LiveCall(uuid: invite.uuid, log: log)
        sdk?.adopt(wrapper)
        // The accepted call keeps the invite's UUID, which is the one already
        // reported to CallKit — anything else and the end-call button would
        // address a call that does not exist.
        let options = AcceptOptions(callInvite: invite) { builder in
            builder.uuid = self.invite.uuid
        }
        wrapper.adopt(invite.accept(options: options, delegate: wrapper))
        return wrapper
    }

    func reject() {
        invite.reject()
    }
}

// MARK: - The live call

/// One `TVOCall`, as `CallController` sees it — plus the two things the
/// protocol demands that Twilio does not provide: a disconnect that survives
/// arriving before anyone listened (`DisconnectLatch`), and a connect that
/// completes only when the call is really up.
///
/// A fresh instance per call, always: `ActiveCall`'s contract forbids reusing
/// one wrapper across two calls, because the disconnect callback carries no
/// identity and the controller matches on object identity instead.
private final class LiveCall: NSObject, ActiveCall {
    let uuid: UUID

    private let log: os.Logger
    private let latch = DisconnectLatch()
    private var call: Call?
    /// Resumed exactly once, by whichever delegate callback lands first.
    private var connection: CheckedContinuation<Void, Error>?
    /// Told when this call is over, so the SDK can stop holding it.
    var onFinished: (() -> Void)?

    init(uuid: UUID, log: os.Logger) {
        self.uuid = uuid
        self.log = log
    }

    var onDisconnect: ((Error?) -> Void)? {
        get { latch.onDisconnect }
        set { latch.onDisconnect = newValue }
    }

    func awaitConnection(_ continuation: CheckedContinuation<Void, Error>) {
        connection = continuation
    }

    func adopt(_ call: Call) {
        self.call = call
    }

    func hangUp() {
        call?.disconnect()
    }

    func setMuted(_ on: Bool) {
        call?.isMuted = on
    }

    func sendDigits(_ digits: String) {
        call?.sendDigits(digits)
    }

    /// Resumes the connect continuation if one is still waiting, and says
    /// whether it did — a failure that lands before the call was ever handed
    /// to the controller is a thrown `connect`, not a disconnect.
    private func resumeConnection(throwing error: Error?) -> Bool {
        guard let connection else { return false }
        self.connection = nil
        if let error { connection.resume(throwing: error) } else { connection.resume() }
        return true
    }
}

// MARK: - TVOCallDelegate

extension LiveCall: CallDelegate {
    func callDidConnect(call: Call) {
        _ = resumeConnection(throwing: nil)
    }

    func callDidFailToConnect(call: Call, error: Error) {
        log.error("call failed to connect: \(error.localizedDescription, privacy: .public)")
        if !resumeConnection(throwing: error) { latch.fire(error) }
        onFinished?()
    }

    func callDidDisconnect(call: Call, error: Error?) {
        if let error {
            log.error("call disconnected: \(error.localizedDescription, privacy: .public)")
        }
        // A disconnect can beat `callDidConnect` — the far end rejecting an
        // outbound leg looks exactly like this. Then it is the connect that
        // failed, and the controller must learn about it by `connect`
        // throwing rather than through a handler it has not attached yet.
        if !resumeConnection(throwing: error ?? CallEndedBeforeConnecting()) {
            latch.fire(error)
        }
        onFinished?()
    }
}

/// A call that ended before it ever connected, with no error of Twilio's to
/// explain it — the far end hung up, or rejected the leg outright.
struct CallEndedBeforeConnecting: LocalizedError {
    var errorDescription: String? { "The call ended before it connected." }
}
