import CallKit
import SwiftUI
import UIKit

/// What a paired phone shows: how much of the directory it holds, whether iOS
/// is actually using it, and the two things a rep can do about it — refresh,
/// or go turn the extension on.
struct StatusView: View {
    @EnvironmentObject private var engine: SyncEngine
    @EnvironmentObject private var voice: VoiceRuntime
    @Environment(\.scenePhase) private var scenePhase

    @State private var isConfirmingSignOut = false

    var body: some View {
        NavigationStack {
            List {
                // Who the phone is signed in as. The Salesforce display name
                // is the one the pairing claimed and the one every Task this
                // phone writes is attributed to, so a rep looking at somebody
                // else's name here has found a real problem.
                Section("Account") {
                    LabeledContent("Signed in as", value: engine.pairedUserName ?? "—")

                    // The one sign-out path in the app: revoke this phone's
                    // device row server-side, stop the softphone (best-effort
                    // Twilio unregister, so this handset stops being a valid
                    // destination for the org's calls), and only then clear
                    // the tokens both of those needed — `SignOutFlow` is what
                    // pins that order. `RootView` observes `engine.hasSession`
                    // and returns to `SignInView` on its own once `unpair()`
                    // flips it.
                    Button("Sign out", role: .destructive) {
                        isConfirmingSignOut = true
                    }
                    .disabled(engine.status == .syncing)
                }

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
                    // iOS 17 (this app's deployment target) has no "Apps"
                    // section in Settings — the Phone entry is at the top
                    // level. iOS 18 moved it under Apps. Both are named
                    // because flipping this switch is the rep's one manual
                    // step, and a path that doesn't exist on their phone is
                    // where the rollout stalls.
                    Text("Settings → Phone → Call Blocking & Identification → Callsign. On iOS 18 and later: Settings → Apps → Phone → Call Blocking & Identification.")
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
                        // Same tested sequence as Sign out: since Task 6 `unpair()` also
                        // clears the session token, so this IS a sign-out and must revoke
                        // the device row and tear down the Twilio binding first.
                        signOut()
                    }
                    .disabled(engine.status == .syncing)
                }
            }
            .navigationTitle(engine.pairedUserName ?? "Callsign")
            .refreshable { await engine.sync() }
            // Foreground appear: once on launch…
            .task { await engine.sync() }
            // …and again whenever the app comes back from the background.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    Task { await engine.sync() }
                }
            }
            .confirmationDialog(
                "Sign out of Callsign?",
                isPresented: $isConfirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign out", role: .destructive) { signOut() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll need to sign in with Salesforce again before you can make or receive calls on this iPhone.")
            }
        }
    }

    /// Both destructive buttons run the one tested sequence. `Task` because
    /// the server-side revoke is a network call — the local half of the
    /// sign-out follows it regardless of how it goes, which is `SignOutFlow`'s
    /// whole contract.
    private func signOut() {
        Task {
            await SignOutFlow.run(
                revokeDevice: SignOutFlow.liveDeviceRevoker(deviceId: engine.deviceId),
                stopVoice: voice.stop,
                unpair: engine.unpair
            )
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
