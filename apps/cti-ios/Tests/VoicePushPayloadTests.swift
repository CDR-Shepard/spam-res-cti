import XCTest

/// Classifying the VoIP push before the Twilio SDK sees it.
///
/// This exists for one reason: iOS terminates an app (and eventually revokes
/// its VoIP push privilege) that takes a `twilio.voice.call` push and reports
/// no call to CallKit. `PushRegistry` uses this to tell a push that *must*
/// produce a CallKit report from a cancel — which must not.
final class VoicePushPayloadTests: XCTestCase {

    func testRecognisesACallInvitePush() {
        XCTAssertEqual(
            voicePushKind(of: ["twi_message_type": "twilio.voice.call", "twi_from": "+16195550100"]),
            .callInvite
        )
    }

    func testRecognisesACancelPush() {
        XCTAssertEqual(voicePushKind(of: ["twi_message_type": "twilio.voice.cancel"]), .cancel)
    }

    /// Anything that is not Twilio's is nobody's business here — and, in
    /// particular, must not trigger the "report something to CallKit" net.
    func testAnythingElseIsOther() {
        XCTAssertEqual(voicePushKind(of: [:]), .other)
        XCTAssertEqual(voicePushKind(of: ["twi_message_type": "twilio.voice.something-new"]), .other)
        XCTAssertEqual(voicePushKind(of: ["aps": ["alert": "hello"]]), .other)
        XCTAssertEqual(voicePushKind(of: ["twi_message_type": 7]), .other)
    }

    // MARK: - Where a push goes, given what is (or isn't) wired up
    //
    // PushKit is armed in `application(_:didFinishLaunchingWithOptions:)` —
    // Apple's requirement, and the only way a push that COLD-LAUNCHES the app
    // after a force-quit or a jetsam kill is delivered at all. That means a
    // push can arrive before the softphone graph exists, and the one thing
    // iOS will not forgive is taking a call push and reporting no call.

    func testAnAttachedRuntimeRingsEveryTwilioPush() {
        // Cancels included: that is how the SDK retires its own invite state.
        XCTAssertEqual(voicePushRoute(kind: .callInvite, runtimeAttached: true), .ring)
        XCTAssertEqual(voicePushRoute(kind: .cancel, runtimeAttached: true), .ring)
        XCTAssertEqual(voicePushRoute(kind: .other, runtimeAttached: true), .ring)
    }

    /// The cold-launch case. Nothing is wired up to ring, so the invite gets
    /// the report-then-end safety net — a real missed call the rep can see,
    /// and the CallKit report iOS requires before `completion()`.
    func testACallInviteWithNoRuntimeAttachedStillOwesCallKitAReport() {
        XCTAssertEqual(voicePushRoute(kind: .callInvite, runtimeAttached: false), .reportMissed)
    }

    /// A cancel rang nothing on this process, and a non-Twilio push is nobody's
    /// business here. Reporting either would invent a phantom call.
    func testNothingButACallInviteIsReportedWhenNoRuntimeIsAttached() {
        XCTAssertEqual(voicePushRoute(kind: .cancel, runtimeAttached: false), .ignore)
        XCTAssertEqual(voicePushRoute(kind: .other, runtimeAttached: false), .ignore)
    }

    /// The caller's number, when the push carries one — the only thing the
    /// fallback CallKit report has to show a rep.
    func testReadsTheCallersNumberFromTheRawPayload() {
        XCTAssertEqual(
            voicePushCallerNumber(in: ["twi_message_type": "twilio.voice.call", "twi_from": "+16195550100"]),
            "+16195550100"
        )
        XCTAssertNil(voicePushCallerNumber(in: ["twi_message_type": "twilio.voice.call"]))
        XCTAssertNil(voicePushCallerNumber(in: ["twi_from": ""]))
    }
}
