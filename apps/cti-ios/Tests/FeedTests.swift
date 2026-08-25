import XCTest

/// Paging tests for `fetchAll`. Everything here runs against an injected
/// transport returning canned JSON in the exact shape the server sends
/// (services/cti-api/src/routes/mobile.ts), so the contract — not a mock's
/// idea of it — is what's pinned.
final class FeedTests: XCTestCase {
    private let baseURL = URL(string: "https://ctiapi-production.up.railway.app")!
    private let token = "device-token"

    // MARK: - Assembling pages

    func testAssemblesEveryPageInServerOrder() async throws {
        let spy = TransportSpy { _, request in
            switch page(of: request) {
            case "1":
                return feedPageJSON(version: 9, page: 1, pageCount: 2, entries: [
                    DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe"),
                    DirectoryEntry(e164: "+16195550101", label: "Lead: John Roe"),
                ])
            case "2":
                return feedPageJSON(version: 9, page: 2, pageCount: 2, entries: [
                    DirectoryEntry(e164: "+16195550102", label: "Contact: Ann Poe"),
                ])
            default:
                return XCTFail_unexpectedPage(request)
            }
        }

        let result = try await fetchAll(baseURL: baseURL, token: token, since: nil, transport: spy.transport)

        let unwrapped = try XCTUnwrap(result)
        XCTAssertEqual(unwrapped.version, 9)
        XCTAssertEqual(unwrapped.entries.map(\.e164), ["+16195550100", "+16195550101", "+16195550102"])
        XCTAssertEqual(unwrapped.entries.map(\.label), ["Lead: Jane Doe", "Lead: John Roe", "Contact: Ann Poe"])
        let requests = await spy.requests
        XCTAssertEqual(requests.map(page(of:)), ["1", "2"], "pages must be requested 1..pageCount ascending")
    }

    func testSendsBearerTokenAndSinceOnEveryRequest() async throws {
        let spy = TransportSpy { _, request in
            let requestedPage = page(of: request) ?? "1"
            return feedPageJSON(version: 4, page: Int(requestedPage) ?? 1, pageCount: 2, entries: [])
        }

        _ = try await fetchAll(baseURL: baseURL, token: token, since: 3, transport: spy.transport)

        let requests = await spy.requests
        XCTAssertEqual(requests.count, 2)
        for request in requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
            XCTAssertEqual(query(of: request, name: "since"), "3")
            XCTAssertEqual(request.url?.path, "/mobile/caller-directory")
        }
    }

    func testOmitsSinceOnAFirstEverSync() async throws {
        let spy = TransportSpy { _, _ in feedPageJSON(version: 1, page: 1, pageCount: 1, entries: []) }

        _ = try await fetchAll(baseURL: baseURL, token: token, since: nil, transport: spy.transport)

        let requests = await spy.requests
        XCTAssertNil(query(of: requests[0], name: "since"))
    }

    func testEmptyDirectoryYieldsNoEntries() async throws {
        // The server answers an org with no published directory with
        // pageCount 0 — that is a complete (empty) fetch, not an error.
        let spy = TransportSpy { _, _ in
            Data(#"{"version":0,"page":1,"pageCount":0,"entries":[]}"#.utf8)
        }

        let result = try await fetchAll(baseURL: baseURL, token: token, since: nil, transport: spy.transport)

        let unwrapped = try XCTUnwrap(result)
        XCTAssertEqual(unwrapped.version, 0)
        XCTAssertTrue(unwrapped.entries.isEmpty)
        let requests = await spy.requests
        XCTAssertEqual(requests.count, 1, "pageCount 0 must not trigger a second page fetch")
    }

    // MARK: - Unchanged

    func testUnchangedReturnsNil() async throws {
        let spy = TransportSpy { _, _ in Data(#"{"version":7,"unchanged":true}"#.utf8) }

        let result = try await fetchAll(baseURL: baseURL, token: token, since: 7, transport: spy.transport)

        XCTAssertNil(result)
        let requests = await spy.requests
        XCTAssertEqual(requests.count, 1, "an unchanged answer must end the fetch immediately")
    }

    // MARK: - Errors

    func testHTTPErrorPropagates() async throws {
        let spy = TransportSpy { _, _ in throw FeedError.http(status: 401) }

        do {
            _ = try await fetchAll(baseURL: baseURL, token: token, since: nil, transport: spy.transport)
            XCTFail("expected the transport's HTTP error to propagate")
        } catch let error as FeedError {
            XCTAssertEqual(error, .http(status: 401))
        }
    }

    func testMalformedPageIsRejected() async throws {
        let spy = TransportSpy { _, _ in Data(#"{"version":3,"page":1}"#.utf8) }

        do {
            _ = try await fetchAll(baseURL: baseURL, token: token, since: nil, transport: spy.transport)
            XCTFail("expected a page with no entries/pageCount to be rejected")
        } catch let error as FeedError {
            XCTAssertEqual(error, .malformedResponse)
        }
    }

    // MARK: - Version changing mid-pagination

    func testVersionChangeMidPaginationRestartsTheWholeFetch() async throws {
        // The server re-reads the latest version per request, so page 1 can be
        // v3 and page 2 v4. Stitching those two together would publish half of
        // one directory and half of another, so the whole fetch restarts.
        let spy = TransportSpy { attempt, request in
            let isFirstPass = attempt < 2
            switch (isFirstPass, page(of: request)) {
            case (true, "1"):
                return feedPageJSON(version: 3, page: 1, pageCount: 2, entries: [
                    DirectoryEntry(e164: "+16195550100", label: "stale v3"),
                ])
            case (true, "2"):
                return feedPageJSON(version: 4, page: 2, pageCount: 2, entries: [
                    DirectoryEntry(e164: "+16195550101", label: "fresh v4"),
                ])
            case (false, "1"):
                return feedPageJSON(version: 4, page: 1, pageCount: 2, entries: [
                    DirectoryEntry(e164: "+16195550200", label: "v4 first"),
                ])
            case (false, "2"):
                return feedPageJSON(version: 4, page: 2, pageCount: 2, entries: [
                    DirectoryEntry(e164: "+16195550201", label: "v4 second"),
                ])
            default:
                return XCTFail_unexpectedPage(request)
            }
        }

        let result = try await fetchAll(baseURL: baseURL, token: token, since: 2, transport: spy.transport)

        let unwrapped = try XCTUnwrap(result)
        XCTAssertEqual(unwrapped.version, 4)
        XCTAssertEqual(
            unwrapped.entries.map(\.e164),
            ["+16195550200", "+16195550201"],
            "the restarted fetch must return only v4 entries — nothing from the abandoned pass"
        )
        let requests = await spy.requests
        XCTAssertEqual(requests.map(page(of:)), ["1", "2", "1", "2"], "the restart begins again at page 1")
    }

    func testPersistentVersionChurnThrowsAfterBoundedRestarts() async throws {
        // A directory being republished continuously must not loop forever.
        let spy = TransportSpy { attempt, request in
            let version = 10 + attempt
            return feedPageJSON(
                version: version,
                page: Int(page(of: request) ?? "1") ?? 1,
                pageCount: 2,
                entries: []
            )
        }

        do {
            _ = try await fetchAll(baseURL: baseURL, token: token, since: nil, transport: spy.transport)
            XCTFail("expected a version that never settles to throw")
        } catch let error as FeedError {
            XCTAssertEqual(error, .versionUnstable)
        }

        let requests = await spy.requests
        XCTAssertEqual(
            requests.count,
            8,
            "one initial pass plus three restarts, two requests each — then give up"
        )
    }
}

// MARK: - Helpers

/// Serial recorder for the requests `fetchAll` makes; answers each one from a
/// script keyed by the zero-based attempt index, so a test can make the same
/// page answer differently the second time around.
private actor TransportSpy {
    private(set) var requests: [URLRequest] = []
    private let respond: (Int, URLRequest) throws -> Data

    init(respond: @escaping (Int, URLRequest) throws -> Data) {
        self.respond = respond
    }

    nonisolated var transport: FeedTransport {
        { request in try await self.send(request) }
    }

    private func send(_ request: URLRequest) throws -> Data {
        requests.append(request)
        return try respond(requests.count - 1, request)
    }
}

private func feedPageJSON(version: Int, page: Int, pageCount: Int, entries: [DirectoryEntry]) -> Data {
    let list = entries
        .map { #"{"e164":"\#($0.e164)","label":"\#($0.label)"}"# }
        .joined(separator: ",")
    return Data(#"{"version":\#(version),"page":\#(page),"pageCount":\#(pageCount),"entries":[\#(list)]}"#.utf8)
}

private func query(of request: URLRequest, name: String) -> String? {
    guard let url = request.url,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    return components.queryItems?.first { $0.name == name }?.value
}

private func page(of request: URLRequest) -> String? {
    query(of: request, name: "page")
}

private func XCTFail_unexpectedPage(_ request: URLRequest) -> Data {
    XCTFail("unexpected request: \(request.url?.absoluteString ?? "nil")")
    return Data()
}
