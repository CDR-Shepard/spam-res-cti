import XCTest

/// Every decision the dial screen makes, taken out of the SwiftUI body so it
/// can be pinned without a simulator: what the refusal banner says and how it
/// is styled, what the review sheet lists, whether the call button is live,
/// and how the typed string grows.
///
/// The load-bearing rule in here is that the *server's* words are never
/// rewritten. A compliance refusal is the only explanation a rep gets for a
/// call that did not happen, and paraphrasing it on the phone would put a
/// different sentence in front of the rep than the one the audit trail holds.
@MainActor
final class DialViewModelTests: XCTestCase {

    private let info = CallerInfo(number: "+16198481782", name: "Jordyn Freedman", recordId: "00Q000000000001", recordType: "Lead")

    // MARK: - Refusal banner

    func testNoBannerWithoutARefusal() {
        XCTAssertNil(DialViewModel.banner(for: nil, dismissed: nil))
    }

    func testServerRefusalIsShownVerbatimAndStyledAsARefusal() {
        let text = "Outside calling hours for area code 619 (8:00 AM – 9:00 PM local)."
        let banner = DialViewModel.banner(for: text, dismissed: nil)
        XCTAssertEqual(banner, RefusalBanner(text: text, style: .server))
    }

    /// "Finish your current call first." is the app's own wording for a tap it
    /// never sent anywhere — styling it like a compliance refusal would teach
    /// reps that red means nothing in particular.
    func testTheControllersOwnBusyMessageIsStyledLocally() {
        let banner = DialViewModel.banner(for: CallController.busyRefusal, dismissed: nil)
        XCTAssertEqual(banner, RefusalBanner(text: CallController.busyRefusal, style: .local))
    }

    func testADismissedRefusalStaysDismissed() {
        let text = "Blocked: this number is on the org's do-not-call list."
        XCTAssertNil(DialViewModel.banner(for: text, dismissed: text))
    }

    /// Dismissing one refusal must not hide the next one — the rep needs to
    /// see that their second attempt was refused too.
    func testANewRefusalReappearsAfterAnEarlierOneWasDismissed() {
        let banner = DialViewModel.banner(for: "Second refusal.", dismissed: "First refusal.")
        XCTAssertEqual(banner, RefusalBanner(text: "Second refusal.", style: .server))
    }

    // MARK: - How long a dismissal lasts
    //
    // Comparing the *text* is what lets one refusal be dismissed without
    // hiding the next — but it has a hole: refuse the same number twice and
    // the second refusal is the same string, so the stale dismissal would
    // swallow it. That is not hypothetical; a redial from the Recents tab
    // does exactly this, and the rep would tap a row and watch nothing
    // happen. A dismissal is therefore scoped to the call it was made about,
    // and any new call clears it.

    func testADismissalSurvivesWhileNothingNewIsHappening() {
        XCTAssertEqual(DialViewModel.dismissal("Refused.", survives: .idle), "Refused.")
    }

    func testAnyNewCallClearsTheDismissal() {
        let started: [CallController.Phase] = [
            .dialing(info),
            .ringing(info),
            .active(info, since: Date(timeIntervalSince1970: 0)),
            .wrapup(callId: "call_1", info),
            .needsAcknowledgement(info, reasons: [], requiredScriptId: nil),
        ]
        for phase in started {
            XCTAssertNil(DialViewModel.dismissal("Refused.", survives: phase), "\(phase)")
        }
    }

    /// The whole point, end to end: a refusal dismissed on one attempt is
    /// shown again when the identical refusal comes back from a redial.
    func testAnIdenticalRefusalIsShownAgainAfterARedial() {
        let refusal = "Outside calling hours for area code 619."
        var dismissed: String? = refusal
        XCTAssertNil(DialViewModel.banner(for: refusal, dismissed: dismissed))

        // The redial starts: the controller leaves `.idle`…
        dismissed = DialViewModel.dismissal(dismissed, survives: .dialing(info))
        // …and comes back refused with the very same sentence.
        XCTAssertEqual(
            DialViewModel.banner(for: refusal, dismissed: dismissed),
            RefusalBanner(text: refusal, style: .server)
        )
    }

    // MARK: - Review acknowledgement

    func testReviewPromptListsTheServersReasonsVerbatim() {
        let reasons = ["STATE_SUNDAY_RESTRICTION", "Number has 3 prior attempts today"]
        let prompt = DialViewModel.prompt(for: info, reasons: reasons, requiredScriptId: nil)
        XCTAssertEqual(prompt.reasons, reasons)
        XCTAssertEqual(prompt.title, "Jordyn Freedman")
        XCTAssertEqual(prompt.subtitle, "(619) 848-1782 · Lead")
        XCTAssertNil(prompt.scriptNote)
    }

    func testReviewPromptNamesTheRequiredScript() {
        let prompt = DialViewModel.prompt(for: info, reasons: ["REQUIRE_REVIEW"], requiredScriptId: "script_42")
        XCTAssertEqual(prompt.scriptNote, "Required script: script_42")
    }

    /// A REQUIRE_REVIEW that arrives with no reasons is rare and worrying; the
    /// prompt must stay empty rather than manufacture a justification the rep
    /// would then acknowledge.
    func testReviewPromptInventsNoReasonWhenTheServerSentNone() {
        let prompt = DialViewModel.prompt(for: info, reasons: [], requiredScriptId: nil)
        XCTAssertEqual(prompt.reasons, [])
    }

    // MARK: - Call button

    func testCallButtonIsLiveOnlyWithANumberAndAnIdleController() {
        XCTAssertTrue(DialViewModel.canDial(phase: .idle, raw: "6198481782"))
    }

    func testCallButtonIsDeadWithoutANumber() {
        XCTAssertFalse(DialViewModel.canDial(phase: .idle, raw: ""))
        XCTAssertFalse(DialViewModel.canDial(phase: .idle, raw: "   "))
    }

    /// The controller refuses a second dial anyway; the button is dead first so
    /// the rep never gets the refusal for a tap the screen could have declined.
    func testCallButtonIsDeadWhileAnyCallIsOnScreen() {
        let busy: [CallController.Phase] = [
            .ringing(info),
            .dialing(info),
            .active(info, since: Date(timeIntervalSince1970: 0)),
            .wrapup(callId: "call_1", info),
            .needsAcknowledgement(info, reasons: ["REQUIRE_REVIEW"], requiredScriptId: nil),
        ]
        for phase in busy {
            XCTAssertFalse(DialViewModel.canDial(phase: phase, raw: "6198481782"), "\(phase)")
        }
    }

    // MARK: - Typing

    func testKeypadAppendsDigitsStarHashAndPlus() {
        XCTAssertEqual(DialViewModel.append("6", to: ""), "6")
        XCTAssertEqual(DialViewModel.append("*", to: "6"), "6*")
        XCTAssertEqual(DialViewModel.append("#", to: "6*"), "6*#")
        XCTAssertEqual(DialViewModel.append("+", to: ""), "+")
    }

    func testKeypadIgnoresAnythingThatIsNotADialableKey() {
        XCTAssertEqual(DialViewModel.append("A", to: "619"), "619")
        XCTAssertEqual(DialViewModel.append("", to: "619"), "619")
        XCTAssertEqual(DialViewModel.append("12", to: "619"), "619")
    }

    func testTypingIsBounded() {
        let long = String(repeating: "9", count: DialViewModel.maxDigits)
        XCTAssertEqual(DialViewModel.append("9", to: long), long)
    }

    func testBackspaceDropsTheLastKeyAndIsSafeWhenEmpty() {
        XCTAssertEqual(DialViewModel.backspace("619"), "61")
        XCTAssertEqual(DialViewModel.backspace(""), "")
    }

    // MARK: - Number display
    //
    // Ported from `apps/cti-web/src/format.ts`'s `formatDialString` so the
    // phone and the web dialer shape a half-typed number identically.

    func testDialStringFormatting() {
        XCTAssertEqual(DialViewModel.formatDialString(""), "")
        XCTAssertEqual(DialViewModel.formatDialString("6"), "6")
        XCTAssertEqual(DialViewModel.formatDialString("619"), "619")
        XCTAssertEqual(DialViewModel.formatDialString("61984"), "619-84")
        XCTAssertEqual(DialViewModel.formatDialString("6198481782"), "(619) 848-1782")
        XCTAssertEqual(DialViewModel.formatDialString("16198481782"), "+1 (619) 848-1782")
        XCTAssertEqual(DialViewModel.formatDialString("+16198481782"), "+1 (619) 848-1782")
    }

    /// Three cases where reshaping the number would be a lie about who is
    /// being dialled, so the typed string is shown exactly as typed.
    func testDialStringLeavesAmbiguousInputAlone() {
        XCTAssertEqual(DialViewModel.formatDialString("*67"), "*67")
        XCTAssertEqual(DialViewModel.formatDialString("+442071838750"), "+442071838750")
        XCTAssertEqual(DialViewModel.formatDialString("619848178200"), "619848178200")
    }

    // MARK: - Pasting into the number field
    //
    // The field is editable so a number copied out of an email or a CRM tab
    // can be pasted rather than re-keyed twelve digits at a time. Whatever
    // arrives is sanitized down to dialable keys and then shown through the
    // same formatter the pad's own typing goes through, so a pasted number and
    // a typed one are indistinguishable from there on.

    func testPastingAFormattedNumberKeepsOnlyTheDialableKeys() {
        XCTAssertEqual(DialViewModel.accept("+1 (619) 848-1782"), "+16198481782")
        XCTAssertEqual(DialViewModel.accept("619.848.1782"), "6198481782")
        XCTAssertEqual(DialViewModel.accept("call me on 619 848 1782 x4"), "61984817824")
    }

    /// A paste round-trips: sanitize, then format, and the field reads back
    /// exactly what was pasted.
    func testAPastedNumberIsFormattedByTheSameFormatterAsTypedDigits() {
        let pasted = "+1 (619) 848-1782"
        XCTAssertEqual(DialViewModel.formatDialString(DialViewModel.accept(pasted)), pasted)
    }

    func testPastingIsBoundedLikeTyping() {
        let long = String(repeating: "9", count: DialViewModel.maxDigits + 10)
        XCTAssertEqual(DialViewModel.accept(long).count, DialViewModel.maxDigits)
    }

    /// Both the sanitizer and the formatter count ASCII digits only, matching
    /// the web's `\D`. Unicode digits are not dialable and must not be
    /// silently treated as if they were — an Arabic-Indic "٦" is not a 6 to
    /// any carrier, and `Character.isNumber` would have said it was.
    func testOnlyASCIIDigitsCount() {
        XCTAssertEqual(DialViewModel.accept("٦١٩8481782"), "8481782")
        XCTAssertEqual(DialViewModel.formatDialString("6198481782٩"), "(619) 848-1782")
    }

    // MARK: - Pending disposition

    func testPendingBannerNamesTheCallStillOwedADisposition() {
        let pending = CallSummary(
            id: "call_1", direction: "outbound", toNumber: "+16198481782", fromNumber: "+18585550100",
            disposition: nil, durationSeconds: 42, createdAt: "2026-09-03T18:04:05.000Z",
            salesforceWhoId: nil, salesforceWhatId: nil
        )
        XCTAssertEqual(DialViewModel.pendingBanner(for: pending), "Finish your last call — (619) 848-1782")
    }

    func testNoPendingBannerWhenNothingIsOwed() {
        XCTAssertNil(DialViewModel.pendingBanner(for: nil))
    }
}
