import UIKit

/// The one thing that genuinely cannot wait for SwiftUI.
///
/// `PKPushRegistry.desiredPushTypes = [.voIP]` has to be set in
/// `application(_:didFinishLaunchingWithOptions:)` — Apple is explicit about
/// it, and the reason is the case that matters most: a VoIP push that
/// *launches* the app. After a force-quit, a jetsam kill, or a reboot, iOS
/// starts the process, calls this method, and delivers the push. Arming the
/// registry from a SwiftUI `.task` instead meant that push arrived at a
/// process that had not asked for it — so a rep who had swiped the app away
/// simply stopped receiving calls, with nothing anywhere to say so.
///
/// The registry is armed **whether or not anyone is signed in**: iOS requires
/// a CallKit report for every call push it delivers, signed in or not, and
/// `PushRegistry` has a report-then-end safety net for exactly that. Starting
/// the softphone here as well is what makes a cold-launch push actually
/// *ring*: `VoiceRuntime.start()` is idempotent and a no-op without a session,
/// and doing it synchronously on this stack means the graph is usually
/// attached before the push is delivered. `RootView` still starts and stops it
/// on every later session change.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PushRegistry.shared.activate()
        VoiceRuntime.shared.start()
        return true
    }
}
