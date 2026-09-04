import XCTest

/// The wrap-up screen's two decisions: when Save and Skip are live, and what
/// happens to the sheet once `finishWrapup` comes back.
///
/// The second one is subtler than it looks. `CallController.finishWrapup`
/// either leaves the rep in `.wrapup` (the save failed and the notes must
/// survive for a retry) or moves the phase on — and "moved on" covers both an
/// ordinary close-out and the stale-continuation case, where the rep started
/// another call while the POST was in flight and the controller deliberately
/// dropped the result. The second is not an error and must not be shown as one.
@MainActor
final class WrapupViewModelTests: XCTestCase {

    private let info = CallerInfo(number: "+16198481782", name: nil, recordId: nil, recordType: nil)

    // MARK: - Save / Skip

    func testSaveNeedsADisposition() {
        XCTAssertFalse(WrapupViewModel.canSave(disposition: nil, isSubmitting: false))
        XCTAssertTrue(WrapupViewModel.canSave(disposition: "Connected", isSubmitting: false))
    }

    /// A second Save while the first POST is in flight would disposition the
    /// call twice; the controller refuses it, and the button is dead first.
    func testSaveIsDeadWhileASaveIsInFlight() {
        XCTAssertFalse(WrapupViewModel.canSave(disposition: "Connected", isSubmitting: true))
    }

    func testSkipIsDeadWhileASaveIsInFlight() {
        XCTAssertTrue(WrapupViewModel.canSkip(isSubmitting: false))
        XCTAssertFalse(WrapupViewModel.canSkip(isSubmitting: true))
    }

    // MARK: - Outcome

    func testAFailedSaveKeepsTheSheetOpenWithTheServersWords() {
        let outcome = WrapupViewModel.outcome(
            after: .wrapup(callId: "call_1", info),
            refusal: "The wrap-up could not be saved (HTTP 503). Try again."
        )
        XCTAssertEqual(outcome, .failed("The wrap-up could not be saved (HTTP 503). Try again."))
    }

    /// Staying in `.wrapup` with nothing in `lastRefusal` should not leave the
    /// rep looking at a sheet that silently refused to close.
    func testAFailedSaveWithNoServerTextStillSaysSomething() {
        XCTAssertEqual(
            WrapupViewModel.outcome(after: .wrapup(callId: nil, info), refusal: nil),
            .failed(WrapupViewModel.genericFailure)
        )
    }

    func testASavedWrapupJustCloses() {
        XCTAssertEqual(WrapupViewModel.outcome(after: .idle, refusal: nil), .dismissed)
    }

    /// `lastRefusal` outlives the transition that set it (a dropped call's
    /// disconnect reason, say), so a leftover string must not turn a successful
    /// save into a failure.
    func testAStaleRefusalDoesNotTurnASuccessfulSaveIntoAFailure() {
        XCTAssertEqual(WrapupViewModel.outcome(after: .idle, refusal: "The call dropped."), .dismissed)
    }

    /// The rep moved on to another call while the POST was in flight. The
    /// controller dropped the stale continuation on purpose; the typed notes
    /// are gone by design and the rep gets a note, not an error.
    func testAWrapupSupersededByAnotherCallReportsItselfAsSuperseded() {
        let superseded: [CallController.Phase] = [
            .ringing(info),
            .dialing(info),
            .active(info, since: Date(timeIntervalSince1970: 0)),
            .needsAcknowledgement(info, reasons: [], requiredScriptId: nil),
        ]
        for phase in superseded {
            XCTAssertEqual(WrapupViewModel.outcome(after: phase, refusal: nil), .superseded, "\(phase)")
        }
    }

    func testTheSupersededToastDoesNotReadAsAnError() {
        XCTAssertFalse(WrapupViewModel.supersededToast.isEmpty)
        XCTAssertFalse(WrapupViewModel.supersededToast.lowercased().contains("error"))
        XCTAssertFalse(WrapupViewModel.supersededToast.lowercased().contains("fail"))
    }

    // MARK: - Which outcomes have something to say
    //
    // The toast is a property of the *outcome*, not of whichever surface
    // happens to be on screen. That matters: a superseded save only happens
    // because another call started, which means the full-screen call cover is
    // already up — so the toast has to be drawn there as well as over the
    // tabs, and both draw it from this one answer.

    func testOnlyASupersededSaveRaisesAToast() {
        XCTAssertEqual(WrapupViewModel.toast(for: .superseded), WrapupViewModel.supersededToast)
    }

    /// A close-out is silent, and a failure is shown inline on the wrap-up
    /// itself — a toast would float away from the notes it concerns.
    func testASavedOrFailedWrapupRaisesNoToast() {
        XCTAssertNil(WrapupViewModel.toast(for: .dismissed))
        XCTAssertNil(WrapupViewModel.toast(for: .failed("The wrap-up could not be saved.")))
    }

    // MARK: - Notes
    //
    // `dispositionRequest` omits `notes` entirely when nil, matching the
    // server's `.optional()`. Whitespace the rep never meant to type must
    // reach that as "no notes" rather than as a Task body containing a
    // newline.

    func testNotesAreTrimmedBeforePosting() {
        XCTAssertEqual(WrapupViewModel.notesForPosting("  Left a message.  "), "Left a message.")
    }

    func testWhitespaceOnlyNotesPostAsNoNotes() {
        XCTAssertEqual(WrapupViewModel.notesForPosting("\n"), "")
        XCTAssertEqual(WrapupViewModel.notesForPosting("   \n\t "), "")
        XCTAssertEqual(WrapupViewModel.notesForPosting(""), "")
    }

    /// Only the ends: a rep's own paragraph breaks are theirs to keep.
    func testInteriorNewlinesSurvive() {
        XCTAssertEqual(WrapupViewModel.notesForPosting("\nOne\n\nTwo\n"), "One\n\nTwo")
    }
}
