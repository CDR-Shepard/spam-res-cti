import CallKit
import SwiftUI
import UIKit

/// What a paired phone shows: how much of the directory it holds, whether iOS
/// is actually using it, and the two things a rep can do about it — refresh,
/// or go turn the extension on.
struct StatusView: View {
    @EnvironmentObject private var engine: SyncEngine
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            List {
                Section("Directory") {
                    LabeledContent("Entries", value: engine.entryCount.formatted())
                    LabeledContent("Version", value: engine.version.map(String.init) ?? "—")
                    LabeledContent("Last sync", value: lastSyncText)
                }

                Section {
                    LabeledContent("Caller ID", value: extensionStatusText)
                    if engine.extensionEnabled != .enabled {
                        Button("Open Phone settings", action: openCallDirectorySettings)
                    }
                } header: {
                    Text("iPhone setting")
                } footer: {
                    Text("Settings → Apps → Phone → Call Blocking & Identification → CTI Caller ID.")
                }

                if case let .failed(message) = engine.status {
                    Section {
                        Text(message).foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await engine.sync() }
                    } label: {
                        HStack {
                            Text("Refresh now")
                            Spacer()
                            if engine.status == .syncing { ProgressView() }
                        }
                    }
                    .disabled(engine.status == .syncing)

                    Button("Unpair this iPhone", role: .destructive) {
                        engine.unpair()
                    }
                    .disabled(engine.status == .syncing)
                }
            }
            .navigationTitle(engine.pairedUserName ?? "CTI Caller ID")
            .refreshable { await engine.sync() }
            // Foreground appear: once on launch…
            .task { await engine.sync() }
            // …and again whenever the app comes back from the background.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    Task { await engine.sync() }
                }
            }
        }
    }

    private var lastSyncText: String {
        guard let lastSyncedAt = engine.lastSyncedAt else { return "Never" }
        return lastSyncedAt.formatted(date: .abbreviated, time: .shortened)
    }

    private var extensionStatusText: String {
        switch engine.extensionEnabled {
        case .enabled: return "On"
        case .disabled: return "Off"
        case .unknown: return "Unknown"
        @unknown default: return "Unknown"
        }
    }

    /// CallKit's own deep link lands directly on Call Blocking &
    /// Identification; if the system declines, fall back to this app's page in
    /// Settings, which is always reachable.
    private func openCallDirectorySettings() {
        CXCallDirectoryManager.sharedInstance.openSettings { error in
            guard error != nil else { return }
            Task { @MainActor in
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            }
        }
    }
}
