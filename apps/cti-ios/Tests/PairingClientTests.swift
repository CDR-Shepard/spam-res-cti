import XCTest

/// The first-run pairing path: the request the app promises the server
/// (POST /mobile/pair/claim in services/cti-api/src/routes/mobile.ts) and the
/// status mapping that turns the server's answer into what the rep reads on
/// the pairing screen. Both run over an injected transport, so this is the one
/// flow every rep hits first, tested without a network.
final class PairingClientTests: XCTestCase {
    private let baseURL = URL(string: "https://ctiapi-production.up.railway.app")!

    // MARK: - The request

    func testClaimPostsTheCodeAndDeviceLabelAsJSON() async throws {
        let spy = PairingTransportSpy { _ in (Self.claimJSON(token: "tok", displayName: "Jane Rep"), 200) }

        _ = try await claimPairingCode(
            baseURL: baseURL,
            code: "123456",
            deviceLabel: "Jane's iPhone",
            transport: spy.transport
        )

        let requests = await spy.requests
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/mobile/pair/claim")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let decoded = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(decoded, ["code": "123456", "deviceLabel": "Jane's iPhone"])
        // The code must never be smuggled into the URL, where it would land in
        // proxy and server access logs.
        XCTAssertNil(request.url?.query)
    }

    func testAClaimCarriesNoAuthorizationHeader() async throws {
        // The claim is the ONE unauthenticated route: the phone has no
        // credential yet, which is the whole point of the code.
        let spy = PairingTransportSpy { _ in (Self.claimJSON(token: "tok", displayName: nil), 200) }

        _ = try await claimPairingCode(baseURL: baseURL, code: "123456", deviceLabel: "iPhone", transport: spy.transport)

        let requests = await spy.requests
        XCTAssertNil(requests.first?.value(forHTTPHeaderField: "Authorization"))
    }

    // MARK: - The answer

    func testASuccessfulClaimYieldsTheDeviceTokenAndTheRepsName() async throws {
        let spy = PairingTransportSpy { _ in (Self.claimJSON(token: "device-token-abc", displayName: "Jane Rep"), 200) }

        let claim = try await claimPairingCode(
            baseURL: baseURL,
            code: "123456",
            deviceLabel: "Jane's iPhone",
            transport: spy.transport
        )

        XCTAssertEqual(claim.deviceToken, "device-token-abc")
        XCTAssertEqual(claim.user.displayName, "Jane Rep")
    }

    func testAClaimWithoutADisplayNameStillPairs() throws {
        // The server sends `displayName: null` for a rep with no name set.
        let claim = try pairingResult(data: Data(#"{"deviceToken":"t","user":{"displayName":null}}"#.utf8), status: 200)
        XCTAssertEqual(claim.deviceToken, "t")
        XCTAssertNil(claim.user.displayName)
    }

    func testTheStatusMappingIsTheScreensWholeErrorVocabulary() {
        // 401 is the server's single, deliberate answer for "unknown, already
        // used, or expired" — the rep is told to get a new code, not which of
        // the three it was.
        XCTAssertThrowsError(try pairingResult(data: Data(), status: 401)) {
            XCTAssertEqual($0 as? PairingError, .invalidCode)
        }
        XCTAssertThrowsError(try pairingResult(data: Data(), status: 429)) {
            XCTAssertEqual($0 as? PairingError, .rateLimited)
        }
        XCTAssertThrowsError(try pairingResult(data: Data(), status: 500)) {
            XCTAssertEqual($0 as? PairingError, .server(status: 500))
        }
        XCTAssertThrowsError(try pairingResult(data: Data(#"{"nope":true}"#.utf8), status: 200)) {
            XCTAssertEqual($0 as? PairingError, .malformedResponse)
        }
    }

    func testEveryPairingErrorHasSomethingTheRepCanActOn() {
        // PairView renders `errorDescription` verbatim; an empty one would
        // leave a failed pairing looking like nothing happened at all.
        for error in [PairingError.invalidCode, .rateLimited, .server(status: 503), .malformedResponse] {
            XCTAssertFalse(error.errorDescription?.isEmpty ?? true, "\(error) needs a message")
        }
    }

    func testATransportFailurePropagatesRatherThanReadingAsABadCode() async {
        struct Offline: Error {}
        let spy = PairingTransportSpy { _ in throw Offline() }

        do {
            _ = try await claimPairingCode(baseURL: baseURL, code: "123456", deviceLabel: "iPhone", transport: spy.transport)
            XCTFail("a transport failure must not be reported as an invalid code")
        } catch {
            XCTAssertTrue(error is Offline)
        }
    }

    // MARK: - The feed transport's own status mapping

    func testARevokedDevicesFeedRequestBecomesTheErrorThatUnpairsThePhone() throws {
        // SyncEngine unpairs on exactly `FeedError.http(401)`. If a non-2xx
        // ever stopped mapping to it, revocation would silently stop working:
        // a phone removed from the softphone's device list would keep its copy
        // of the org directory and keep syncing.
        XCTAssertThrowsError(try feedBody(data: Data(), response: Self.response(401))) {
            XCTAssertEqual($0 as? FeedError, .http(status: 401))
        }
        XCTAssertThrowsError(try feedBody(data: Data(), response: Self.response(500))) {
            XCTAssertEqual($0 as? FeedError, .http(status: 500))
        }
        XCTAssertThrowsError(try feedBody(data: Data(), response: nil)) {
            XCTAssertEqual($0 as? FeedError, .malformedResponse)
        }
        let body = Data(#"{"version":1}"#.utf8)
        XCTAssertEqual(try feedBody(data: body, response: Self.response(200)), body)
    }

    // MARK: - Helpers

    private static func claimJSON(token: String, displayName: String?) -> Data {
        let name = displayName.map { "\"\($0)\"" } ?? "null"
        return Data(#"{"deviceToken":"\#(token)","user":{"displayName":\#(name)}}"#.utf8)
    }

    private static func response(_ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: URL(string: "https://ctiapi-production.up.railway.app/mobile/caller-directory")!,
            statusCode: status,
            httpVersion: nil,
            headerFields: nil
        )!
    }
}

/// Records the pairing requests and answers each from a canned script.
private actor PairingTransportSpy {
    private(set) var requests: [URLRequest] = []
    private let respond: (URLRequest) throws -> (Data, Int)

    init(respond: @escaping (URLRequest) throws -> (Data, Int)) {
        self.respond = respond
    }

    nonisolated var transport: PairingTransport {
        { request in try await self.send(request) }
    }

    private func send(_ request: URLRequest) throws -> (Data, Int) {
        requests.append(request)
        return try respond(request)
    }
}
