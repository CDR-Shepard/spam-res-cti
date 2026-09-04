import XCTest

/// The tab container's modal routing table, lifted out of the view so the one
/// question that matters — *which* screen covers the tabs for a given call
/// phase — is answered by a test rather than by tapping through the app.
///
/// The entry worth reading twice is `.ringing`: an inbound call belongs to
/// CallKit's own full-screen UI, and drawing a second ring screen underneath
/// it would give the rep two Answer buttons wired to different code paths.
@MainActor
final class CallRouteTests: XCTestCase {

    private let info = CallerInfo(number: "+16198481782", name: "Jordyn Freedman", recordId: "00Q000000000001", recordType: "Lead")

    func testIdleCoversNothing() {
        XCTAssertEqual(CallRoute.route(for: .idle), .none)
    }

    func testRingingIsCallKitsAndDrawsNothingOfOurOwn() {
        XCTAssertEqual(CallRoute.route(for: .ringing(info)), .none)
    }

    /// Dialing and active share the in-call screen — the difference is only
    /// whether there is a connect time to run a timer from — so the screen is
    /// not torn down and rebuilt the instant the callee picks up.
    func testDialingShowsTheInCallScreenWithNoTimerYet() {
        XCTAssertEqual(CallRoute.route(for: .dialing(info)), .inCall(info, since: nil))
    }

    func testActiveShowsTheInCallScreenWithItsConnectTime() {
        let since = Date(timeIntervalSince1970: 1_780_000_000)
        XCTAssertEqual(CallRoute.route(for: .active(info, since: since)), .inCall(info, since: since))
    }

    func testWrapupCarriesTheCallIdTheDispositionWillPostAgainst() {
        XCTAssertEqual(CallRoute.route(for: .wrapup(callId: "call_1", info)), .wrapup(callId: "call_1", info))
    }

    /// An inbound call has no client-side id; the wrap-up still has to open, and
    /// the controller resolves the row from the server.
    func testInboundWrapupOpensWithoutACallId() {
        XCTAssertEqual(CallRoute.route(for: .wrapup(callId: nil, info)), .wrapup(callId: nil, info))
    }

    func testReviewShowsTheAcknowledgementSheet() {
        let reasons = ["STATE_SUNDAY_RESTRICTION"]
        XCTAssertEqual(
            CallRoute.route(for: .needsAcknowledgement(info, reasons: reasons, requiredScriptId: "script_42")),
            .acknowledge(info, reasons: reasons, requiredScriptId: "script_42")
        )
    }

    // MARK: - One presentation, identified by the call
    //
    // These are the tests that matter most in this file. There is exactly one
    // SwiftUI presentation modifier over the tabs, and its item's identity is
    // the *call* rather than the phase — so the app's two commonest
    // transitions swap the cover's content in place instead of dismissing one
    // modal while another presents, which is a coin flip in UIKit and, when it
    // loses, leaves the rep on the tab bar with no Save button anywhere.

    func testIdlePresentsNothing() {
        XCTAssertNil(CallRoute.none.presentation)
    }

    func testEveryOtherRouteHasSomethingToPresent() {
        XCTAssertNotNil(CallRoute.inCall(info, since: nil).presentation)
        XCTAssertNotNil(CallRoute.wrapup(callId: "call_1", info).presentation)
        XCTAssertNotNil(CallRoute.acknowledge(info, reasons: [], requiredScriptId: nil).presentation)
    }

    func testThePresentationCarriesTheScreenToDraw() {
        XCTAssertEqual(
            CallRoute.route(for: .wrapup(callId: "call_1", info)).presentation?.content,
            .wrapup(callId: "call_1", info)
        )
        XCTAssertEqual(
            CallRoute.route(for: .active(info, since: Date(timeIntervalSince1970: 1))).presentation?.content,
            .inCall(info, since: Date(timeIntervalSince1970: 1))
        )
    }

    /// Every call ends this way. If the identity changed here, SwiftUI would
    /// dismiss the in-call screen and present the wrap-up in the same update.
    func testTheCoverKeepsItsIdentityFromDialingThroughWrapup() {
        let ids = [
            CallRoute.route(for: .dialing(info)).presentation?.id,
            CallRoute.route(for: .active(info, since: Date(timeIntervalSince1970: 1))).presentation?.id,
            CallRoute.route(for: .wrapup(callId: "call_1", info)).presentation?.id,
        ]
        XCTAssertNotNil(ids[0])
        XCTAssertEqual(Set(ids.compactMap { $0 }).count, 1, "the cover's identity must be the call, not the phase")
    }

    /// The other cross-over: Acknowledge & Dial moves `.needsAcknowledgement`
    /// straight to `.dialing`.
    func testTheCoverKeepsItsIdentityWhenAReviewIsAcknowledged() {
        let review = CallRoute.route(for: .needsAcknowledgement(info, reasons: ["X"], requiredScriptId: nil))
        let dialing = CallRoute.route(for: .dialing(info))
        XCTAssertEqual(review.presentation?.id, dialing.presentation?.id)
    }

    /// A *different* call does get a new identity — otherwise the previous
    /// call's screen would linger with the new call's state underneath it.
    func testADifferentCallGetsItsOwnIdentity() {
        let other = CallerInfo(number: "+18585550100", name: nil, recordId: nil, recordType: nil)
        XCTAssertNotEqual(
            CallRoute.route(for: .dialing(info)).presentation?.id,
            CallRoute.route(for: .dialing(other)).presentation?.id
        )
    }

    // MARK: - What the cover draws, read live from the phase
    //
    // `coverContent(for:)` is what the cover's single view calls on every
    // redraw, rather than trusting `fullScreenCover(item:)` to re-invoke its
    // content closure when the item's *identity* has not changed. Apple
    // documents the identity-changed case ("the system dismisses the
    // currently presented modal view and replaces it") and says nothing about
    // an item that stays identical while its payload changes — which is
    // exactly what `.active → .wrapup` does here. Reading the phase through
    // the observed controller makes the content correct either way.

    func testTheCoverDrawsTheInCallScreenWhileACallIsUp() {
        XCTAssertEqual(CallRoute.coverContent(for: .dialing(info)), .inCall(info, since: nil))
        let since = Date(timeIntervalSince1970: 1_780_000_000)
        XCTAssertEqual(CallRoute.coverContent(for: .active(info, since: since)), .inCall(info, since: since))
    }

    func testTheCoverDrawsTheWrapupWhenTheCallIsOver() {
        XCTAssertEqual(
            CallRoute.coverContent(for: .wrapup(callId: "call_1", info)),
            .wrapup(callId: "call_1", info)
        )
    }

    func testTheCoverDrawsTheReviewGateForAnUnacknowledgedVerdict() {
        XCTAssertEqual(
            CallRoute.coverContent(for: .needsAcknowledgement(info, reasons: ["X"], requiredScriptId: "s1")),
            .acknowledge(info, reasons: ["X"], requiredScriptId: "s1")
        )
    }

    func testTheCoverDrawsNothingWhenThereIsNoCallOfOurOwnToShow() {
        XCTAssertNil(CallRoute.coverContent(for: .idle))
        XCTAssertNil(CallRoute.coverContent(for: .ringing(info)))
    }

    /// The transition the whole design exists for: same identity, different
    /// content. If these two were equal the cover would be showing a live-call
    /// screen for a call that has already ended.
    func testTheCoverSwapsContentAcrossActiveToWrapupWithoutChangingIdentity() {
        let active = CallController.Phase.active(info, since: Date(timeIntervalSince1970: 1))
        let wrapup = CallController.Phase.wrapup(callId: "call_1", info)
        XCTAssertEqual(
            CallRoute.route(for: active).presentation?.id,
            CallRoute.route(for: wrapup).presentation?.id
        )
        XCTAssertNotEqual(CallRoute.coverContent(for: active), CallRoute.coverContent(for: wrapup))
    }
}
