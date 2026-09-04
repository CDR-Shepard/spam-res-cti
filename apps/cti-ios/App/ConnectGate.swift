import Foundation

/// Answers an outbound `connect` exactly once, from whichever Twilio callback
/// gets there first.
///
/// The server dials with `answerOnBridge: true`
/// (`services/cti-api/src/routes/telephony.ts`), which changes when
/// `callDidConnect` arrives: not when the leg is up, but when the *callee*
/// picks up. `TVOCallDelegate.h` says as much on `callDidStartRinging:` —
/// "This callback is invoked once before the `[TVOCallDelegate callDidConnect:]`
/// callback. If the `answerOnBridge` is `true` this represents the callee is
/// being alerted of a Call."
///
/// So waiting for `callDidConnect` would park the entire ringback inside
/// `sdk.connect`: no `ActiveCall` handed back, so `CallController` never
/// leaves `.dialing`, CallKit never hears about the call, and the rep has no
/// way to give up on a phone that rings out. Ringing answers the connect
/// instead, and everything after it — the answer, a failure, a drop — finds
/// the gate already settled and is routed onward by the caller.
///
/// Its own type because the rule is worth a test and `TVOCall` cannot be built
/// in a host-free bundle.
final class ConnectGate {
    private let lock = NSLock()
    private var settled = false
    private var deliver: ((Error?) -> Void)?

    /// `deliver` is called at most once, with `nil` for "the call is live" and
    /// an error for "it never will be".
    init(_ deliver: @escaping (Error?) -> Void) {
        self.deliver = deliver
    }

    /// Settles the connect.
    ///
    /// Returns `false` when it was already settled — which is the caller's
    /// instruction to route this event onward (to the disconnect latch, and so
    /// to the rep's wrap-up) rather than drop it. Resuming a continuation
    /// twice is a crash, not a bug, so this is the only place that decides.
    @discardableResult
    func settle(_ error: Error?) -> Bool {
        let handler: ((Error?) -> Void)? = lock.withLock {
            guard !settled else { return nil }
            settled = true
            defer { deliver = nil }
            return deliver
        }
        guard let handler else { return false }
        handler(error)
        return true
    }
}
