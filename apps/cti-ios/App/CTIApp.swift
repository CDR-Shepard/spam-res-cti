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

/// Paired phones go straight to the status screen; everything else pairs first.
struct RootView: View {
    @EnvironmentObject private var engine: SyncEngine

    var body: some View {
        if engine.isPaired {
            StatusView()
        } else {
            PairView()
        }
    }
}
