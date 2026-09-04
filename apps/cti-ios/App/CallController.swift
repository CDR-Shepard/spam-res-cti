import Combine
import Foundation

/// The softphone's call state machine.
///
/// One rule sits above everything else in this file: **the phone never decides
/// it is allowed to dial.** Every outbound path runs the server's pre-call
/// firewall audit first, carries that audit's own id into `POST /calls`, and
/// only reaches `sdk.connect` after the server has said `.allowed`. A BLOCK, a
/// REQUIRE_REVIEW the rep has not acknowledged, a refusal, or *any* thrown
/// error all end with the rep reading a reason and the SDK untouched — there
/// is deliberately no code path from a dial tap to the radio that does not
/// pass through the server.
///
/// The second rule: nothing fails quietly. Every refusal and every thrown
/// error lands in `lastRefusal`, because a dial that silently does nothing is
/// indistinguishable to a rep from a broken app.
///
/// Owns nothing concrete — the Twilio SDK, CallKit, and the network are all
/// injected protocols (`VoiceSDK`, `CallSystem`, `CallsAPIClient`), so the
/// whole machine runs in a host-free test bundle.
@MainActor
final class CallController: ObservableObject {

    /// Where a call is. The associated values are what the screen draws, so a
    /// view never has to reach back into the controller for "who is this".
    enum Phase: Equatable {
        case idle
        /// Inbound, not yet answered.
        case ringing(CallerInfo)
        /// Outbound, mid-audit/mid-connect. Blocks a second dial.
        case dialing(CallerInfo)
        case active(CallerInfo, since: Date)
        /// The call is over and the rep owes it a disposition.
        ///
        /// `callId` is the row that disposition posts against, and it is
        /// **never** optional: an OUTBOUND call carries the id `POST /calls`
        /// returned, and a wrap-up reopened from the server's pending row
        /// carries that row's id. An answered INBOUND call reaches neither —
        /// it auto-logs server-side and goes straight back to `.idle`. See
        /// `endCall`.
        case wrapup(callId: String, CallerInfo)
        /// The audit came back REQUIRE_REVIEW: the rep must see `reasons` (and
        /// read `requiredScriptId`'s script) and explicitly acknowledge before
        /// this call is placed. Nothing has been dialed.
        case needsAcknowledgement(CallerInfo, reasons: [String], requiredScriptId: String?)
    }

    /// A REQUIRE_REVIEW verdict, held while the rep reads it, so
    /// `acknowledge()` re-places against the audit row the server already has
    /// rather than opening a fresh one.
    private struct HeldReview {
        let auditId: String
        let info: CallerInfo
        let e164: String
        let recipientRecordId: String?
        let recipientObjectType: String?
    }

    @Published private(set) var phase: Phase = .idle
    /// The last thing the server (or a failure) said, verbatim, for the screen
    /// to show. Cleared when a new dial starts — never by a success.
    @Published private(set) var lastRefusal: String?
    @Published private(set) var isMuted = false
    /// The firewall-approved DID the server pinned for the live call, as
    /// `POST /calls` reported it. Display only — the app never chooses it.
    @Published private(set) var fromNumber: String?
    /// True while a wrap-up is being posted. Published so the wrap-up screen
    /// can disable Save; enforced below so a second tap cannot post twice.
    @Published private(set) var isSubmittingWrapup = false

    /// What the rep is told when they try to start a call while one is already
    /// on screen. Local wording, not the server's — no dial was attempted.
    static let busyRefusal = "Finish your current call first."

    private let sdk: VoiceSDK
    private let system: CallSystem
    private let api: CallsAPIClient
    private let tokens: () -> String
    private let now: () -> Date
    /// Called when a session-authenticated call comes back 401 — see
    /// `isSessionExpired`. The controller does not decide what happens next
    /// (that is a sign-out, which it has no business running); it only reports
    /// that this phone's Salesforce session is gone, so nobody is left tapping
    /// Call against a sign-in that no longer exists.
    private let onSessionExpired: () -> Void

    private var invite: IncomingInvite?
    private var call: ActiveCall?
    private var callId: String?
    private var heldReview: HeldReview?

    /// Bumped every time the controller starts on a *different* call — a new
    /// ring, a new dial, or a return to idle.
    ///
    /// `finishWrapup` awaits the network, and the rep can walk away from that
    /// wrap-up (Skip) and start another call before the POST comes back. The
    /// continuation that resumes afterwards is holding state about a call that
    /// is over: without this token it would resolve *the new call's* pending
    /// disposition, or run `reset()` and drop a live call to `.idle` with its
    /// media still up. Capture it before an await, check it after, and a stale
    /// continuation becomes a no-op.
    private var generation = 0

    private var isIdle: Bool {
        if case .idle = phase { return true }
        return false
    }

    init(
        sdk: VoiceSDK,
        system: CallSystem,
        api: CallsAPIClient,
        tokens: @escaping () -> String,
        now: @escaping () -> Date = Date.init,
        onSessionExpired: @escaping () -> Void = {}
    ) {
        self.sdk = sdk
        self.system = system
        self.api = api
        self.tokens = tokens
        self.now = now
        self.onSessionExpired = onSessionExpired
    }

    // MARK: - Inbound

    /// Turns a VoIP push into a ringing call.
    ///
    /// Synchronous on purpose: PushKit requires the call to be reported to
    /// CallKit before its delegate method returns, so the report is issued on
    /// this same stack (see `CallSystem.reportIncoming`). A push that is not an
    /// invite is simply ignored — PushKit gives us nothing to refuse with.
    func handleIncomingPush(_ payload: [AnyHashable: Any]) {
        guard let invite = sdk.handleIncomingPush(payload: payload) else { return }

        // One call at a time. Accepting a second invite here would overwrite
        // the live call's state and orphan it — still connected, with nothing
        // left able to hang it up. Rejecting sends the second caller to the
        // server's own fallback, which is what a busy line is for.
        guard case .idle = phase else {
            invite.reject()
            return
        }
        self.invite = invite
        generation += 1
        // A fresh ring is not the place to still be showing why the *last*
        // call was refused.
        lastRefusal = nil

        let info = CallerInfo.from(customParameters: invite.customParameters, from: invite.from)
        phase = .ringing(info)

        // The CallKit banner gets the record type glued on ("Jordyn Freedman ·
        // Lead") when there is a name to glue it to; "Record" mirrors the
        // server's own fallback for a matched record of no particular type.
        let title = info.name.map { "\($0) · \(info.recordType ?? "Record")" } ?? info.displayTitle
        system.reportIncoming(uuid: invite.uuid, title: title, handle: info.number) { [weak self] error in
            guard let error else { return }
            onMainActor { self?.incomingReportFailed(invite: invite, error: error) }
        }
    }

    /// CallKit refused the call (Do Not Disturb, blocked caller, filtered).
    /// The invite cannot be left ringing against a call the system does not
    /// know about, so it is rejected and the rep is told why.
    private func incomingReportFailed(invite: IncomingInvite, error: Error) {
        // A late refusal that arrives after the rep already answered is not
        // allowed to tear down a live call.
        guard case .ringing = phase, self.invite === invite else { return }
        invite.reject()
        lastRefusal = error.localizedDescription
        reset()
    }

    func answer() {
        guard case let .ringing(info) = phase, let invite else { return }
        attach(invite.accept())
        self.invite = nil
        phase = .active(info, since: now())
    }

    func decline() {
        guard case .ringing = phase, let invite else { return }
        invite.reject()
        // Tell CallKit too: the invite is dead, and leaving the system's call
        // up would strand the phone in an in-call state with nothing behind it.
        system.reportEnded(uuid: invite.uuid)
        reset()
    }

    // MARK: - Outbound

    /// Audits, then dials. Never the other way round, and never one without
    /// the other.
    ///
    /// `recipientRecordId`/`recipientObjectType` identify the Lead/Contact the
    /// rep tapped, when there was one — they ride along so the server can
    /// attach the call to the right record.
    func placeCall(to e164: String, recipientRecordId: String? = nil, recipientObjectType: String? = nil) async {
        guard isIdle else {
            // Silently doing nothing reads as a broken button.
            lastRefusal = Self.busyRefusal
            return
        }
        lastRefusal = nil
        generation += 1
        let info = CallerInfo(number: e164, name: nil, recordId: recipientRecordId, recordType: recipientObjectType)
        phase = .dialing(info)

        do {
            let verdict = try await api.precall(to: e164, recipientRecordId: recipientRecordId)
            switch verdict.decision {
            case .block:
                // The server's words, not ours. `reasons` is the fallback for a
                // BLOCK that carries no human-readable reason: still specific,
                // still the server's, and better than a blank refusal.
                lastRefusal = verdict.blockReason ?? verdict.reasons.joined(separator: ", ")
                reset()

            case .requireReview:
                holdForReview(
                    auditId: verdict.auditId, info: info, e164: e164,
                    reasons: verdict.reasons, requiredScriptId: verdict.requiredScriptId,
                    recipientRecordId: recipientRecordId, recipientObjectType: recipientObjectType
                )

            case .allow:
                try await dial(
                    info: info, e164: e164, auditId: verdict.auditId, acknowledged: false,
                    recipientRecordId: recipientRecordId, recipientObjectType: recipientObjectType
                )
            }
        } catch {
            fail(with: error)
        }
    }

    /// The rep read the review reasons and chose to call anyway. Places against
    /// the held audit with `acknowledged: true` — the only way that audit's
    /// call is ever allowed through.
    func acknowledge() async {
        guard case let .needsAcknowledgement(info, _, _) = phase, let review = heldReview else {
            // A stale tap after a cancel (idle) is simply nothing to do; a tap
            // while another call is up gets the dial pad's own answer.
            if !isIdle { lastRefusal = Self.busyRefusal }
            return
        }
        lastRefusal = nil
        generation += 1
        phase = .dialing(info)
        do {
            try await dial(
                info: info, e164: review.e164, auditId: review.auditId, acknowledged: true,
                recipientRecordId: review.recipientRecordId, recipientObjectType: review.recipientObjectType
            )
        } catch {
            fail(with: error)
        }
    }

    func cancelAcknowledgement() {
        guard case .needsAcknowledgement = phase else { return }
        reset()
    }

    /// The single place `sdk.connect` is reached from — and it is reachable
    /// only with an `auditId` the server itself issued.
    private func dial(
        info: CallerInfo, e164: String, auditId: String, acknowledged: Bool,
        recipientRecordId: String?, recipientObjectType: String?
    ) async throws {
        let result = try await api.place(
            to: e164, auditId: auditId, acknowledged: acknowledged,
            recipientRecordId: recipientRecordId, recipientObjectType: recipientObjectType
        )

        switch result {
        case let .allowed(callId, fromNumber):
            self.callId = callId
            self.fromNumber = fromNumber
            heldReview = nil
            // `CallDbId` is what ties the media leg back to the row the server
            // just created and to the DID it pinned; the SDK is never asked to
            // choose a caller id.
            let call = try await sdk.connect(accessToken: tokens(), params: ["To": e164, "CallDbId": callId])
            attach(call)
            system.reportOutgoingStarted(uuid: call.uuid, handle: e164)
            phase = .active(info, since: now())

        case let .refused(reason):
            lastRefusal = reason
            reset()

        case let .reviewRequired(reasons, requiredScriptId):
            // The server changed its mind between the audit and the dial (a
            // clock crossing a calling-hours edge, most often). Same stop as a
            // REQUIRE_REVIEW verdict, against the same audit — v1 does not
            // re-audit on its own; an expired audit comes back as a `.refused`
            // the rep reads before tapping call again.
            holdForReview(
                auditId: auditId, info: info, e164: e164,
                reasons: reasons, requiredScriptId: requiredScriptId,
                recipientRecordId: recipientRecordId, recipientObjectType: recipientObjectType
            )

        case let .dispositionRequired(pending):
            // The dial is refused because an earlier call still owes a
            // disposition — and the server handed that call back rather than
            // just saying no. Reopening its wrap-up here is the difference
            // between a rep who can log it and dial on, and one who reads
            // "disposition your previous call" for the next ten minutes with
            // no screen anywhere that lets them.
            openWrapup(for: pending)
        }
    }

    /// The Dial screen's "finish your last call" banner, tapped.
    ///
    /// The same transition `.dispositionRequired` makes, reachable before the
    /// rep has been refused: the banner already names the call, so it may as
    /// well be the way back into it.
    func resumeWrapup(_ pending: CallSummary) {
        guard isIdle else {
            lastRefusal = Self.busyRefusal
            return
        }
        openWrapup(for: pending)
    }

    /// Reopens the server's pending call as a wrap-up.
    ///
    /// `recordId` prefers `whoId` (a Lead/Contact) over `whatId`: the wrap-up
    /// screen shows one record, and the person is the one a rep recognizes.
    /// The number is already the server's normalized E.164.
    private func openWrapup(for pending: CallSummary) {
        // A new call context: anything still awaiting on the old one is stale
        // from here, and its continuation must not reset this wrap-up.
        generation += 1
        heldReview = nil
        callId = pending.id
        fromNumber = pending.fromNumber
        // Not a refusal any more — the rep has somewhere to go.
        lastRefusal = nil
        phase = .wrapup(callId: pending.id, CallerInfo(
            number: pending.toNumber,
            name: nil,
            recordId: pending.salesforceWhoId ?? pending.salesforceWhatId,
            recordType: nil
        ))
    }

    private func holdForReview(
        auditId: String, info: CallerInfo, e164: String,
        reasons: [String], requiredScriptId: String?,
        recipientRecordId: String?, recipientObjectType: String?
    ) {
        heldReview = HeldReview(
            auditId: auditId, info: info, e164: e164,
            recipientRecordId: recipientRecordId, recipientObjectType: recipientObjectType
        )
        phase = .needsAcknowledgement(info, reasons: reasons, requiredScriptId: requiredScriptId)
    }

    /// Anything thrown on a dial path. The server may well have created a call
    /// row before the failure (a `connect` that fails after `POST /calls`
    /// succeeded); that row is exactly what `GET /calls/pending-disposition`
    /// exists to hand back, so local state is dropped rather than guessed at.
    private func fail(with error: Error) {
        lastRefusal = error.localizedDescription
        reportIfSessionExpired(error)
        reset()
    }

    /// A 401 from a session-authenticated call is not a refusal the rep can
    /// act on: their Salesforce session has expired and every route on this
    /// phone will answer the same way until they sign in again. The error is
    /// still shown — this only adds the part the screen cannot say.
    private func reportIfSessionExpired(_ error: Error) {
        guard isSessionExpired(error) else { return }
        onSessionExpired()
    }

    // MARK: - In call

    func setMuted(_ on: Bool) {
        guard let call else { return }
        call.setMuted(on)
        isMuted = on
    }

    /// The in-call keypad, and the only way through an IVR once a call is up.
    ///
    /// Gated on `.active` for the same reason mute is: there is no leg to tone
    /// into while dialing, ringing, or wrapping up, and a digit sent then is
    /// lost rather than queued. Nothing to report back — DTMF is audio on a
    /// connected leg, so there is no acknowledgement to wait for.
    func sendDigits(_ digits: String) {
        guard case .active = phase, let call else { return }
        call.sendDigits(digits)
    }

    func hangUp() {
        // CallKit sends the rep's "end call" to one action whether the call is
        // ringing or up, and both routings land here. Ending a ringing call is
        // a decline — there is no media to hang up, only an invite to refuse.
        if case .ringing = phase { return decline() }
        guard let info = liveCaller else { return }
        call?.hangUp()
        endCall(info: info)
    }

    /// The far end hung up, or the media died.
    private func callDidDisconnect(_ error: Error?) {
        guard let info = liveCaller else { return }
        // A disconnect error is the only signal the rep gets that the call
        // dropped rather than ended; swallowing it would leave them staring at
        // a wrap-up for a call they think they completed.
        if let error { lastRefusal = error.localizedDescription }
        endCall(info: info)
    }

    /// The one exit from a live call, shared by the local hang-up and the
    /// remote one so a remotely-ended OUTBOUND call can never skip the wrap-up
    /// (and so leave the rep's next dial blocked by the server's disposition
    /// gate with nothing on screen explaining it).
    ///
    /// An INBOUND call goes straight back to `.idle` instead, because there is
    /// nothing on this phone to post: the server made that row and its own
    /// sweep dispositions it. `findPendingDisposition`
    /// (`services/cti-api/src/routes/calls.ts`) matches `direction =
    /// 'outbound'` only, so an inbound wrap-up had no id to resolve and
    /// silently discarded the rep's disposition and notes on every answered
    /// inbound call. The web softphone shows no wrap-up for inbound either —
    /// this is the same rule, not a phone-specific one.
    private func endCall(info: CallerInfo) {
        // Detach before ending: this both breaks the controller ⇄ call
        // reference and stops a local hang-up from bouncing back through
        // `onDisconnect` into a second transition.
        let uuid = call?.uuid
        let callId = self.callId
        call?.onDisconnect = nil
        call = nil
        invite = nil
        isMuted = false
        if let uuid { system.reportEnded(uuid: uuid) }
        guard let callId else {
            // Inbound. `reset()` keeps `lastRefusal`, so a call that *dropped*
            // still says so on the way back to the dial pad.
            reset()
            return
        }
        phase = .wrapup(callId: callId, info)
    }

    /// A call only ends from `.active`. `.dialing` is deliberately excluded:
    /// the audit/place round trip is still in flight and would set `.active`
    /// straight over any wrap-up written underneath it.
    private var liveCaller: CallerInfo? {
        guard case let .active(info, _) = phase else { return nil }
        return info
    }

    private func attach(_ call: ActiveCall) {
        self.call = call
        call.onDisconnect = { [weak self, weak call] error in
            // `[weak self]`: the call holds this closure and the controller
            // holds the call, so a strong capture would be a cycle that
            // outlives every call the app ever makes.
            onMainActor {
                // The callback carries no call identity of its own, so it has
                // to be established here — and *inside* the hop, because the
                // current call can change while a late disconnect is crossing
                // the actor boundary. An old call's far end reporting in must
                // never tear down the one that replaced it.
                guard let self, let call, self.call === call else { return }
                self.callDidDisconnect(error)
            }
        }
    }

    // MARK: - Wrap-up

    /// Posts the disposition that closes the call out, against the id the phase
    /// is already carrying — either the one `POST /calls` returned for this
    /// dial, or the one the server handed back with a `DISPOSITION_REQUIRED`
    /// refusal. There is no lookup and no guess: a wrap-up without an id is a
    /// state this controller never enters.
    func finishWrapup(disposition: String, notes: String) async {
        // A second Save while the first is still in flight would post the
        // disposition twice.
        guard case let .wrapup(callId, _) = phase, !isSubmittingWrapup else { return }
        let generation = self.generation
        isSubmittingWrapup = true

        do {
            try await api.disposition(callId: callId, disposition: disposition, notes: notes)
            // Critical: a POST that lands after the rep skipped and dialed
            // again belongs to a call that is over — resetting here would drop
            // the live call to `.idle` with its media still up.
            guard isCurrent(generation) else { return }
            reset()
        } catch {
            guard isCurrent(generation) else { return }
            isSubmittingWrapup = false
            // Stay in wrap-up. Dropping it would throw away the rep's notes and
            // leave their next dial refused by the disposition gate with no
            // explanation on screen.
            lastRefusal = error.localizedDescription
            reportIfSessionExpired(error)
        }
    }

    /// Whether the work started at `generation` still concerns the call on
    /// screen. A stale continuation returns without touching anything: the
    /// newer call owns this state now, and `reset` already cleared the flag.
    private func isCurrent(_ generation: Int) -> Bool {
        generation == self.generation
    }

    func skipWrapup() {
        guard case .wrapup = phase else { return }
        reset()
    }

    // MARK: -

    /// Back to idle with nothing held over. Deliberately does **not** clear
    /// `lastRefusal`: the reason a dial was refused has to outlive the
    /// transition that refused it, or the rep never sees it. `placeCall` clears
    /// it when the next attempt starts.
    private func reset() {
        invite = nil
        call?.onDisconnect = nil
        call = nil
        callId = nil
        fromNumber = nil
        heldReview = nil
        isMuted = false
        isSubmittingWrapup = false
        // Whatever was awaiting on the old call is stale from here on.
        generation += 1
        phase = .idle
    }
}
