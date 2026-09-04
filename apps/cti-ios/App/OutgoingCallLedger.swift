import Foundation

/// Keeps the two outgoing-call reports CallKit wants in the order CallKit
/// requires, however out of order the SDK delivers them.
///
/// `CXProvider.reportOutgoingCall(with:connectedAt:)` is silently discarded if
/// CallKit has not yet seen the call, and CallKit only sees it once the
/// `CXStartCallAction` transaction completes — an async round trip through
/// `CXCallController`. The answer, meanwhile, can arrive at once: voicemail and
/// IVRs pick up on the first ring, so `callDidConnect` routinely beats the
/// start transaction, and (because `sdk.connect` now returns at ringback) can
/// even beat `reportOutgoingStarted` being called at all.
///
/// Losing that report is not cosmetic: the system call screen reads
/// "connecting…" for the whole call, the call timer never starts, and Recents
/// shows no duration. So a connect that arrives too early is held and flushed
/// the moment CallKit knows the call — and dropped entirely if CallKit refuses
/// it, since there would be no call to report against.
///
/// A value type with no CallKit in it, so the ordering rules can be pinned
/// host-free. `LiveCallSystem` owns the only instance and serializes access.
struct OutgoingCallLedger {
    private enum State {
        /// The start transaction has been requested (or the answer beat even
        /// that), and CallKit has not confirmed the call yet. `connectedAt` is
        /// an answer waiting for somewhere to go.
        case starting(connectedAt: Date?)
        /// CallKit knows the call. `reported` guards the connect timer against
        /// being restarted by a second answer.
        case started(reported: Bool)
    }

    private var calls: [UUID: State] = [:]

    /// A `CXStartCallAction` has been handed to `CXCallController`.
    ///
    /// Deliberately preserves an answer that arrived first, rather than
    /// resetting the entry — that ordering is the whole reason this exists.
    mutating func startRequested(_ uuid: UUID) {
        if calls[uuid] == nil { calls[uuid] = .starting(connectedAt: nil) }
    }

    /// The start transaction completed and CallKit now has the call. Returns a
    /// held answer to report immediately, if one was waiting.
    mutating func startSucceeded(_ uuid: UUID) -> Date? {
        guard case let .starting(held) = calls[uuid] else { return nil }
        calls[uuid] = .started(reported: held != nil)
        return held
    }

    /// CallKit refused the call. It will never know this UUID, so the held
    /// answer is dropped rather than reported against a call the system does
    /// not have.
    mutating func startFailed(_ uuid: UUID) {
        calls[uuid] = nil
    }

    /// The far end answered. Returns the moment to report to CallKit, or `nil`
    /// to say "held — it is not ready for this yet" (or "already reported").
    mutating func connected(_ uuid: UUID, at moment: Date) -> Date? {
        switch calls[uuid] {
        case .none:
            // The answer beat `reportOutgoingStarted`. Hold it anyway: the
            // start request is on its way, and this is the tightest race of
            // the lot.
            calls[uuid] = .starting(connectedAt: moment)
            return nil
        case let .starting(held):
            // First answer wins — it is when the conversation actually began.
            if held == nil { calls[uuid] = .starting(connectedAt: moment) }
            return nil
        case .started(reported: false):
            calls[uuid] = .started(reported: true)
            return moment
        case .started(reported: true):
            return nil
        }
    }

    /// The call is over. Forgetting it keeps the ledger bounded and stops a
    /// late callback reporting against a dead UUID.
    mutating func ended(_ uuid: UUID) {
        calls[uuid] = nil
    }
}
