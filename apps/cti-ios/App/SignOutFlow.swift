import Foundation

/// The Sign out button's whole job, pulled out of `StatusView` so its order —
/// and the guarantee that follows from it — can be pinned by a host-free test
/// instead of trusted to a SwiftUI tap handler.
///
/// `stopVoice` (`VoiceRuntime.stop()`, which best-effort unregisters this
/// handset from Twilio via `PushRegistry.stop()`) runs first, while the
/// session token `unpair` is about to delete is still on file. Twilio's
/// unregister uses that session's cached access token — run the two calls in
/// the other order and every sign-out silently downgrades to "stop ringing
/// locally," leaving the Twilio binding live for an org this phone just left.
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
