import XCTest

/// The early-disconnect window, pinned.
///
/// `ActiveCall.onDisconnect` is attached by `CallController` *after* the SDK
/// hands the call back, and a call can die inside that gap — a rejected
/// outbound leg, a network that drops between `connect` returning and the
/// handler being wired. A disconnect lost in that window strands the app in
/// `.active` on dead media: no wrap-up, and the rep's next dial refused by the
/// server's disposition gate with nothing on screen explaining it.
final class DisconnectLatchTests: XCTestCase {
    private struct Dropped: Error {}

    func testDeliversADisconnectToAnAlreadyAttachedHandler() {
        let latch = DisconnectLatch()
        var received: [Error?] = []
        latch.onDisconnect = { received.append($0) }

        latch.fire(Dropped())

        XCTAssertEqual(received.count, 1)
        XCTAssertTrue(received.first.flatMap { $0 } is Dropped)
    }

    func testReplaysADisconnectThatArrivedBeforeTheHandlerWasAttached() {
        let latch = DisconnectLatch()
        latch.fire(Dropped())

        var received: [Error?] = []
        latch.onDisconnect = { received.append($0) }

        XCTAssertEqual(received.count, 1, "the disconnect is replayed on attach, not dropped")
        XCTAssertTrue(received.first.flatMap { $0 } is Dropped)
    }

    /// Twilio can raise both `callDidFailToConnect` and `callDidDisconnect`
    /// for one dead call. The controller must see one end, not two.
    func testASecondDisconnectIsIgnored() {
        let latch = DisconnectLatch()
        var count = 0
        latch.onDisconnect = { _ in count += 1 }

        latch.fire(nil)
        latch.fire(Dropped())

        XCTAssertEqual(count, 1)
    }

    /// `CallController.endCall` clears the handler on the way out. Clearing
    /// must not fire anything, and must not arm a second replay.
    func testDetachingDoesNotReplayAndDoesNotRearm() {
        let latch = DisconnectLatch()
        latch.fire(Dropped())

        var first = 0
        latch.onDisconnect = { _ in first += 1 }
        XCTAssertEqual(first, 1)

        latch.onDisconnect = nil

        var second = 0
        latch.onDisconnect = { _ in second += 1 }
        XCTAssertEqual(second, 0, "the replay is spent; a later handler is for a call that is already over")
    }

    /// A clean far-end hang-up carries no error, and `nil` is not "nothing
    /// happened" — it is the ordinary end of a call.
    func testACleanDisconnectIsStillDelivered() {
        let latch = DisconnectLatch()
        latch.fire(nil)

        var fired = false
        var error: Error?
        latch.onDisconnect = { fired = true; error = $0 }

        XCTAssertTrue(fired)
        XCTAssertNil(error)
    }
}
