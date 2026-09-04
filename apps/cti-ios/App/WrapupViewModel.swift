import Foundation

/// What the wrap-up sheet does once `CallController.finishWrapup` returns.
enum WrapupOutcome: Equatable {
    /// Closed out. The sheet goes away with nothing to say.
    case dismissed
    /// The rep started another call while the POST was in flight, so the
    /// controller dropped the stale continuation on purpose. The typed notes
    /// are gone by design — the server closed the call out on its own — and the
    /// rep gets a note rather than an error.
    case superseded
    /// The save failed. The sheet **stays open** with this text: dropping it
    /// would throw away the rep's notes and leave their next dial refused by
    /// the server's disposition gate with nothing on screen explaining why.
    case failed(String)
}

/// The wrap-up screen's two decisions, kept out of the SwiftUI body.
enum WrapupViewModel {
    static let supersededToast = "Saved by the server."
    static let genericFailure = "The wrap-up could not be saved. Try again."

    /// A disposition is required — it is the field the server gates the rep's
    /// next dial on — and a second Save while the first POST is in flight would
    /// disposition the call twice.
    static func canSave(disposition: String?, isSubmitting: Bool) -> Bool {
        disposition != nil && !isSubmitting
    }

    static func canSkip(isSubmitting: Bool) -> Bool {
        !isSubmitting
    }

    /// What, if anything, to say out loud about an outcome.
    ///
    /// A property of the outcome rather than of whichever surface happens to
    /// be on screen — which matters here, because a superseded save only ever
    /// happens *because* another call started, so the full-screen call cover
    /// is already up by the time this is asked. Both surfaces draw the toast
    /// from this one answer; a toast attached to only the tab bar would be
    /// underneath the cover and never seen.
    static func toast(for outcome: WrapupOutcome) -> String? {
        guard case .superseded = outcome else { return nil }
        return supersededToast
    }

    /// The notes as they should reach the server.
    ///
    /// `LiveCallsAPI.disposition` omits the field entirely when this is empty,
    /// matching the server's `.optional()` — so trimming here is what turns a
    /// `TextEditor` the rep tapped into and backed out of (leaving a newline)
    /// into "no notes" rather than a Salesforce Task whose body is a blank
    /// line. Only the ends are touched: a rep's own paragraph breaks are
    /// theirs to keep.
    static func notesForPosting(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Reads the outcome off the controller's own state rather than off a
    /// return value, because `finishWrapup` has none: it either leaves the
    /// phase in `.wrapup` (failed, retryable) or moves it on.
    ///
    /// `refusal` is only consulted in the failure branch. `lastRefusal`
    /// deliberately outlives the transition that set it — a dropped call's
    /// disconnect reason is still sitting there while the rep types their notes
    /// — so treating a leftover string as a save failure would turn every
    /// successful wrap-up after a dropped call into an error.
    @MainActor
    static func outcome(after phase: CallController.Phase, refusal: String?) -> WrapupOutcome {
        switch phase {
        case .wrapup:
            return .failed(refusal ?? genericFailure)
        case .idle:
            return .dismissed
        case .ringing, .dialing, .active, .needsAcknowledgement:
            return .superseded
        }
    }
}
