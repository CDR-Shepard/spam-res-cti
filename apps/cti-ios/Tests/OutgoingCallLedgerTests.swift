import XCTest

/// The order CallKit insists on for an outgoing call, against the order the
/// SDK actually reports things in.
///
/// `reportOutgoingCall(with:connectedAt:)` is dropped on the floor if CallKit
/// has not yet seen the call, and CallKit only sees it when the
/// `CXStartCallAction` transaction completes — an async round trip. Meanwhile
/// `callDidConnect` can land immediately: voicemail and IVRs answer on the
/// first ring, so the connect can beat the start transaction, or even beat
/// `reportOutgoingStarted` being called at all. Lose that report and the system
/// call screen says "connecting…" for the entire call and Recents shows no
/// duration.
final class OutgoingCallLedgerTests: XCTestCase {
    private let uuid = UUID()
    private let connectedAt = Date(timeIntervalSince1970: 1_800_000_000)

    /// The ordinary case: CallKit knows the call before anyone answers.
    func testConnectedAfterTheStartTransactionReportsImmediately() {
        var ledger = OutgoingCallLedger()
        ledger.startRequested(uuid)
        XCTAssertNil(ledger.startSucceeded(uuid), "nothing to flush — nobody has answered yet")

        XCTAssertEqual(ledger.connected(uuid, at: connectedAt), connectedAt)
    }

    /// Answered while the start transaction was still in flight: the report is
    /// held and flushed the moment CallKit knows the call.
    func testConnectedBeforeTheStartTransactionIsHeldUntilItCompletes() {
        var ledger = OutgoingCallLedger()
        ledger.startRequested(uuid)

        XCTAssertNil(ledger.connected(uuid, at: connectedAt), "CallKit has not seen the call yet")
        XCTAssertEqual(ledger.startSucceeded(uuid), connectedAt)
    }

    /// The tighter race: `sdk.connect` returns at ringback, and the callee
    /// answers before `CallController.dial` has even reached
    /// `reportOutgoingStarted`. The connect must survive that too.
    func testConnectedBeforeTheStartWasEvenRequestedIsStillHeld() {
        var ledger = OutgoingCallLedger()
        XCTAssertNil(ledger.connected(uuid, at: connectedAt))

        ledger.startRequested(uuid)
        XCTAssertEqual(ledger.startSucceeded(uuid), connectedAt, "requesting the start must not lose the held answer")
    }

    /// CallKit refused the call, so it will never know this UUID. Reporting a
    /// connect against it is not merely useless, it is a lie about a call the
    /// system does not have.
    func testAFailedStartTransactionDropsTheHeldReport() {
        var ledger = OutgoingCallLedger()
        ledger.startRequested(uuid)
        XCTAssertNil(ledger.connected(uuid, at: connectedAt))

        ledger.startFailed(uuid)
        XCTAssertNil(ledger.startSucceeded(uuid), "a refused start never completes")
        XCTAssertNil(ledger.connected(uuid, at: connectedAt), "and there is nothing to connect to")
    }

    /// Once is once. `callDidConnect` can be preceded by `callDidStartRinging`
    /// and followed by a reconnect, and CallKit's call timer must not restart.
    func testASecondConnectedIsIgnored() {
        var ledger = OutgoingCallLedger()
        ledger.startRequested(uuid)
        _ = ledger.startSucceeded(uuid)

        XCTAssertEqual(ledger.connected(uuid, at: connectedAt), connectedAt)
        XCTAssertNil(ledger.connected(uuid, at: connectedAt.addingTimeInterval(30)))
    }

    /// Held before the start, then answered again after it: still one report,
    /// and it is the first answer's timestamp — the call's real start.
    func testAHeldReportIsFlushedOnceAndNotRepeated() {
        var ledger = OutgoingCallLedger()
        ledger.startRequested(uuid)
        XCTAssertNil(ledger.connected(uuid, at: connectedAt))

        XCTAssertEqual(ledger.startSucceeded(uuid), connectedAt)
        XCTAssertNil(ledger.connected(uuid, at: connectedAt.addingTimeInterval(30)))
    }

    /// The call is over: nothing about it should be remembered, and a stray
    /// late callback must not report against a dead UUID.
    func testEndingTheCallForgetsIt() {
        var ledger = OutgoingCallLedger()
        ledger.startRequested(uuid)
        _ = ledger.startSucceeded(uuid)
        ledger.ended(uuid)

        XCTAssertNil(ledger.connected(uuid, at: connectedAt))
    }
}
