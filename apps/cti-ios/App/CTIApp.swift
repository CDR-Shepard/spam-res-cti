import SwiftUI

@main
struct CTIApp: App {
    @StateObject private var engine = SyncEngine.shared
    @StateObject private var voice = VoiceRuntime.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(engine)
                .environmentObject(voice)
        }
        // Registers the BGAppRefreshTask declared in
        // Info.plist/BGTaskSchedulerPermittedIdentifiers. Uses the shared
        // engine directly: the handler runs without a view hierarchy.
        .backgroundTask(.appRefresh(AppConfig.backgroundRefreshTaskIdentifier)) {
            await SyncEngine.shared.runBackgroundRefresh()
        }
        .onChange(of: scenePhase) { _, phase in
            // Ask for the next background window as we leave — iOS only
            // accepts a request from a foreground or backgrounding app.
            if phase == .background {
                engine.scheduleBackgroundRefresh()
            }
            // Coming back to the foreground is when a spent voice token and a
            // decayed Twilio registration get put right — both expire on their
            // own, and a phone that has stopped ringing gives no other sign.
            if phase == .active {
                voice.refresh()
            }
        }
    }
}

/// No session yet: sign in. Signed in: the main tab UI.
///
/// Routes on `engine.hasSession` rather than reading `SessionTokenStore`
/// directly, so this re-renders the instant the engine's published flag
/// changes — a registration failure or an `unpair()` and there is nowhere for
/// the flag to get stuck: the next redraw sends the phone straight back here.
struct RootView: View {
    @EnvironmentObject private var engine: SyncEngine
    @EnvironmentObject private var voice: VoiceRuntime

    var body: some View {
        Group {
            if engine.hasSession {
                // The tabs are built around the live `CallController`, which
                // `VoiceRuntime` only has once `start()` below has run — so
                // there is a frame or two with a session and no softphone yet.
                if let controller = voice.controller {
                    MainTabs().environmentObject(controller)
                } else {
                    SoftphoneStartingView()
                }
            } else {
                SignInView()
            }
        }
        // The softphone is built from the session, so it can only start once
        // there is one — and must be torn down the moment there is not, or an
        // unpaired phone goes on ringing for the org it just left.
        .task(id: engine.hasSession) {
            if engine.hasSession { voice.start() } else { voice.stop() }
        }
    }
}
