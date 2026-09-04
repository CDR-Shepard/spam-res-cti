import Foundation

/// Which screen covers the tabs, for a given call phase.
///
/// Pulled out of `MainTabs` so the routing table is answered by
/// `CallRouteTests` rather than by tapping through the app. The entry worth
/// reading twice is `.ringing`, which maps to `.none`: an inbound call belongs
/// to CallKit's own full-screen UI, and drawing a ring screen of our own
/// underneath it would put two Answer buttons — wired to different code paths —
/// in front of the rep at once.
enum CallRoute: Equatable {
    case none
    /// Dialing and active share one screen. The only difference is whether
    /// there is a connect time to run the timer from, which is why `since` is
    /// optional rather than the two being separate routes: keeping the identity
    /// stable stops SwiftUI tearing the screen down and rebuilding it the
    /// instant the callee picks up.
    case inCall(CallerInfo, since: Date?)
    case wrapup(callId: String?, CallerInfo)
    case acknowledge(CallerInfo, reasons: [String], requiredScriptId: String?)

    @MainActor
    static func route(for phase: CallController.Phase) -> CallRoute {
        switch phase {
        case .idle:
            return .none
        case .ringing:
            // CallKit's. See the type's note.
            return .none
        case let .dialing(info):
            return .inCall(info, since: nil)
        case let .active(info, since):
            return .inCall(info, since: since)
        case let .wrapup(callId, info):
            return .wrapup(callId: callId, info)
        case let .needsAcknowledgement(info, reasons, requiredScriptId):
            return .acknowledge(info, reasons: reasons, requiredScriptId: requiredScriptId)
        }
    }

    /// What covers the tabs — **one** item, for **one** presentation modifier.
    ///
    /// That is the important part, and it is worth being explicit about why,
    /// because the obvious design (a `fullScreenCover` for the call and a
    /// `sheet` for the two forms) is wrong. Two independent presentation
    /// modifiers on one view have to cross over on the app's two commonest
    /// transitions — `.active → .wrapup` at the end of every single call, and
    /// `.needsAcknowledgement → .dialing` on every Acknowledge & Dial — where
    /// one must dismiss in the same update the other presents. Presenting over
    /// a presentation that is still tearing down is a coin flip in UIKit; when
    /// it loses, the second modal is dropped and the rep is left staring at the
    /// tab bar with the controller stuck in `.wrapup` and no Save button
    /// anywhere. No unit test can see that, and the rep has no way forward.
    ///
    /// So there is one modifier, and its identity is the **call** rather than
    /// the phase: `.dialing`, `.active` and `.wrapup` for the same caller all
    /// produce the same `id`, so those transitions swap the cover's *content*
    /// in place and never dismiss anything at all.
    var presentation: CallPresentation? {
        switch self {
        case .none:
            return nil
        case let .inCall(info, since):
            return CallPresentation(id: Self.id(for: info), content: .inCall(info, since: since))
        case let .wrapup(callId, info):
            return CallPresentation(id: Self.id(for: info), content: .wrapup(callId: callId, info))
        case let .acknowledge(info, reasons, requiredScriptId):
            return CallPresentation(
                id: Self.id(for: info),
                content: .acknowledge(info, reasons: reasons, requiredScriptId: requiredScriptId)
            )
        }
    }

    /// What the cover draws right now.
    ///
    /// Read live from the phase on every redraw by `CallCoverView`, rather
    /// than taken from the item `fullScreenCover(item:)` handed to its content
    /// closure. Apple documents only the identity-*changed* case ("If `item`
    /// changes, the system dismisses the currently presented modal view and
    /// replaces it with a new one") and says nothing about an item whose
    /// identity holds while its payload changes — which is precisely what
    /// `.active → .wrapup` does here, since the identity is deliberately the
    /// call. Rather than bet a rep's wrap-up on undocumented behaviour, the
    /// cover hosts one view that observes the controller: the item decides
    /// *whether* a cover is up, and this decides what is inside it.
    @MainActor
    static func coverContent(for phase: CallController.Phase) -> CallPresentation.Content? {
        route(for: phase).presentation?.content
    }

    private static func id(for info: CallerInfo) -> String { "call:\(info.number)" }
}

/// The one thing covering the tabs, and which of the three screens it is.
struct CallPresentation: Identifiable, Equatable {
    enum Content: Equatable {
        case inCall(CallerInfo, since: Date?)
        case wrapup(callId: String?, CallerInfo)
        case acknowledge(CallerInfo, reasons: [String], requiredScriptId: String?)
    }

    /// The call, not the phase — see `CallRoute.presentation`.
    let id: String
    let content: Content
}
