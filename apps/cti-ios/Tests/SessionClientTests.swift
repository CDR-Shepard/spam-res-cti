import XCTest

final class SessionClientTests: XCTestCase {
    let base = URL(string: "https://api.example.test")!

    func testStartRequestIsPostToLoginStart() throws {
        let req = try loginStartRequest(baseURL: base)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/auth/salesforce/login/start")
    }
    func testDecodeStart() throws {
        let data = #"{"authUrl":"https://login.salesforce.com/x","handshake":"hs_12345678"}"#.data(using: .utf8)!
        let start = try decodeLoginStart(data, status: 200)
        XCTAssertEqual(start.handshake, "hs_12345678")
        XCTAssertEqual(start.authUrl, URL(string: "https://login.salesforce.com/x"))
    }
    func testDecodeStatusVariants() throws {
        XCTAssertEqual(try decodeLoginStatus(#"{"status":"pending"}"#.data(using: .utf8)!, status: 200), .pending)
        XCTAssertEqual(try decodeLoginStatus(#"{"status":"failed"}"#.data(using: .utf8)!, status: 200), .failed)
        XCTAssertEqual(try decodeLoginStatus(#"{"status":"done"}"#.data(using: .utf8)!, status: 200), .done)
        XCTAssertEqual(try decodeLoginStatus(#"{"status":"unknown"}"#.data(using: .utf8)!, status: 200), .unknown)
        let connected = #"{"status":"connected","token":"sess_abc","expiresAt":"2026-09-03T00:00:00Z","user":{"id":"u","email":"e","displayName":"Jane Rep","orgId":"o"}}"#.data(using: .utf8)!
        XCTAssertEqual(try decodeLoginStatus(connected, status: 200), .connected(token: "sess_abc", expiresAt: "2026-09-03T00:00:00Z", displayName: "Jane Rep"))
    }
    func testPollerReturnsTokenWhenConnectedAndStopsOnFailure() async throws {
        var answers: [LoginStatus] = [.pending, .pending, .connected(token: "sess_abc", expiresAt: "x", displayName: nil)]
        let poller = SignInPoller(handshake: "hs", interval: 0, maxAttempts: 10,
                                  status: { _ in answers.removeFirst() }, sleep: { _ in })
        let result = try await poller.run()
        XCTAssertEqual(result, .connected(token: "sess_abc", expiresAt: "x", displayName: nil))

        var failing: [LoginStatus] = [.pending, .failed]
        let p2 = SignInPoller(handshake: "hs", interval: 0, maxAttempts: 10, status: { _ in failing.removeFirst() }, sleep: { _ in })
        let outcome = try await p2.run()
        XCTAssertEqual(outcome, .failed)
    }
    func testPollerGivesUpAfterMaxAttempts() async throws {
        let p = SignInPoller(handshake: "hs", interval: 0, maxAttempts: 3, status: { _ in .pending }, sleep: { _ in })
        await XCTAssertThrowsErrorAsync(try await p.run())
    }
}

func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do { _ = try await expression(); XCTFail("expected throw", file: file, line: line) } catch {}
}
