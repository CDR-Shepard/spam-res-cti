import XCTest

// -----------------------------------------------------------------------------
// Fakes. Every collaborator the controller has is a protocol, so these are the
// whole test rig: no Twilio, no CallKit, no network, no simulator permissions —
// and, deliberately, no sleeps or timers anywhere. A test that passed only
// because a fake slept would be pinning the clock, not the state machine.
// -----------------------------------------------------------------------------

final class FakeCall: ActiveCall {
    let uuid: UUID
    private(set) var hungUp = false
    private(set) var muteCalls: [Bool] = []
    private(set) var sentDigits: [String] = []
    var onDisconnect: ((Error?) -> Void)?

    init(uuid: UUID = UUID()) { self.uuid = uuid }
    func hangUp() { hungUp = true }
    func setMuted(_ on: Bool) { muteCalls.append(on) }
    func sendDigits(_ digits: String) { sentDigits.append(digits) }
}

final class FakeInvite: IncomingInvite {
    let uuid = UUID()
    let from: String?
    let customParameters: [String: String]
    private(set) var accepted = false
    private(set) var rejected = false
    /// The call `accept()` hands back — exposed so a test can drive a remote
    /// disconnect on an answered inbound call.
    lazy var call = FakeCall(uuid: uuid)

    init(from: String?, params: [String: String]) {
        self.from = from
        self.customParameters = params
    }

    func accept() -> ActiveCall {
        accepted = true
        return call
    }

    func reject() { rejected = true }
}

final class FakeSDK: VoiceSDK {
    var nextInvite: IncomingInvite?
    var nextCall = FakeCall()
    var connectError: Error?

    private(set) var connectCalls = 0
    private(set) var lastConnectParams: [String: String]?
    private(set) var lastAccessToken: String?

    func register(accessToken: String, deviceToken: Data) async throws {}
    func unregister(accessToken: String, deviceToken: Data) async throws {}

    func connect(accessToken: String, params: [String: String]) async throws -> ActiveCall {
        connectCalls += 1
        lastAccessToken = accessToken
        lastConnectParams = params
        if let connectError { throw connectError }
        return nextCall
    }

    func handleIncomingPush(payload: [AnyHashable: Any]) -> IncomingInvite? { nextInvite }
}

final class FakeCallSystem: CallSystem {
    struct Incoming: Equatable { let uuid: UUID; let title: String; let handle: String }
    struct Outgoing: Equatable { let uuid: UUID; let handle: String }

    /// What CallKit answers `reportNewIncomingCall` with. Non-nil models the
    /// real refusals (Do Not Disturb, the caller blocked, the app filtered).
    var reportIncomingError: Error?

    private(set) var reported: [Incoming] = []
    private(set) var outgoing: [Outgoing] = []
    private(set) var ended: [UUID] = []

    /// Records and completes on the caller's own stack — the whole point of the
    /// completion-handler shape is that the report is issued before
    /// `handleIncomingPush` returns.
    func reportIncoming(uuid: UUID, title: String, handle: String, completion: @escaping (Error?) -> Void) {
        reported.append(Incoming(uuid: uuid, title: title, handle: handle))
        completion(reportIncomingError)
    }

    func reportOutgoingStarted(uuid: UUID, handle: String) {
        outgoing.append(Outgoing(uuid: uuid, handle: handle))
    }

    func reportEnded(uuid: UUID) { ended.append(uuid) }
}

final class FakeCallsAPI: CallsAPIClient {
    struct PlaceRecord: Equatable {
        let to: String
        let auditId: String
        let acknowledged: Bool
        let recipientRecordId: String?
        let recipientObjectType: String?
    }
    struct DispositionRecord: Equatable {
        let callId: String
        let disposition: String
        let notes: String
    }
    struct PrecallRecord: Equatable {
        let to: String
        let recipientRecordId: String?
    }

    /// Defaults to a plain ALLOW so the tests that are not about the firewall
    /// never have to set one up.
    var precallResult = PrecallVerdict(
        auditId: "aud_default", decision: .allow, reasons: [], blockReason: nil, requiredScriptId: nil
    )
    var precallError: Error?
    var placeResult = PlaceCallResult.allowed(callId: "call_default", fromNumber: "+12135550100")
    var placeError: Error?
    var pending: CallSummary?
    var pendingError: Error?
    var dispositionError: Error?
    /// Hold the disposition POST / the pending lookup in flight. Nil in every
    /// test that does not care, so nothing else pays for them.
    fileprivate var dispositionGate: CallGate?
    fileprivate var pendingGate: CallGate?

    private(set) var precalls: [PrecallRecord] = []
    private(set) var places: [PlaceRecord] = []
    private(set) var dispositions: [DispositionRecord] = []
    private(set) var pendingLookups = 0

    func precall(to e164: String, recipientRecordId: String?) async throws -> PrecallVerdict {
        precalls.append(PrecallRecord(to: e164, recipientRecordId: recipientRecordId))
        if let precallError { throw precallError }
        return precallResult
    }

    func place(to e164: String, auditId: String, acknowledged: Bool,
               recipientRecordId: String?, recipientObjectType: String?) async throws -> PlaceCallResult {
        places.append(PlaceRecord(
            to: e164, auditId: auditId, acknowledged: acknowledged,
            recipientRecordId: recipientRecordId, recipientObjectType: recipientObjectType
        ))
        if let placeError { throw placeError }
        return placeResult
    }

    func disposition(callId: String, disposition: String, notes: String) async throws {
        // Park *before* recording: while gated, the POST is in flight and has
        // not landed — which is exactly the window the stale-continuation and
        // double-tap tests drive the controller through.
        if let dispositionGate { await dispositionGate.wait() }
        dispositions.append(DispositionRecord(callId: callId, disposition: disposition, notes: notes))
        if let dispositionError { throw dispositionError }
    }

    func pendingDisposition() async throws -> CallSummary? {
        if let pendingGate { await pendingGate.wait() }
        pendingLookups += 1
        if let pendingError { throw pendingError }
        return pending
    }
}

private struct FakeError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// A suspension the test opens by hand — the only way to hold an API call
/// "in flight" while driving the controller forward, with no sleep and no
/// timeout anywhere. An actor because the fakes' `async` methods run off the
/// main actor, and every waiter is resumed on `open()` so a test that is
/// *supposed* to fail (two callers parked where one was expected) fails on its
/// assertion instead of hanging.
private actor CallGate {
    private var parked: [CheckedContinuation<Void, Never>] = []
    private var arrivalWaiters: [CheckedContinuation<Void, Never>] = []
    private var arrivals = 0
    private var opened = false

    /// Called from inside a fake: announces arrival, then parks until `open()`.
    func wait() async {
        arrivals += 1
        arrivalWaiters.forEach { $0.resume() }
        arrivalWaiters.removeAll()
        guard !opened else { return }
        await withCheckedContinuation { parked.append($0) }
    }

    /// Called from the test: returns once somebody is parked inside `wait()`.
    func waitUntilEntered() async {
        guard arrivals == 0 else { return }
        await withCheckedContinuation { arrivalWaiters.append($0) }
    }

    func open() {
        opened = true
        parked.forEach { $0.resume() }
        parked.removeAll()
    }
}

// -----------------------------------------------------------------------------

/// The rule this file exists to enforce: **the phone never dials on its own
/// judgement.** Every outbound path here proves that `sdk.connect` is reached
/// only after the server's pre-call audit said so, and that every refusal,
/// review, and thrown error lands somewhere the rep can read instead of
/// vanishing.
final class CallControllerTests: XCTestCase {

    @MainActor private func makeController(
        sdk: FakeSDK = FakeSDK(),
        system: FakeCallSystem = FakeCallSystem(),
        api: FakeCallsAPI = FakeCallsAPI()
    ) -> CallController {
        CallController(sdk: sdk, system: system, api: api, tokens: { "voice_t" })
    }

    // MARK: - Inbound

    @MainActor func testInboundRingAnswerHangupWrapup() async throws {
        let sdk = FakeSDK(); let sys = FakeCallSystem(); let api = FakeCallsAPI()
        let c = CallController(sdk: sdk, system: sys, api: api, tokens: { "voice_t" })
        let invite = FakeInvite(from: "+18585550100", params: ["callerName": "Jordyn Freedman", "recordType": "Lead", "recordId": "00Q1"])
        sdk.nextInvite = invite
        c.handleIncomingPush([:])
        guard case let .ringing(info) = c.phase else { return XCTFail("expected ringing") }
        XCTAssertEqual(sys.reported.last?.title, "Jordyn Freedman · Lead")
        XCTAssertEqual(sys.reported.last?.uuid, invite.uuid, "CallKit must be told about the invite's own UUID")
        XCTAssertEqual(info.number, "+18585550100")
        c.answer()
        guard case .active = c.phase else { return XCTFail("expected active") }
        XCTAssertTrue(invite.accepted)
        c.hangUp()
        guard case let .wrapup(callId, _) = c.phase else { return XCTFail("expected wrapup") }
        XCTAssertNil(callId) // inbound: the server owns the calls row; wrap-up resolves it via pending-disposition
        XCTAssertTrue(invite.call.hungUp)
        XCTAssertEqual(sys.ended, [invite.uuid])
    }

    @MainActor func testDeclineRejectsInvite() {
        let sdk = FakeSDK(); let invite = FakeInvite(from: "+1", params: [:]); sdk.nextInvite = invite
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: FakeCallsAPI(), tokens: { "t" })
        c.handleIncomingPush([:]); c.decline()
        XCTAssertTrue(invite.rejected)
        guard case .idle = c.phase else { return XCTFail("expected idle after decline") }
    }

    /// iOS kills an app that answers a VoIP push without a successful
    /// `reportNewIncomingCall`. When CallKit refuses (Do Not Disturb, the
    /// caller blocked), the invite must be rejected rather than left ringing
    /// against a call the system does not know about.
    @MainActor func testCallKitRefusingTheIncomingReportRejectsTheInviteAndSurfacesWhy() {
        let sdk = FakeSDK(); let sys = FakeCallSystem()
        let invite = FakeInvite(from: "+18585550100", params: [:])
        sdk.nextInvite = invite
        sys.reportIncomingError = FakeError(message: "Do Not Disturb is on")
        let c = CallController(sdk: sdk, system: sys, api: FakeCallsAPI(), tokens: { "t" })

        c.handleIncomingPush([:])

        XCTAssertTrue(invite.rejected)
        XCTAssertEqual(c.lastRefusal, "Do Not Disturb is on")
        guard case .idle = c.phase else { return XCTFail("expected idle after a refused CallKit report") }
    }

    /// A second invite arriving mid-call must not overwrite the live call's
    /// state — that would leave the first call connected with nothing able to
    /// hang it up.
    @MainActor func testASecondInviteWhileOnACallIsRejectedAndLeavesTheLiveCallAlone() async {
        let sdk = FakeSDK(); let sys = FakeCallSystem(); let api = FakeCallsAPI()
        api.placeResult = .allowed(callId: "c8", fromNumber: "+12135550100")
        let c = CallController(sdk: sdk, system: sys, api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")

        let second = FakeInvite(from: "+18585550199", params: [:])
        sdk.nextInvite = second
        c.handleIncomingPush([:])

        XCTAssertTrue(second.rejected)
        XCTAssertEqual(sys.reported.count, 0, "a busy line is never reported to CallKit")
        guard case .active = c.phase else { return XCTFail("the live call must be untouched") }
        c.hangUp()
        guard case let .wrapup(callId, _) = c.phase, callId == "c8" else {
            return XCTFail("the first call must still be the one that wraps up")
        }
    }

    /// An inbound call has no client-side call id — the server made the row.
    /// Wrap-up resolves it from `GET /calls/pending-disposition`.
    @MainActor func testInboundWrapupResolvesTheCallIdViaPendingDisposition() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        let invite = FakeInvite(from: "+18585550100", params: [:])
        sdk.nextInvite = invite
        api.pending = CallSummary(
            id: "srv_77", direction: "outbound", toNumber: "+18585550100", fromNumber: "+12135550100",
            disposition: nil, durationSeconds: 12, createdAt: "2026-09-03T00:00:00Z",
            salesforceWhoId: nil, salesforceWhatId: nil
        )
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        c.handleIncomingPush([:]); c.answer(); c.hangUp()

        await c.finishWrapup(disposition: "Connected", notes: "asked for a callback")

        XCTAssertEqual(api.pendingLookups, 1)
        XCTAssertEqual(api.dispositions, [.init(callId: "srv_77", disposition: "Connected", notes: "asked for a callback")])
        guard case .idle = c.phase else { return XCTFail("expected idle after wrapup") }
    }

    /// Nothing pending means the server's sweep already auto-dispositioned the
    /// call. Posting a disposition for a call id we do not have would be a
    /// guess; the wrap-up just closes.
    @MainActor func testInboundWrapupWithNothingPendingClosesWithoutPosting() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        sdk.nextInvite = FakeInvite(from: "+18585550100", params: [:])
        api.pending = nil
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        c.handleIncomingPush([:]); c.answer(); c.hangUp()

        await c.finishWrapup(disposition: "Connected", notes: "")

        XCTAssertEqual(api.pendingLookups, 1)
        XCTAssertTrue(api.dispositions.isEmpty, "no call id means nothing to post")
        guard case .idle = c.phase else { return XCTFail("expected idle") }
    }

    /// The far end hanging up has to land in exactly the same wrap-up the local
    /// hang-up does, or a remotely-ended call would leave the rep with no way
    /// to log it (and the next dial blocked by the disposition gate).
    @MainActor func testRemoteDisconnectDuringActiveCallEndsInWrapup() async {
        let sdk = FakeSDK(); let sys = FakeCallSystem(); let api = FakeCallsAPI()
        api.placeResult = .allowed(callId: "c9", fromNumber: "+12135550100")
        let c = CallController(sdk: sdk, system: sys, api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")
        guard case .active = c.phase else { return XCTFail("expected active") }

        sdk.nextCall.onDisconnect?(nil)

        guard case let .wrapup(callId, _) = c.phase else { return XCTFail("expected wrapup") }
        XCTAssertEqual(callId, "c9")
        XCTAssertEqual(sys.ended, [sdk.nextCall.uuid])
        XCTAssertNil(c.lastRefusal, "a clean remote hang-up is not a refusal")
    }

    /// A disconnect that carries an error is the only signal the rep gets that
    /// the call dropped rather than ended — it must not be swallowed.
    @MainActor func testRemoteDisconnectWithAnErrorSurfacesIt() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")

        sdk.nextCall.onDisconnect?(FakeError(message: "Media connection lost"))

        XCTAssertEqual(c.lastRefusal, "Media connection lost")
        guard case .wrapup = c.phase else { return XCTFail("expected wrapup") }
    }

    // MARK: - Outbound: the firewall gate

    @MainActor func testOutboundRefusalNeverDials() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.placeResult = .refused(reason: "Calling FL is Mon-Sat only (today is Sunday, recipient-local)")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "voice_t" })
        await c.placeCall(to: "+18505550100")
        XCTAssertEqual(c.lastRefusal, "Calling FL is Mon-Sat only (today is Sunday, recipient-local)")
        XCTAssertEqual(sdk.connectCalls, 0)
        guard case .idle = c.phase else { return XCTFail("stays idle") }
    }

    /// A BLOCK verdict is refused before `POST /calls` is even attempted, and
    /// the rep reads the server's own words — never a paraphrase.
    @MainActor func testFirewallBlockNeverDialsAndShowsTheBlockReasonVerbatim() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.precallResult = PrecallVerdict(
            auditId: "aud_b", decision: .block,
            reasons: ["outside_calling_hours", "state_restriction"],
            blockReason: "It is 9:41pm for this contact — calling hours are 8am-9pm local.",
            requiredScriptId: nil
        )
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })

        await c.placeCall(to: "+18585550100")

        XCTAssertEqual(c.lastRefusal, "It is 9:41pm for this contact — calling hours are 8am-9pm local.")
        XCTAssertTrue(api.places.isEmpty, "a BLOCK must never reach POST /calls")
        XCTAssertEqual(sdk.connectCalls, 0)
        guard case .idle = c.phase else { return XCTFail("stays idle") }
    }

    /// A BLOCK with no `blockReason` still has to say something — the reasons
    /// list is what the server sent, so that is what the rep sees.
    @MainActor func testFirewallBlockWithoutABlockReasonFallsBackToTheReasons() async {
        let api = FakeCallsAPI()
        api.precallResult = PrecallVerdict(
            auditId: "aud_b2", decision: .block, reasons: ["dnc_listed", "litigator"],
            blockReason: nil, requiredScriptId: nil
        )
        let c = makeController(api: api)
        await c.placeCall(to: "+18585550100")
        XCTAssertEqual(c.lastRefusal, "dnc_listed, litigator")
        XCTAssertTrue(api.places.isEmpty)
    }

    @MainActor func testOutboundAllowedConnectsWithCallIdAndWrapsUp() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.placeResult = .allowed(callId: "c1", fromNumber: "+12135550100")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "voice_t" })
        await c.placeCall(to: "+18585550100")
        XCTAssertEqual(sdk.lastConnectParams?["To"], "+18585550100")
        XCTAssertEqual(sdk.lastConnectParams?["CallDbId"], "c1")
        c.hangUp()
        guard case let .wrapup(callId, _) = c.phase, callId == "c1" else { return XCTFail("wrapup with c1") }
        await c.finishWrapup(disposition: "Left voicemail", notes: "")
        XCTAssertEqual(api.dispositions.last?.callId, "c1")
        guard case .idle = c.phase else { return XCTFail("idle after wrapup") }
    }

    /// The audit is the server's, not the client's: the dial request carries
    /// the verdict's own `auditId` (the server re-reads that row) and, on a
    /// plain ALLOW, no acknowledgement.
    @MainActor func testAllowPlacesWithTheVerdictsAuditIdAndUnacknowledged() async {
        let sdk = FakeSDK(); let sys = FakeCallSystem(); let api = FakeCallsAPI()
        api.precallResult = PrecallVerdict(
            auditId: "aud_42", decision: .allow, reasons: [], blockReason: nil, requiredScriptId: nil
        )
        api.placeResult = .allowed(callId: "c2", fromNumber: "+12135550100")
        let c = CallController(sdk: sdk, system: sys, api: api, tokens: { "voice_t" })

        await c.placeCall(to: "+18585550100", recipientRecordId: "00Q1", recipientObjectType: "Lead")

        XCTAssertEqual(api.precalls, [.init(to: "+18585550100", recipientRecordId: "00Q1")])
        XCTAssertEqual(api.places, [.init(
            to: "+18585550100", auditId: "aud_42", acknowledged: false,
            recipientRecordId: "00Q1", recipientObjectType: "Lead"
        )])
        XCTAssertEqual(sdk.lastAccessToken, "voice_t")
        XCTAssertEqual(sys.outgoing, [.init(uuid: sdk.nextCall.uuid, handle: "+18585550100")])
        guard case .active = c.phase else { return XCTFail("expected active") }
    }

    // MARK: - Outbound: REQUIRE_REVIEW

    @MainActor func testRequireReviewStopsForAcknowledgementThenPlacesAcknowledged() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.precallResult = PrecallVerdict(
            auditId: "aud_9", decision: .requireReview,
            reasons: ["This state requires the recorded-line disclosure."],
            blockReason: nil, requiredScriptId: "script_7"
        )
        api.placeResult = .allowed(callId: "c3", fromNumber: "+12135550100")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })

        await c.placeCall(to: "+18585550100")

        guard case let .needsAcknowledgement(_, reasons, scriptId) = c.phase else {
            return XCTFail("expected needsAcknowledgement")
        }
        XCTAssertEqual(reasons, ["This state requires the recorded-line disclosure."])
        XCTAssertEqual(scriptId, "script_7")
        XCTAssertTrue(api.places.isEmpty, "REQUIRE_REVIEW must not place the call yet")
        XCTAssertEqual(sdk.connectCalls, 0)

        await c.acknowledge()

        XCTAssertEqual(api.places, [.init(
            to: "+18585550100", auditId: "aud_9", acknowledged: true,
            recipientRecordId: nil, recipientObjectType: nil
        )])
        guard case .active = c.phase else { return XCTFail("expected active after acknowledging") }
    }

    @MainActor func testCancelAcknowledgementReturnsToIdleWithoutPlacing() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.precallResult = PrecallVerdict(
            auditId: "aud_9", decision: .requireReview, reasons: ["Review first"],
            blockReason: nil, requiredScriptId: nil
        )
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")

        c.cancelAcknowledgement()

        guard case .idle = c.phase else { return XCTFail("expected idle") }
        XCTAssertTrue(api.places.isEmpty)
        XCTAssertEqual(sdk.connectCalls, 0)
        await c.acknowledge()
        XCTAssertTrue(api.places.isEmpty, "acknowledge() after a cancel must be inert")
    }

    /// The server can decide REQUIRE_REVIEW between the audit and the dial (a
    /// clock crossing a calling-hours edge). `POST /calls`' 412 lands in the
    /// same acknowledgement state as a REQUIRE_REVIEW verdict would.
    @MainActor func testPlaceReturningReviewRequiredEntersAcknowledgement() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.precallResult = PrecallVerdict(
            auditId: "aud_race", decision: .allow, reasons: [], blockReason: nil, requiredScriptId: nil
        )
        api.placeResult = .reviewRequired(reasons: ["Calling hours just closed"], requiredScriptId: "script_2")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })

        await c.placeCall(to: "+18585550100")

        guard case let .needsAcknowledgement(_, reasons, scriptId) = c.phase else {
            return XCTFail("expected needsAcknowledgement")
        }
        XCTAssertEqual(reasons, ["Calling hours just closed"])
        XCTAssertEqual(scriptId, "script_2")
        XCTAssertEqual(sdk.connectCalls, 0, "a 412 is not a dial")

        // And the acknowledgement re-places against the same audit the server
        // already has a row for — not a fresh one.
        api.placeResult = .allowed(callId: "c4", fromNumber: "+12135550100")
        await c.acknowledge()
        XCTAssertEqual(api.places.map(\.auditId), ["aud_race", "aud_race"])
        XCTAssertEqual(api.places.last?.acknowledged, true)
    }

    // MARK: - Errors are never silent

    @MainActor func testAThrownPrecallErrorIsSurfacedAndNeverDials() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.precallError = FakeError(message: "The network connection was lost.")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })

        await c.placeCall(to: "+18585550100")

        XCTAssertEqual(c.lastRefusal, "The network connection was lost.")
        XCTAssertTrue(api.places.isEmpty)
        XCTAssertEqual(sdk.connectCalls, 0)
        guard case .idle = c.phase else { return XCTFail("expected idle") }
    }

    /// The server row exists but the SDK could not connect. The rep must be
    /// told, and the controller must not be left believing a call is up.
    @MainActor func testAFailedSDKConnectSurfacesTheErrorAndReturnsToIdle() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        sdk.connectError = FakeError(message: "Microphone permission denied")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })

        await c.placeCall(to: "+18585550100")

        XCTAssertEqual(c.lastRefusal, "Microphone permission denied")
        guard case .idle = c.phase else { return XCTFail("expected idle") }
    }

    /// A wrap-up that fails to post must stay on screen — dropping it would
    /// throw away the rep's notes and leave the next dial blocked by the
    /// server's disposition gate with no explanation.
    @MainActor func testAFailedDispositionKeepsTheWrapupOpen() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.placeResult = .allowed(callId: "c5", fromNumber: "+12135550100")
        api.dispositionError = FakeError(message: "The wrap-up could not be saved (HTTP 503). Try again.")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")
        c.hangUp()

        await c.finishWrapup(disposition: "Left voicemail", notes: "second attempt")

        XCTAssertEqual(c.lastRefusal, "The wrap-up could not be saved (HTTP 503). Try again.")
        guard case let .wrapup(callId, _) = c.phase, callId == "c5" else {
            return XCTFail("the wrap-up must stay open so the rep can retry")
        }
    }

    // MARK: - Mute and skip

    @MainActor func testMuteIsForwardedToTheLiveCallOnly() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        c.setMuted(true)
        XCTAssertTrue(sdk.nextCall.muteCalls.isEmpty, "nothing to mute while idle")
        XCTAssertFalse(c.isMuted)

        await c.placeCall(to: "+18585550100")
        c.setMuted(true)
        XCTAssertEqual(sdk.nextCall.muteCalls, [true])
        XCTAssertTrue(c.isMuted)

        // DTMF rides the same live call the mute does — Task 10's in-call
        // keypad has nowhere else to send "press 2 for accounts".
        sdk.nextCall.sendDigits("2")
        XCTAssertEqual(sdk.nextCall.sentDigits, ["2"])

        c.hangUp()
        XCTAssertFalse(c.isMuted, "a new call never inherits the last one's mute")
    }

    @MainActor func testSkipWrapupClosesWithoutPosting() async {
        let api = FakeCallsAPI()
        api.placeResult = .allowed(callId: "c6", fromNumber: "+12135550100")
        let c = makeController(api: api)
        await c.placeCall(to: "+18585550100")
        c.hangUp()

        c.skipWrapup()

        guard case .idle = c.phase else { return XCTFail("expected idle") }
        XCTAssertTrue(api.dispositions.isEmpty)
        XCTAssertEqual(api.pendingLookups, 0)
    }

    // MARK: - Re-entrancy: a slow wrap-up must not reach across calls

    /// The probe: place c1, hang up, tap Save (the POST parks in flight), tap
    /// Skip, dial c2 — then c1's POST finally returns. Without a generation
    /// guard that stale continuation runs `reset()` and drops a live call to
    /// `.idle` with c2's media still up and nothing able to hang it up.
    @MainActor func testAStaleWrapupSubmissionCannotResetANewerCall() async {
        let sdk = FakeSDK(); let sys = FakeCallSystem(); let api = FakeCallsAPI()
        let gate = CallGate()
        api.dispositionGate = gate
        api.placeResult = .allowed(callId: "c1", fromNumber: "+12135550100")
        let c = CallController(sdk: sdk, system: sys, api: api, tokens: { "t" })

        await c.placeCall(to: "+18585550100")
        c.hangUp()
        let staleSubmission = Task { await c.finishWrapup(disposition: "Left voicemail", notes: "") }
        await gate.waitUntilEntered()

        // The rep gives up waiting, skips, and dials the next lead.
        c.skipWrapup()
        let callTwo = FakeCall()
        sdk.nextCall = callTwo
        api.placeResult = .allowed(callId: "c2", fromNumber: "+12135550100")
        await c.placeCall(to: "+18585550101")
        guard case .active = c.phase else { return XCTFail("c2 should be up") }

        await gate.open()
        _ = await staleSubmission.value

        guard case .active = c.phase else {
            return XCTFail("c1's stale wrap-up must not drop the live call to idle")
        }
        XCTAssertFalse(callTwo.hungUp, "c2's media must be untouched")
        XCTAssertFalse(sys.ended.contains(callTwo.uuid), "c2 must not be reported ended")
        c.hangUp()
        guard case let .wrapup(callId, _) = c.phase, callId == "c2" else {
            return XCTFail("c2 must still be the call that wraps up")
        }
    }

    /// Two taps on Save must post one disposition, not two.
    @MainActor func testTwoConcurrentWrapupSubmissionsPostExactlyOnce() async {
        let api = FakeCallsAPI()
        let gate = CallGate()
        api.dispositionGate = gate
        api.placeResult = .allowed(callId: "c7", fromNumber: "+12135550100")
        let c = makeController(api: api)
        await c.placeCall(to: "+18585550100")
        c.hangUp()

        let first = Task { await c.finishWrapup(disposition: "Left voicemail", notes: "note") }
        await gate.waitUntilEntered()
        XCTAssertTrue(c.isSubmittingWrapup, "the UI needs this to disable Save")

        // The second tap goes in a task of its own: an unguarded controller
        // parks it on the same gate, and awaiting it inline here would deadlock
        // the test instead of failing it.
        let second = Task { await c.finishWrapup(disposition: "Left voicemail", notes: "note") }

        await gate.open()
        _ = await first.value
        _ = await second.value

        XCTAssertEqual(api.dispositions.count, 1)
        XCTAssertFalse(c.isSubmittingWrapup)
        guard case .idle = c.phase else { return XCTFail("expected idle") }
    }

    /// Same for inbound, where the wrap-up costs an extra round trip: the
    /// pending-disposition lookup must run at most once too.
    @MainActor func testTwoConcurrentInboundWrapupsLookUpAndPostExactlyOnce() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        let gate = CallGate()
        api.pendingGate = gate
        sdk.nextInvite = FakeInvite(from: "+18585550100", params: [:])
        api.pending = CallSummary(
            id: "srv_88", direction: "outbound", toNumber: "+18585550100", fromNumber: "+12135550100",
            disposition: nil, durationSeconds: 5, createdAt: "2026-09-03T00:00:00Z",
            salesforceWhoId: nil, salesforceWhatId: nil
        )
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        c.handleIncomingPush([:]); c.answer(); c.hangUp()

        let first = Task { await c.finishWrapup(disposition: "Connected", notes: "") }
        await gate.waitUntilEntered()
        let second = Task { await c.finishWrapup(disposition: "Connected", notes: "") }
        await gate.open()
        _ = await first.value
        _ = await second.value

        XCTAssertEqual(api.pendingLookups, 1)
        XCTAssertEqual(api.dispositions.count, 1)
        XCTAssertEqual(api.dispositions.last?.callId, "srv_88")
    }

    /// A disconnect callback carries no call identity of its own, so the
    /// controller has to check: call A's far end reporting in after A is done
    /// and B is up must not tear B down.
    @MainActor func testAnOldCallsDisconnectCannotEndTheCurrentOne() async {
        let sdk = FakeSDK(); let sys = FakeCallSystem(); let api = FakeCallsAPI()
        api.placeResult = .allowed(callId: "cA", fromNumber: "+12135550100")
        let c = CallController(sdk: sdk, system: sys, api: api, tokens: { "t" })

        let callA = sdk.nextCall
        await c.placeCall(to: "+18585550100")
        let disconnectA = callA.onDisconnect // A's handler, kept past its call
        c.hangUp()
        await c.finishWrapup(disposition: "Left voicemail", notes: "")

        let callB = FakeCall()
        sdk.nextCall = callB
        api.placeResult = .allowed(callId: "cB", fromNumber: "+12135550100")
        await c.placeCall(to: "+18585550101")
        guard case .active = c.phase else { return XCTFail("B should be up") }

        disconnectA?(nil)

        guard case .active = c.phase else { return XCTFail("B must stay active") }
        XCTAssertFalse(sys.ended.contains(callB.uuid), "B must not be reported ended")
        XCTAssertNil(c.lastRefusal)
    }

    // MARK: - Saying no out loud

    /// A dial refused because a call is already up used to do nothing at all,
    /// which reads as a broken button.
    @MainActor func testPlacingACallWhileOneIsUpTellsTheRepToFinishIt() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")

        await c.placeCall(to: "+18585550101")

        XCTAssertEqual(c.lastRefusal, "Finish your current call first.")
        XCTAssertEqual(api.precalls.count, 1)
        XCTAssertEqual(sdk.connectCalls, 1)
    }

    @MainActor func testAcknowledgeWhileACallIsUpTellsTheRepToFinishIt() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")

        await c.acknowledge()

        XCTAssertEqual(c.lastRefusal, "Finish your current call first.")
        XCTAssertEqual(api.places.count, 1)
    }

    /// CallKit routes the rep's "end call" to the same action whether the call
    /// is ringing or up, so both entry points have to be safe.
    @MainActor func testHangUpWhileRingingDeclines() {
        let sdk = FakeSDK(); let sys = FakeCallSystem()
        let invite = FakeInvite(from: "+18585550100", params: [:])
        sdk.nextInvite = invite
        let c = CallController(sdk: sdk, system: sys, api: FakeCallsAPI(), tokens: { "t" })
        c.handleIncomingPush([:])

        c.hangUp()

        XCTAssertTrue(invite.rejected)
        XCTAssertFalse(invite.accepted)
        XCTAssertEqual(sys.ended, [invite.uuid])
        guard case .idle = c.phase else { return XCTFail("expected idle") }
    }

    @MainActor func testANewInboundRingClearsThePreviousCallsError() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        api.precallResult = PrecallVerdict(
            auditId: "aud_x", decision: .block, reasons: [], blockReason: "Outside calling hours.",
            requiredScriptId: nil
        )
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")
        XCTAssertEqual(c.lastRefusal, "Outside calling hours.")

        sdk.nextInvite = FakeInvite(from: "+18585550199", params: [:])
        c.handleIncomingPush([:])

        XCTAssertNil(c.lastRefusal, "a new ring must not carry the last dial's refusal")
        guard case .ringing = c.phase else { return XCTFail("expected ringing") }
    }

    // MARK: - Wrap-up lookup failures, and the pinned DID

    @MainActor func testAFailedPendingDispositionLookupKeepsTheWrapupOpen() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        sdk.nextInvite = FakeInvite(from: "+18585550100", params: [:])
        api.pendingError = FakeError(message: "The network connection was lost.")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        c.handleIncomingPush([:]); c.answer(); c.hangUp()

        await c.finishWrapup(disposition: "Connected", notes: "worth a callback")

        XCTAssertEqual(c.lastRefusal, "The network connection was lost.")
        XCTAssertTrue(api.dispositions.isEmpty)
        guard case .wrapup = c.phase else { return XCTFail("the wrap-up must stay open to retry") }
        XCTAssertFalse(c.isSubmittingWrapup, "a failed submit must re-enable Save")
    }

    /// The DID shown as "calling from" is the one the server pinned in its
    /// reply — the app never re-picks one.
    @MainActor func testFromNumberReportsTheServersPinnedDID() async {
        let api = FakeCallsAPI()
        api.placeResult = .allowed(callId: "c10", fromNumber: "+16195550123")
        let c = makeController(api: api)

        await c.placeCall(to: "+18585550100")

        XCTAssertEqual(c.fromNumber, "+16195550123")
        c.hangUp()
        await c.finishWrapup(disposition: "Left voicemail", notes: "")
        XCTAssertNil(c.fromNumber, "cleared once the call is closed out")
    }

    /// Two taps on Call must not produce two audits and two dials.
    @MainActor func testASecondPlaceCallWhileACallIsUpIsIgnored() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI()
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "t" })
        await c.placeCall(to: "+18585550100")
        await c.placeCall(to: "+18585550101")
        XCTAssertEqual(api.precalls.count, 1)
        XCTAssertEqual(sdk.connectCalls, 1)
    }
}
