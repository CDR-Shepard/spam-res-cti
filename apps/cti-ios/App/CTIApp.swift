import SwiftUI

@main
struct CTIApp: App {
    @StateObject private var engine = SyncEngine.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(engine)
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
        }
    }
}

/// No session yet: sign in. Signed in: the main tab UI — until Task 10 builds
/// it, `StatusView` stands in.
///
/// Routes on `engine.hasSession` rather than reading `SessionTokenStore`
/// directly, so this re-renders the instant the engine's published flag
/// changes — a registration failure or an `unpair()` and there is nowhere for
/// the flag to get stuck: the next redraw sends the phone straight back here.
struct RootView: View {
    @EnvironmentObject private var engine: SyncEngine

    var body: some View {
        if engine.hasSession {
            // TASK 10 ROUTING POINT: replace `StatusView()` with the main tab UI.
            StatusView()
        } else {
            SignInView()
        }
    }
}
