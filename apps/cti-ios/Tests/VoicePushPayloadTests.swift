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
