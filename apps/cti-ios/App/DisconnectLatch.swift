import Foundation

/// Remembers that a call ended, so the end survives being reported before
/// anyone was listening.
///
/// `ActiveCall.onDisconnect` is attached by `CallController` *after* the SDK
/// hands the call back, and a call can die inside that gap — an outbound leg
/// the far end rejects, a network that drops between `connect` returning and
/// the handler being wired. Without the replay, that disconnect goes nowhere:
/// the app sits in `.active` on dead media, the rep gets no wrap-up, and their
/// next dial is refused by the server's disposition gate with nothing on
/// screen to explain it.
///
/// Separated from the Twilio wrapper on purpose — the wrapper cannot be built
/// in a host-free test bundle, and this is the part with the rule in it.
///
/// Not an actor: the handler is documented as arriving on the main thread, and
/// an actor would make every delivery a hop, which is exactly what the main-
/// thread contract exists to avoid.
final class DisconnectLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    private var error: Error?
    /// Whether the stored disconnect has already been handed to a handler.
    /// Once spent it stays spent: a handler attached later belongs to a call
    /// that is already over, and firing at it again would end whatever the
    /// controller is doing now.
    private var replayed = false
    private var handler: ((Error?) -> Void)?

    /// Set by `CallController` when it takes ownership of the call, cleared
    /// when it lets go. Setting a handler after the call has already ended
    /// delivers that end immediately.
    var onDisconnect: ((Error?) -> Void)? {
        get { lock.withLock { handler } }
        set { attach(newValue) }
    }

    private func attach(_ new: ((Error?) -> Void)?) {
        let replay: ((Error?) -> Void)? = lock.withLock {
            handler = new
            guard let new, fired, !replayed else { return nil }
            replayed = true
            return new
        }
        if let replay {
            let stored = lock.withLock { error }
            deliver { replay(stored) }
        }
    }

    /// The call ended. Only the first end counts — Twilio can raise both
    /// `callDidFailToConnect` and `callDidDisconnect` for one dead call, and
    /// the controller must see one ending, not two.
    func fire(_ error: Error?) {
        let attached: ((Error?) -> Void)? = lock.withLock {
            guard !fired else { return nil }
            fired = true
            self.error = error
            guard let handler else { return nil }
            replayed = true
            return handler
        }
        if let attached { deliver { attached(error) } }
    }

    /// Main thread, and without a hop when already there: the controller reads
    /// and rewrites call state in the handler, and a deferred delivery would
    /// let a stale `.active` be observed in between.
    private func deliver(_ body: @escaping () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.async(execute: body)
        }
    }
}
