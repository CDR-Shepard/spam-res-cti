import SwiftUI

/// The signed-in app: three tabs, and whatever the live call needs on top of
/// them.
///
/// The call UI is deliberately *not* a tab. A call can start from any tab (a
/// redial from Recents, a VoIP push while the rep is reading Status), so the
/// in-call screen covers the whole app and the two sheets — wrap-up and review
/// acknowledgement — sit above whatever the rep was doing. Which one appears is
/// `CallRoute`'s decision, pinned by `CallRouteTests`; this file only draws it.
struct MainTabs: View {
    @EnvironmentObject private var controller: CallController
    @StateObject private var feed = CallsFeedStore.live()
    @State private var selection: Tab = .dial
    @State private var toast: String?

    enum Tab: Hashable { case dial, recents, status }

    private var route: CallRoute { CallRoute.route(for: controller.phase) }

    var body: some View {
        TabView(selection: $selection) {
            DialView()
                .tabItem { Label("Dial", systemImage: "circle.grid.3x3.fill") }
                .tag(Tab.dial)

            RecentsView(onRedial: redial)
                .tabItem { Label("Recents", systemImage: "clock.arrow.circlepath") }
                .tag(Tab.recents)

            StatusView()
                .tabItem { Label("Status", systemImage: "gearshape") }
                .tag(Tab.status)
        }
        .environmentObject(feed)
        // ONE presentation modifier, deliberately — see `CallRoute.presentation`
        // for why a `fullScreenCover` for the call plus a `sheet` for the two
        // forms is the wrong shape. The item's identity is the call, so
        // `.active → .wrapup` and `.needsAcknowledgement → .dialing` swap the
        // content below in place rather than dismissing and re-presenting.
        //
        // `.constant`: the call phase is the only thing allowed to open or
        // close this. A rep who could swipe the wrap-up away would leave their
        // next dial refused by the server's disposition gate with nothing on
        // screen explaining it — which is what Skip is for instead.
        .fullScreenCover(item: .constant(route.presentation)) { item in
            content(for: item.content)
                .environmentObject(controller)
                .environmentObject(feed)
        }
        .overlay(alignment: .top) { toastBanner }
        // A finished call changes both of the reads the tabs show: the call
        // just made belongs in Recents, and the banner has to clear once its
        // disposition lands.
        .onChange(of: controller.phase) { _, phase in
            guard case .idle = phase else { return }
            Task {
                await feed.loadPending()
                await feed.loadRecents()
            }
        }
    }

    @ViewBuilder
    private func content(for content: CallPresentation.Content) -> some View {
        switch content {
        case let .inCall(info, since):
            InCallView(info: info, since: since)
        case let .wrapup(callId, info):
            WrapupView(callId: callId, info: info) { show(WrapupViewModel.supersededToast) }
        case let .acknowledge(info, reasons, requiredScriptId):
            ReviewGate(prompt: DialViewModel.prompt(for: info, reasons: reasons, requiredScriptId: requiredScriptId))
        }
    }

    @ViewBuilder
    private var toastBanner: some View {
        if let toast {
            Text(toast)
                .font(.subheadline)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.thinMaterial, in: Capsule())
                .shadow(radius: 8, y: 2)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private func redial(_ number: String, _ recordId: String?) {
        // Land on Dial first: the refusal banner lives there, and a redial the
        // firewall stops has to leave its reason somewhere the rep is looking.
        selection = .dial
        Task { await controller.placeCall(to: number, recipientRecordId: recordId) }
    }

    private func show(_ message: String) {
        withAnimation { toast = message }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation { toast = nil }
        }
    }
}

/// The REQUIRE_REVIEW gate.
///
/// Everything on this screen is the server's: the reasons are printed exactly
/// as the firewall wrote them, because this is the list the rep is attesting
/// they read and the audit row holds the same strings. The phone contributes no
/// judgement of its own — Acknowledge simply re-sends the *same* audit with
/// `acknowledged: true`, and Cancel dials nothing at all.
struct ReviewGate: View {
    @EnvironmentObject private var controller: CallController
    let prompt: AcknowledgementPrompt

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(prompt.title).font(.headline)
                        if let subtitle = prompt.subtitle {
                            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section("Why this call needs review") {
                    if prompt.reasons.isEmpty {
                        Text("The server gave no reason.").foregroundStyle(.secondary)
                    } else {
                        // Keyed by position, not by the string: the reasons are
                        // the server's and nothing guarantees they are unique,
                        // and a duplicate would make two rows share an identity.
                        ForEach(Array(prompt.reasons.enumerated()), id: \.offset) { _, reason in
                            Label(reason, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.primary)
                        }
                    }
                }

                if let scriptNote = prompt.scriptNote {
                    Section("Script") { Text(scriptNote) }
                }

                Section {
                    Button("Acknowledge & Dial") {
                        Task { await controller.acknowledge() }
                    }
                    .fontWeight(.semibold)
                }
            }
            .navigationTitle("Review required")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { controller.cancelAcknowledgement() }
                }
            }
        }
    }
}

/// The gap between `RootView` seeing a session and `VoiceRuntime` finishing the
/// softphone graph. Brief, but it has to say something — a blank screen at
/// launch reads as a hang.
struct SoftphoneStartingView: View {
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Starting the softphone…").font(.footnote).foregroundStyle(.secondary)
        }
    }
}
