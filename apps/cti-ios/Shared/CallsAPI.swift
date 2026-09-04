import Foundation

/// Calls API (`services/cti-api/src/routes/calls.ts`): placing a call,
/// closing it out with a disposition, and the two reads a returning rep needs
/// (recent calls, the un-dispositioned call blocking their next dial). Pure
/// request builders + decoders in the `PairingClient`/`SessionClient` style —
/// no networking here, so every path can be pinned without a simulator.

/// One row of `GET /calls`'s `{ calls: [...] }` envelope, and (via
/// `decodePendingDisposition`) the rep's outstanding un-dispositioned call.
/// Field names match `schema.calls`'s own JS property names exactly, so the
/// default `Decodable` synthesis works with no `CodingKeys` for the `GET
/// /calls` case; `decodePendingDisposition` builds this from a differently
/// shaped wire payload instead of renaming these properties.
struct CallSummary: Decodable, Identifiable, Equatable {
    let id: String
    let direction: String
    let toNumber: String
    let fromNumber: String?
    let disposition: String?
    let durationSeconds: Int?
    let createdAt: String
    let salesforceWhoId: String?
    let salesforceWhatId: String?
}

/// The outcome of `POST /calls` as the dial screen understands it. `.refused`
/// carries whatever the firewall/dispositon-gate wants the rep to read —
/// never a raw HTTP status.
enum PlaceCallResult: Equatable {
    case allowed(callId: String, fromNumber: String)
    case refused(reason: String)
}

/// Builds a bearer-authenticated request against the CTI API. Shared by every
/// authenticated Shared/ client (`VoiceTokenClient`, this file) so the
/// Authorization header and JSON content-type wiring live in exactly one
/// place; a caller that needs query items (`recentCallsRequest`) layers them
/// onto the returned request's URL.
func authedRequest(baseURL: URL, path: String, sessionToken: String, method: String, body: Data? = nil) -> URLRequest {
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = method
    request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
    if let body {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
    }
    return request
}

private struct PlaceCallBody: Encodable {
    let toNumber: String
}

/// The request the app sends to place a call. Pure, so a test can assert the
/// method, path, bearer, and body without a network.
func placeCallRequest(baseURL: URL, sessionToken: String, toNumber: String) throws -> URLRequest {
    let body = try JSONEncoder().encode(PlaceCallBody(toNumber: toNumber))
    return authedRequest(baseURL: baseURL, path: "calls", sessionToken: sessionToken, method: "POST", body: body)
}

/// Only the two fields `decodePlaceCall` needs out of `app.post('/calls',
/// ...)`'s `{ call: <calls row>, taskAllowed }` success reply. `call.fromNumber`
/// is the firewall-approved DID the server pinned and dialed — never a fresh
/// client re-selection — which is exactly what the dial screen must display
/// as "calling from".
private struct PlaceCallSuccessWire: Decodable {
    struct CallRow: Decodable { let id: String; let fromNumber: String }
    let call: CallRow
}

/// The refusal shapes `POST /calls` sends across its various non-2xx replies
/// (403 firewall BLOCK, 409 disposition-required / warmup-limit, 400
/// validation, 412 review-required, ...). Only `error` and `blockReason` are
/// ever plain strings; a validation failure's `error` is a zod-flatten
/// object, which fails this decode and is treated as unparseable below rather
/// than fabricating a reason.
private struct RefusalWire: Decodable {
    let error: String?
    let blockReason: String?
}

/// Pure — the server's answer to a dial attempt. A non-2xx with a string
/// `blockReason` or `error` becomes `.refused` (the reason the dial screen
/// renders inline); anything else non-2xx throws `SessionClientError.server`.
func decodePlaceCall(_ data: Data, status: Int) throws -> PlaceCallResult {
    if (200..<300).contains(status) {
        guard let wire = try? JSONDecoder().decode(PlaceCallSuccessWire.self, from: data) else {
            throw SessionClientError.malformedResponse
        }
        return .allowed(callId: wire.call.id, fromNumber: wire.call.fromNumber)
    }
    if let refusal = try? JSONDecoder().decode(RefusalWire.self, from: data),
       let reason = refusal.blockReason ?? refusal.error {
        return .refused(reason: reason)
    }
    throw SessionClientError.server(status: status)
}

private struct DispositionBody: Encodable {
    let disposition: String
    let notes: String?
}

/// The request the app sends to close out a call. `notes` is omitted from the
/// body entirely when nil (matching the server's `.optional()` field) rather
/// than sent as JSON `null`.
func dispositionRequest(baseURL: URL, sessionToken: String, callId: String, disposition: String, notes: String?) throws -> URLRequest {
    let body = try JSONEncoder().encode(DispositionBody(disposition: disposition, notes: notes))
    return authedRequest(baseURL: baseURL, path: "calls/\(callId)/disposition", sessionToken: sessionToken, method: "POST", body: body)
}

/// The request for the rep's recent calls. `limit` rides as a query item
/// rather than in `authedRequest`'s path, since a path component would get
/// its `?`/`=` percent-encoded away.
func recentCallsRequest(baseURL: URL, sessionToken: String, limit: Int) -> URLRequest {
    var request = authedRequest(baseURL: baseURL, path: "calls", sessionToken: sessionToken, method: "GET")
    if let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        request.url = components.url
    }
    return request
}

private struct RecentCallsWire: Decodable { let calls: [CallSummary] }

/// Pure — parses the `calls` array out of `GET /calls`'s `{ calls: [...] }`
/// envelope. Each row's extra fields (e.g. `syncError`) are simply ignored by
/// `CallSummary`'s synthesized `Decodable`.
func decodeRecentCalls(_ data: Data, status: Int) throws -> [CallSummary] {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let wire = try? JSONDecoder().decode(RecentCallsWire.self, from: data) else {
        throw SessionClientError.malformedResponse
    }
    return wire.calls
}

/// The request for the rep's outstanding un-dispositioned call.
func pendingDispositionRequest(baseURL: URL, sessionToken: String) -> URLRequest {
    authedRequest(baseURL: baseURL, path: "calls/pending-disposition", sessionToken: sessionToken, method: "GET")
}

/// `pendingDispositionPayload`'s exact keys (calls.ts): `id`, `toNumber`
/// (already the *normalized* e164, unlike `GET /calls`'s raw `toNumber`),
/// `fromNumber`, `durationSeconds`, `status`, `notes`, `whoId`, `whatId`,
/// `createdAt`. Deliberately a private wire type rather than reusing
/// `CallSummary`'s own `Decodable` conformance: the shapes disagree (no
/// `direction`/`disposition`, and `whoId`/`whatId` instead of
/// `salesforceWhoId`/`salesforceWhatId`), so `decodePendingDisposition` below
/// maps this into a `CallSummary` by hand instead of renaming its properties.
private struct PendingDispositionWire: Decodable {
    struct Pending: Decodable {
        let id: String
        let toNumber: String
        let fromNumber: String?
        let durationSeconds: Int?
        let createdAt: String
        let whoId: String?
        let whatId: String?
    }
    let pending: Pending?
}

/// Pure — `nil` when the rep has nothing pending, otherwise the call rebuilt
/// as a `CallSummary`. `direction` is hardcoded to `"outbound"` and
/// `disposition` to `nil`: `findPendingDisposition` (calls.ts) only ever
/// matches un-dispositioned OUTBOUND calls, so both are implied by the query
/// rather than carried on the wire.
func decodePendingDisposition(_ data: Data, status: Int) throws -> CallSummary? {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let wire = try? JSONDecoder().decode(PendingDispositionWire.self, from: data) else {
        throw SessionClientError.malformedResponse
    }
    guard let pending = wire.pending else { return nil }
    return CallSummary(
        id: pending.id,
        direction: "outbound",
        toNumber: pending.toNumber,
        fromNumber: pending.fromNumber,
        disposition: nil,
        durationSeconds: pending.durationSeconds,
        createdAt: pending.createdAt,
        salesforceWhoId: pending.whoId,
        salesforceWhatId: pending.whatId
    )
}
