import XCTest

/// The two read-only `GET`s the tabs need (recent calls, the call still owed a
/// disposition) and the one rule that matters about them: **a failure is shown,
/// never swallowed.** An empty Recents list that actually means "your session
/// expired" is the kind of silence that gets diagnosed as "the app lost my
/// calls" a week later.
private final class FakeFeed: RecentCallsReading, @unchecked Sendable {
    var recents: Result<[CallSummary], Error> = .success([])
    var pending: Result<CallSummary?, Error> = .success(nil)
    private(set) var recentCalls = 0
    private(set) var pendingCalls = 0

    init(recents: Result<[CallSummary], Error> = .success([]), pending: Result<CallSummary?, Error> = .success(nil)) {
        self.recents = recents
        self.pending = pending
    }

    func recent(limit: Int) async throws -> [CallSummary] {
        recentCalls += 1
        return try recents.get()
    }

    func pendingDisposition() async throws -> CallSummary? {
        pendingCalls += 1
        return try pending.get()
    }
}

private struct FeedFailure: LocalizedError {
    var errorDescription: String? { "The server is unreachable." }
}

private func sample(id: String) -> CallSummary {
    CallSummary(
        id: id, direction: "outbound", toNumber: "+16198481782", fromNumber: "+18585550100",
        disposition: "Connected", durationSeconds: 65, createdAt: "2026-09-03T18:04:05.000Z",
        salesforceWhoId: nil, salesforceWhatId: nil
    )
}

@MainActor
final class CallsFeedStoreTests: XCTestCase {

    func testLoadingRecentsPublishesRows() async {
        let api = FakeFeed(recents: .success([sample(id: "call_1"), sample(id: "call_2")]))
        let store = CallsFeedStore(api: api)

        await store.loadRecents()

        XCTAssertEqual(store.recents.map(\.id), ["call_1", "call_2"])
        XCTAssertNil(store.recentsError)
        XCTAssertFalse(store.isLoadingRecents)
        XCTAssertEqual(api.recentCalls, 1)
    }

    func testAFailedRecentsLoadSurfacesTheError() async {
        let store = CallsFeedStore(api: FakeFeed(recents: .failure(FeedFailure())))

        await store.loadRecents()

        XCTAssertEqual(store.recentsError, "The server is unreachable.")
        XCTAssertFalse(store.isLoadingRecents)
    }

    /// A refresh that fails must not blank the list the rep is already reading
    /// — the rows on screen were real; only the refresh failed.
    func testAFailedRefreshKeepsThePreviouslyLoadedRows() async {
        let api = FakeFeed(recents: .success([sample(id: "call_1")]))
        let store = CallsFeedStore(api: api)
        await store.loadRecents()

        api.recents = .failure(FeedFailure())
        await store.loadRecents()

        XCTAssertEqual(store.recents.map(\.id), ["call_1"])
        XCTAssertEqual(store.recentsError, "The server is unreachable.")
    }

    func testASuccessfulReloadClearsAnEarlierError() async {
        let api = FakeFeed(recents: .failure(FeedFailure()))
        let store = CallsFeedStore(api: api)
        await store.loadRecents()
        XCTAssertNotNil(store.recentsError)

        api.recents = .success([sample(id: "call_9")])
        await store.loadRecents()

        XCTAssertNil(store.recentsError)
        XCTAssertEqual(store.recents.map(\.id), ["call_9"])
    }

    func testPendingDispositionIsPublishedForTheDialBanner() async {
        let store = CallsFeedStore(api: FakeFeed(pending: .success(sample(id: "call_7"))))

        await store.loadPending()

        XCTAssertEqual(store.pending?.id, "call_7")
        XCTAssertNil(store.pendingError)
    }

    /// The banner has to disappear once the rep finishes the wrap-up, so a
    /// `nil` answer must clear what an earlier load put there.
    func testNothingPendingClearsTheBanner() async {
        let api = FakeFeed(pending: .success(sample(id: "call_7")))
        let store = CallsFeedStore(api: api)
        await store.loadPending()
        XCTAssertNotNil(store.pending)

        api.pending = .success(nil)
        await store.loadPending()

        XCTAssertNil(store.pending)
    }

    func testAFailedPendingLookupSurfacesTheError() async {
        let store = CallsFeedStore(api: FakeFeed(pending: .failure(FeedFailure())))

        await store.loadPending()

        XCTAssertEqual(store.pendingError, "The server is unreachable.")
        XCTAssertNil(store.pending)
    }

    func testRecentsAsksForTheLimitItWasGiven() async {
        let api = FakeFeed(recents: .success([]))
        let store = CallsFeedStore(api: api)

        await store.loadRecents(limit: 50)

        XCTAssertEqual(api.recentCalls, 1)
        XCTAssertEqual(store.recents, [])
    }
}
