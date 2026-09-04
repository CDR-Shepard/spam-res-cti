import XCTest

/// `SignOutFlow` is the Sign out button's whole job, pulled into its own type
/// so its order — and the guarantee that follows from it — can be pinned here
/// instead of trusted to a SwiftUI tap handler.
final class SignOutFlowTests: XCTestCase {
    func testStopVoiceRunsBeforeUnpair() {
        // `stopVoice` (VoiceRuntime.stop(), which best-effort unregisters from
        // Twilio) needs the session token that `unpair` is about to delete —
        // so it has to go first, or every sign-out downgrades to "stop
        // ringing locally, leave the Twilio binding live for this org."
        var order: [String] = []

        SignOutFlow.run(
            stopVoice: { order.append("stopVoice") },
            unpair: { order.append("unpair") }
        )

        XCTAssertEqual(order, ["stopVoice", "unpair"])
    }

    func testUnpairStillRunsWhenStopVoiceThrows() {
        // stopVoice is best-effort by nature (Twilio unregistration can fail
        // for reasons that have nothing to do with whether this phone should
        // stay signed in). A rep who taps Sign out must actually end up
        // signed out regardless.
        var unpairCalled = false

        SignOutFlow.run(
            stopVoice: { throw SignOutFlowTestError.boom },
            unpair: { unpairCalled = true }
        )

        XCTAssertTrue(unpairCalled, "a failed Twilio unregister must not block the actual sign-out")
    }
}

private enum SignOutFlowTestError: Error {
    case boom
}
