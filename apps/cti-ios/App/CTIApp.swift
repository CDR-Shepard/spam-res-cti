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
struct RootView: View {
    var body: some View {
        if SessionTokenStore.load() == nil {
            SignInView()
        } else {
            // TASK 10 ROUTING POINT: replace `StatusView()` with the main tab UI.
            StatusView()
        }
    }
}
