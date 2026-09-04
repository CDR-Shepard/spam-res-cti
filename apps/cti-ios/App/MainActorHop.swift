import Foundation

// -----------------------------------------------------------------------------
// Getting onto the main actor from the framework callbacks that surround the
// softphone — CallKit's provider delegate, PushKit's registry delegate, Twilio's
// call and notification delegates.
//
// All of them are documented as arriving on the main queue, and `CallController`
// is main-actor isolated, so the ordinary path must be a straight call rather
// than a scheduled one. Both helpers exist because two of those callers have
// deadlines that a `Task` would miss.
// -----------------------------------------------------------------------------

/// Runs `body` on the main actor, without a hop when it is already there.
///
/// Callbacks the app hands out (`CallSystem.reportIncoming`'s completion,
/// `ActiveCall.onDisconnect`) are documented as main-thread, and the direct
/// call keeps them synchronous — CallKit's refusal has to reject the invite on
/// the same stack that reported it, and a CallKit action has to be fulfilled
/// promptly rather than a turn later. The hop is the safety net for a caller
/// that violates the contract: a wrong thread should cost a hop, not trap
/// `assumeIsolated` in the middle of a call.
func onMainActor(_ body: @escaping @MainActor () -> Void) {
    if Thread.isMainThread {
        MainActor.assumeIsolated { body() }
    } else {
        Task { @MainActor in body() }
    }
}

/// Runs `body` on the main actor **before returning**.
///
/// For the one path where deferring is fatal: iOS terminates an app that takes
/// a VoIP push and does not report a call to CallKit before the PushKit
/// delegate method returns, and `Task { @MainActor in }` runs only *after* it
/// returns. The blocking branch cannot deadlock — it is unreachable from the
/// main thread — and in practice is never taken, since PushKit is given a `nil`
/// queue and so delivers on the main queue already.
func onMainActorSynchronously(_ body: @MainActor () -> Void) {
    if Thread.isMainThread {
        MainActor.assumeIsolated { body() }
    } else {
        DispatchQueue.main.sync { MainActor.assumeIsolated { body() } }
    }
}
