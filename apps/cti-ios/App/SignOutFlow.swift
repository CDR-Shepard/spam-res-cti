import Foundation

/// The Sign out button's whole job, pulled out of `StatusView` so its order —
/// and the guarantee that follows from it — can be pinned by a host-free test
/// instead of trusted to a SwiftUI tap handler.
///
/// `stopVoice` (`VoiceRuntime.stop()`, which best-effort unregisters this
/// handset from Twilio via `PushRegistry.stop()`) runs first, while the app
/// still counts as signed in: the Twilio unregister needs the in-memory voice
/// token cache and the live push registry, both of which the runtime tears
/// down as part of stopping. Running `unpair` first flips `hasSession`, and
/// the root view swaps to sign-in while the binding may still be live — so
/// the order is a contract, pinned by SignOutFlowTests, not an accident.
///
/// `unpair` always runs, even when `stopVoice` throws: it is what actually
/// signs the phone out, and a rep who taps Sign out and lands on `SignInView`
/// must be signed out whether or not the best-effort Twilio call succeeded.
enum SignOutFlow {
    static func run(stopVoice: () throws -> Void, unpair: () -> Void) {
        try? stopVoice()
        unpair()
    }
}
