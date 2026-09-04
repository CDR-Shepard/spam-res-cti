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
/// never a raw HTTP status. `.reviewRequired` is the 412-only case: the
/// pre-call audit was a REQUIRE_REVIEW verdict the rep has not yet
/// acknowledged, so the dial screen must show the reasons/script and let the
/// rep re-send with `acknowledged: true` rather than treating it as a refusal.
enum PlaceCallResult: Equatable {
    case allowed(callId: String, fromNumber: String)
    case refused(reason: String)
    case reviewRequired(reasons: [String], requiredScriptId: String?)
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

/// `services/cti-api/src/firewall/index.ts`'s `Decision` union, verbatim.
/// Decoded via its raw value so an unrecognized string (a server-side
/// decision the app doesn't know about yet) fails the decode instead of
/// silently defaulting to `.allow` — a firewall verdict the client
/// misreads as "allow" is worse than one it refuses to parse.
enum FirewallDecision: String, Decodable, Equatable {
    case allow = "ALLOW"
    case block = "BLOCK"
    case requireReview = "REQUIRE_REVIEW"
}

/// The fields the app needs out of `POST /firewall/precall`'s `FirewallResponse`
/// (`services/cti-api/src/firewall/index.ts:53-60`). `checks`, `normalizedTo`,
/// and `fromNumber` are part of the wire shape too but nothing on the phone
/// reads them yet, so they're left off this struct and ignored by Decodable
/// synthesis rather than modeled speculatively.
struct PrecallVerdict: Decodable, Equatable {
    let auditId: String
    let decision: FirewallDecision
    let reasons: [String]
    let blockReason: String?
    let requiredScriptId: String?
}

private struct PrecallBody: Encodable {
    let toNumber: String
    let recipientRecordId: String?
}

/// The request the app sends to run the pre-call firewall audit before
/// `POST /calls`. `recipientRecordId` (the click-to-dial source Lead/Contact)
/// is omitted from the body entirely when nil — same convention as
/// `dispositionRequest`'s `notes` — rather than sent as JSON `null`.
func precallRequest(baseURL: URL, sessionToken: String, toNumber: String, recipientRecordId: String?) -> URLRequest {
    let body = try! JSONEncoder().encode(PrecallBody(toNumber: toNumber, recipientRecordId: recipientRecordId))
    return authedRequest(baseURL: baseURL, path: "firewall/precall", sessionToken: sessionToken, method: "POST", body: body)
}

/// Pure — decodes `POST /firewall/precall`'s always-200 response into a
/// `PrecallVerdict`. Unlike `POST /calls`, the firewall endpoint itself never
/// returns a non-2xx for a BLOCK/REQUIRE_REVIEW verdict; those are ordinary
/// 200 bodies whose `decision` field the caller must branch on. A genuine
/// non-200 here (401 unauthenticated, 500) has no verdict to salvage.
func decodePrecall(_ data: Data, status: Int) throws -> PrecallVerdict {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let verdict = try? JSONDecoder().decode(PrecallVerdict.self, from: data) else {
        throw SessionClientError.malformedResponse
    }
    return verdict
}

/// `POST /calls`'s `Create` body (`services/cti-api/src/routes/calls.ts` ~:142-160).
/// `acknowledged` is modeled as `Bool?` here (rather than the public
/// function's plain `Bool`) purely so the synthesized `Encodable` can omit
/// the key via `encodeIfPresent` when it's `false` — the server only checks
/// `acknowledged !== true`, so an explicit `false` and an absent key are
/// equivalent on the wire, and omitting it keeps the common (non-review)
/// dial request body minimal.
private struct PlaceCallBody: Encodable {
    let toNumber: String
    let auditId: String
    let acknowledged: Bool?
    let recipientRecordId: String?
    let recipientObjectType: String?
}

/// The request the app sends to place a call. Pure, so a test can assert the
/// method, path, bearer, and body without a network. `auditId` is the
/// `PrecallVerdict.auditId` from the immediately-preceding `precallRequest`
/// call — the server re-reads that audit row rather than trusting any
/// client-supplied verdict. `acknowledged: true` is required when (and only
/// when) that audit's decision was `.requireReview`.
func placeCallRequest(baseURL: URL, sessionToken: String, toNumber: String, auditId: String,
                       acknowledged: Bool, recipientRecordId: String?, recipientObjectType: String?) -> URLRequest {
    let body = try! JSONEncoder().encode(PlaceCallBody(
        toNumber: toNumber,
        auditId: auditId,
        acknowledged: acknowledged ? true : nil,
        recipientRecordId: recipientRecordId,
        recipientObjectType: recipientObjectType
    ))
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

/// The 412 body's shape (`calls.ts` ~:205-211): `{ error, decision, reasons,
/// requiredScriptId }`. `decision` is checked against the literal string
/// (not decoded as `FirewallDecision`) so a decode failure here can never be
/// mistaken for a malformed-response throw — it just falls through to the
/// generic `RefusalWire` check below.
private struct ReviewRequiredWire: Decodable {
    let decision: String
    let reasons: [String]
    let requiredScriptId: String?
}

/// Pure — the server's answer to a dial attempt. A non-2xx with a string
/// `blockReason` or `error` becomes `.refused` (the reason the dial screen
/// renders inline); a 412 whose `decision` is `REQUIRE_REVIEW` becomes
/// `.reviewRequired` instead, since that is not a refusal — the rep can
/// re-send the exact same call with `acknowledged: true`; anything else
/// non-2xx throws `SessionClientError.server`.
func decodePlaceCall(_ data: Data, status: Int) throws -> PlaceCallResult {
    if (200..<300).contains(status) {
        guard let wire = try? JSONDecoder().decode(PlaceCallSuccessWire.self, from: data) else {
            throw SessionClientError.malformedResponse
        }
        return .allowed(callId: wire.call.id, fromNumber: wire.call.fromNumber)
    }
    if status == 412,
       let review = try? JSONDecoder().decode(ReviewRequiredWire.self, from: data),
       review.decision == "REQUIRE_REVIEW" {
        return .reviewRequired(reasons: review.reasons, requiredScriptId: review.requiredScriptId)
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
