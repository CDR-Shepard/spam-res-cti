import XCTest

/// Which Twilio callback answers an outbound `connect`, and how many times.
///
/// The server dials with `answerOnBridge: true`
/// (`services/cti-api/src/routes/telephony.ts`), so `callDidConnect` does not
/// arrive until the *callee* picks up. Waiting for it would park the whole
/// ringback inside `sdk.connect`: no `ActiveCall` handed back, so no CallKit
/// call, no end button, and nothing the rep could use to give up on a phone
/// that rings out. `callDidStartRinging` therefore answers the connect too —
/// whichever lands first, exactly once, with every later event routed onward
/// to the disconnect latch instead.
final class ConnectGateTests: XCTestCase {
    private struct Refused: Error {}

    func testTheFirstEventSettlesTheConnect() {
        var outcomes: [Error?] = []
        let gate = ConnectGate { outcomes.append($0) }

        XCTAssertTrue(gate.settle(nil), "the first event owns the connect")
        XCTAssertEqual(outcomes.count, 1)
        XCTAssertNil(outcomes[0])
    }

    /// Ringback first, then the callee answers. The answer must not resume a
    /// continuation that ringing already resumed — that is a crash, not a bug.
    func testASecondEventDoesNotSettleAgain() {
        var count = 0
        let gate = ConnectGate { _ in count += 1 }

        XCTAssertTrue(gate.settle(nil))
        XCTAssertFalse(gate.settle(nil), "the connect was already answered")
        XCTAssertFalse(gate.settle(Refused()))
        XCTAssertEqual(count, 1)
    }

    /// A leg the far end refuses fails before it ever rings, and that error is
    /// the whole reason the rep gets a reason instead of a dead screen.
    func testAFailureCanSettleTheConnect() {
        var outcomes: [Error?] = []
        let gate = ConnectGate { outcomes.append($0) }

        XCTAssertTrue(gate.settle(Refused()))
        XCTAssertEqual(outcomes.count, 1)
        XCTAssertTrue(outcomes[0] is Refused)
    }

    /// `false` is the caller's instruction to send the event to the disconnect
    /// latch: a call that drops mid-ringback has to reach the wrap-up.
    func testALaterFailureIsHandedBackToTheCaller() {
        let gate = ConnectGate { _ in }
        XCTAssertTrue(gate.settle(nil))

        XCTAssertFalse(gate.settle(Refused()), "a drop after ringback is a disconnect, not a connect failure")
    }
}
