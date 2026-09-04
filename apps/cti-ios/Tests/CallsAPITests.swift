import XCTest

/// Pure request-builder + decoder coverage for the voice-token mint
/// (`services/cti-api/src/routes/telephony.ts`) and the calls API
/// (`services/cti-api/src/routes/calls.ts`). No network — every test either
/// inspects a built `URLRequest` or decodes a fixture copied verbatim from
/// what the handler actually returns.
final class CallsAPITests: XCTestCase {
    let base = URL(string: "https://api.example.test")!

    // MARK: - voiceTokenRequest / decodeVoiceToken

    func testVoiceTokenRequestIsPostWithBearerAndIOSPlatform() throws {
        let req = try voiceTokenRequest(baseURL: base, sessionToken: "sess_1")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/telephony/token")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess_1")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: String]
        XCTAssertEqual(body, ["platform": "ios"])
    }

    func testDecodeVoiceTokenHappyPath() throws {
        // Exact keys `POST /telephony/token` returns (services/cti-api/src/routes/telephony.ts,
        // pinned by services/cti-api/src/routes/telephony-token.test.ts): token, identity, provider, expiresAt.
        let data = #"{"token":"tok_abc","identity":"rep_aaaabbbb","provider":"twilio","expiresAt":"2026-09-03T01:00:00Z"}"#.data(using: .utf8)!
        let token = try decodeVoiceToken(data, status: 200)
        XCTAssertEqual(token, VoiceToken(token: "tok_abc", expiresAt: "2026-09-03T01:00:00Z"))
    }

    func testDecodeVoiceToken503WhenProviderNotConfigured() {
        // app.post('/telephony/token', ...) catches createClientToken's throw and
        // replies 503 { error } when the VoIP push credential isn't configured.
        let data = #"{"error":"Twilio is not fully configured"}"#.data(using: .utf8)!
        XCTAssertThrowsError(try decodeVoiceToken(data, status: 503)) { error in
            XCTAssertEqual(error as? SessionClientError, .server(status: 503))
        }
    }

    // MARK: - placeCallRequest / decodePlaceCall

    func testPlaceCallRequestIsPostToCallsWithBearerAndToNumber() throws {
        let req = try placeCallRequest(baseURL: base, sessionToken: "sess_1", toNumber: "+16195550100")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/calls")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess_1")
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: String]
        XCTAssertEqual(body["toNumber"], "+16195550100")
    }

    func testDecodePlaceCallAllowed() throws {
        // Shape of app.post('/calls', ...)'s success reply: { call: <calls row>, taskAllowed }.
        // The row carries the server-approved fromNumber (the firewall-pinned DID), never a
        // client re-selection — decodePlaceCall reads call.id + call.fromNumber from it.
        let data = """
        {"call":{"id":"call_123","fromNumber":"+16195550111","toNumber":"+16195550100",
        "direction":"outbound","status":"queued","disposition":null,"durationSeconds":null,
        "createdAt":"2026-09-03T00:00:00Z","salesforceWhoId":null,"salesforceWhatId":null},
        "taskAllowed":true}
        """.data(using: .utf8)!
        let result = try decodePlaceCall(data, status: 200)
        XCTAssertEqual(result, .allowed(callId: "call_123", fromNumber: "+16195550111"))
    }

    func testDecodePlaceCallRefusedPrefersBlockReasonOverError() throws {
        let data = #"{"error":"Firewall blocked this call","blockReason":"Calling FL is Mon-Sat only (today is Sunday, recipient-local)"}"#.data(using: .utf8)!
        let result = try decodePlaceCall(data, status: 409)
        XCTAssertEqual(result, .refused(reason: "Calling FL is Mon-Sat only (today is Sunday, recipient-local)"))
    }

    func testDecodePlaceCallRefusedFallsBackToErrorWhenNoBlockReason() throws {
        // app.post('/calls', ...)'s DISPOSITION_REQUIRED refusal carries only `error`, no blockReason.
        let data = #"{"error":"Disposition your previous call before dialing again.","code":"DISPOSITION_REQUIRED"}"#.data(using: .utf8)!
        let result = try decodePlaceCall(data, status: 409)
        XCTAssertEqual(result, .refused(reason: "Disposition your previous call before dialing again."))
    }

    func testDecodePlaceCallThrowsServerErrorWhenRefusalBodyIsUnparseable() {
        // A 400 whose `error` is a zod-flatten OBJECT, not a string — no sensible
        // reason string to render, so this must throw rather than fabricate one.
        let data = #"{"error":{"formErrors":[],"fieldErrors":{}}}"#.data(using: .utf8)!
        XCTAssertThrowsError(try decodePlaceCall(data, status: 400)) { error in
            XCTAssertEqual(error as? SessionClientError, .server(status: 400))
        }
    }

    // MARK: - dispositionRequest

    func testDispositionRequestIsPostWithCallIdInPathAndBodyFields() throws {
        let req = try dispositionRequest(baseURL: base, sessionToken: "sess_1", callId: "call_123", disposition: "Connected", notes: "Left voicemail")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/calls/call_123/disposition")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess_1")
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: String]
        XCTAssertEqual(body["disposition"], "Connected")
        XCTAssertEqual(body["notes"], "Left voicemail")
    }

    func testDispositionRequestOmitsNotesWhenNil() throws {
        let req = try dispositionRequest(baseURL: base, sessionToken: "sess_1", callId: "call_123", disposition: "No answer", notes: nil)
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(body["disposition"] as? String, "No answer")
        XCTAssertNil(body["notes"])
    }

    // MARK: - recentCallsRequest / decodeRecentCalls

    func testRecentCallsRequestIsGetWithLimitQueryAndBearer() throws {
        let req = recentCallsRequest(baseURL: base, sessionToken: "sess_1", limit: 25)
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.path, "/calls")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess_1")
        let items = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(items, [URLQueryItem(name: "limit", value: "25")])
    }

    func testDecodeRecentCallsParsesCallsArrayFromEnvelope() throws {
        // app.get('/calls', ...) returns { calls: rows.map(r => ({ ...r, syncError })) } —
        // raw `calls` row field names, plus a `syncError` CallSummary doesn't model (ignored).
        let data = """
        {"calls":[
          {"id":"call_1","orgId":"org_1","direction":"outbound","toNumber":"+16195550100",
           "fromNumber":"+16195550111","disposition":"Connected","durationSeconds":42,
           "createdAt":"2026-09-01T12:00:00Z","salesforceWhoId":"003xx","salesforceWhatId":null,
           "syncError":null},
          {"id":"call_2","orgId":"org_1","direction":"inbound","toNumber":"+16195550111",
           "fromNumber":"+16195550100","disposition":null,"durationSeconds":null,
           "createdAt":"2026-09-01T11:00:00Z","salesforceWhoId":null,"salesforceWhatId":null,
           "syncError":"not-owner"}
        ]}
        """.data(using: .utf8)!
        let calls = try decodeRecentCalls(data, status: 200)
        XCTAssertEqual(calls, [
            CallSummary(id: "call_1", direction: "outbound", toNumber: "+16195550100", fromNumber: "+16195550111",
                        disposition: "Connected", durationSeconds: 42, createdAt: "2026-09-01T12:00:00Z",
                        salesforceWhoId: "003xx", salesforceWhatId: nil),
            CallSummary(id: "call_2", direction: "inbound", toNumber: "+16195550111", fromNumber: "+16195550100",
                        disposition: nil, durationSeconds: nil, createdAt: "2026-09-01T11:00:00Z",
                        salesforceWhoId: nil, salesforceWhatId: nil),
        ])
    }

    func testDecodeRecentCallsThrowsServerErrorOnNon200() {
        XCTAssertThrowsError(try decodeRecentCalls(Data(), status: 401)) { error in
            XCTAssertEqual(error as? SessionClientError, .server(status: 401))
        }
    }

    // MARK: - pendingDispositionRequest / decodePendingDisposition

    func testPendingDispositionRequestIsGetWithBearer() {
        let req = pendingDispositionRequest(baseURL: base, sessionToken: "sess_1")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.path, "/calls/pending-disposition")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess_1")
    }

    func testDecodePendingDispositionNull() throws {
        let result = try decodePendingDisposition(#"{"pending":null}"#.data(using: .utf8)!, status: 200)
        XCTAssertNil(result)
    }

    func testDecodePendingDispositionObject() throws {
        // pendingDispositionPayload's exact keys (calls.ts): id, toNumber (normalized),
        // fromNumber, durationSeconds, status, notes, whoId, whatId, createdAt — no
        // `direction` or `disposition` (findPendingDisposition only ever matches
        // un-dispositioned OUTBOUND calls, so both are implied rather than carried).
        let data = """
        {"pending":{"id":"call_9","toNumber":"+16195550100","fromNumber":"+16195550111",
        "durationSeconds":30,"status":"completed","notes":"","whoId":"003xx","whatId":null,
        "createdAt":"2026-09-01T00:00:00Z"}}
        """.data(using: .utf8)!
        let result = try decodePendingDisposition(data, status: 200)
        XCTAssertEqual(result, CallSummary(id: "call_9", direction: "outbound", toNumber: "+16195550100",
                                            fromNumber: "+16195550111", disposition: nil, durationSeconds: 30,
                                            createdAt: "2026-09-01T00:00:00Z", salesforceWhoId: "003xx", salesforceWhatId: nil))
    }

    func testDecodePendingDispositionThrowsServerErrorOnNon200() {
        XCTAssertThrowsError(try decodePendingDisposition(Data(), status: 401)) { error in
            XCTAssertEqual(error as? SessionClientError, .server(status: 401))
        }
    }
}
