import XCTest

/// When a caller giving up should stop the phone ringing.
///
/// The push-payload route to this is dead in Twilio 6.13.7 — `TwilioVoice.h`
/// lists `unsupported-cancel-message-error`, "This version of the SDK does not
/// support 'cancel' push notifications" — so the only live signal is the SDK's
/// own `cancelledCallInviteReceived:error:`, which arrives out of band and
/// carries an invite UUID and nothing else. This rule decides what to do with
/// that UUID.
final class RingCancellationTests: XCTestCase {

    func testDeclinesWhenTheCancelledInviteIsTheOneRinging() {
        let ringing = UUID()
        XCTAssertTrue(
            shouldDeclineCancelledInvite(ringing, outstanding: [ringing], controllerIsRinging: true)
        )
    }

    /// The rep got there first. Tearing down an answered call because its
    /// invite was cancelled would drop a live conversation.
    func testIgnoresACancellationOnceTheCallHasBeenAnswered() {
        let invite = UUID()
        XCTAssertFalse(
            shouldDeclineCancelledInvite(invite, outstanding: [invite], controllerIsRinging: false)
        )
    }

    /// A cancellation for an invite that is no longer outstanding — already
    /// accepted, already rejected, or from a previous ring entirely — must not
    /// end whatever is ringing now.
    func testIgnoresACancellationForSomethingElse() {
        XCTAssertFalse(
            shouldDeclineCancelledInvite(UUID(), outstanding: [UUID()], controllerIsRinging: true)
        )
        XCTAssertFalse(
            shouldDeclineCancelledInvite(UUID(), outstanding: [], controllerIsRinging: true)
        )
    }

    /// Two invites in the air at once and the UUID cannot be matched to the
    /// ring: `CallController` keeps its invite private, so "the one ringing"
    /// is only knowable while exactly one is outstanding. Declining a guess
    /// could kill a live ring, and a missed cancellation only costs a ring
    /// that stops on its own — so the tie goes to doing nothing.
    func testIgnoresACancellationWhileTwoInvitesAreOutstanding() {
        let ringing = UUID()
        let second = UUID()
        XCTAssertFalse(
            shouldDeclineCancelledInvite(ringing, outstanding: [ringing, second], controllerIsRinging: true)
        )
    }
}
