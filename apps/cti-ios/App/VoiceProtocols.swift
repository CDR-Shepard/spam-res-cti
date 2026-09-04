import Foundation

// -----------------------------------------------------------------------------
// The seams `CallController` is built on.
//
// Everything the softphone touches that cannot exist in a test process — the
// Twilio Voice SDK, CallKit, the network — is behind one of these. The live
// adapters (a `TwilioVoiceSDK` wrapper, a `CXProvider` wrapper) land in the
// next task; nothing in this file imports TwilioVoice, CallKit, or UIKit, so
// the whole state machine compiles and runs in a host-free test bundle.
// -----------------------------------------------------------------------------

/// The voice client: registration for VoIP pushes, placing a call, and turning
/// an incoming push payload into an invite.
protocol VoiceSDK {
    func register(accessToken: String, deviceToken: Data) async throws
    func unregister(accessToken: String, deviceToken: Data) async throws
    func connect(accessToken: String, params: [String: String]) async throws -> ActiveCall
    /// `nil` when the payload is not a call invite (a cancel, or a push for
    /// something else) — never a throw, because PushKit gives us no way to
    /// refuse a payload.
    func handleIncomingPush(payload: [AnyHashable: Any]) -> IncomingInvite?
}

/// A call that is up. Its `uuid` is the identity CallKit knows it by, so it
/// must be the invite's UUID for an inbound call.
protocol ActiveCall: AnyObject {
    var uuid: UUID { get }
    func hangUp()
    func setMuted(_ on: Bool)
    /// Sends DTMF tones down the live leg — the in-call keypad, and the only
    /// way through an IVR ("press 2 for accounts") once a call is up.
    ///
    /// Fire and forget by design: the tones are audio on a leg that is already
    /// connected, so there is no acknowledgement to wait for and nothing
    /// useful to report if the leg has since died.
    func sendDigits(_ digits: String)
    /// Fired once when the far end (or the network) ends the call.
    ///
    /// **Delivered on the main thread.** The live adapter is responsible for
    /// hopping if its SDK delegate arrives elsewhere; `CallController` checks
    /// anyway rather than trusting it with a trap.
    ///
    /// **A disconnect that occurs before `onDisconnect` is attached MUST be
    /// replayed when the handler is set.** The window is real — a call can fail
    /// between `connect` returning and the controller wiring this up — and a
    /// dropped disconnect strands the app in `.active` on dead media, with no
    /// wrap-up and the next dial blocked by the server's disposition gate.
    ///
    /// The callback carries no identity, so the controller matches it against
    /// the call it currently holds; an adapter must not reuse one call object
    /// across two calls.
    var onDisconnect: ((Error?) -> Void)? { get set }
}

/// A ringing inbound call that has not been answered or rejected yet.
protocol IncomingInvite: AnyObject {
    var uuid: UUID { get }
    /// The caller's number, absent when the caller withheld it.
    var from: String? { get }
    /// The `<Parameter>` values from the inbound TwiML — see `CallerInfo.from`.
    var customParameters: [String: String] { get }
    func accept() -> ActiveCall
    func reject()
}

/// CallKit, as the controller needs it.
///
/// Routing the provider's actions back into `CallController`:
/// `CXAnswerCallAction` → `answer()`; **`CXEndCallAction` → `decline()` while
/// the call is ringing and `hangUp()` while it is active** — and both are safe
/// either way, since `hangUp()` on a ringing call declines it. `CXSetMutedCallAction`
/// → `setMuted(_:)`.
protocol CallSystem {
    /// Reports an inbound call to the system.
    ///
    /// **Must call `CXProvider.reportNewIncomingCall` synchronously, on the
    /// caller's own stack.** iOS terminates an app that takes a VoIP push and
    /// does not report a call before the PushKit delegate method returns, and a
    /// `Task` hopped onto the main actor does not run until *after* it returns
    /// — which is why this is a completion handler and not `async`. The
    /// completion fires when CallKit answers; a non-nil error is a real refusal
    /// (Do Not Disturb, the caller blocked, the call filtered) and means the
    /// invite must be rejected.
    func reportIncoming(uuid: UUID, title: String, handle: String, completion: @escaping (Error?) -> Void)
    func reportOutgoingStarted(uuid: UUID, handle: String)
    func reportEnded(uuid: UUID)
}

/// The three calls-API round trips a dial needs, as one injectable seam.
///
/// The pure request builders and decoders these compose live in
/// `Shared/CallsAPI.swift`; this protocol exists so `CallController` can be
/// driven without a network. Note the order the two write calls imply: the
/// pre-call audit (`precall`) is a *separate server round trip* whose
/// `auditId` the dial (`place`) then carries, because the server re-reads that
/// audit row rather than trusting any verdict the client reports back.
protocol CallsAPIClient {
    func precall(to e164: String, recipientRecordId: String?) async throws -> PrecallVerdict
    func place(to e164: String, auditId: String, acknowledged: Bool,
               recipientRecordId: String?, recipientObjectType: String?) async throws -> PlaceCallResult
    func disposition(callId: String, disposition: String, notes: String) async throws
    func pendingDisposition() async throws -> CallSummary?
}

/// `POST /calls/:id/disposition` is the one calls-API path with nothing to
/// decode — it answers `{ call, salesforceSync }` and the app reads neither, so
/// only the status matters. It gets its own error rather than reusing
/// `SessionClientError.server`, whose message ("The server refused the
/// sign-in…") would be nonsense on a wrap-up screen.
struct DispositionFailed: LocalizedError, Equatable {
    let status: Int
    var errorDescription: String? { "The wrap-up could not be saved (HTTP \(status)). Try again." }
}

/// The one live `CallsAPIClient`: wiring only. Every request shape and every
/// response reading is `Shared/CallsAPI.swift`'s, already pinned by
/// `CallsAPITests`; all this does is hand each built request to the injected
/// transport and pass the `(Data, status)` pair to the matching decoder.
struct LiveCallsAPI: CallsAPIClient {
    let baseURL: URL
    let sessionToken: String
    var transport: PairingTransport = livePairingTransport

    func precall(to e164: String, recipientRecordId: String?) async throws -> PrecallVerdict {
        let request = precallRequest(
            baseURL: baseURL, sessionToken: sessionToken, toNumber: e164, recipientRecordId: recipientRecordId
        )
        let (data, status) = try await transport(request)
        return try decodePrecall(data, status: status)
    }

    func place(to e164: String, auditId: String, acknowledged: Bool,
               recipientRecordId: String?, recipientObjectType: String?) async throws -> PlaceCallResult {
        let request = placeCallRequest(
            baseURL: baseURL, sessionToken: sessionToken, toNumber: e164, auditId: auditId,
            acknowledged: acknowledged, recipientRecordId: recipientRecordId, recipientObjectType: recipientObjectType
        )
        let (data, status) = try await transport(request)
        return try decodePlaceCall(data, status: status)
    }

    func disposition(callId: String, disposition: String, notes: String) async throws {
        // `dispositionRequest` omits `notes` entirely when nil, matching the
        // server's `.optional()`; an empty text field is "no notes", not "".
        let request = try dispositionRequest(
            baseURL: baseURL, sessionToken: sessionToken, callId: callId,
            disposition: disposition, notes: notes.isEmpty ? nil : notes
        )
        let (_, status) = try await transport(request)
        guard (200..<300).contains(status) else { throw DispositionFailed(status: status) }
    }

    func pendingDisposition() async throws -> CallSummary? {
        let request = pendingDispositionRequest(baseURL: baseURL, sessionToken: sessionToken)
        let (data, status) = try await transport(request)
        return try decodePendingDisposition(data, status: status)
    }
}
