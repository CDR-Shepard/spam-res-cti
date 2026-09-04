import Foundation

/// `POST /telephony/token` (`services/cti-api/src/routes/telephony.ts`) —
/// mints the Twilio Voice SDK access token the phone's `TwilioVoice` client
/// registers with to place and receive calls. Pure request builder + decoder
/// in the `PairingClient`/`SessionClient` style; the live transport and the
/// SDK registration itself belong to a later task.
struct VoiceToken: Decodable, Equatable {
    let token: String
    let expiresAt: String
}

private struct VoiceTokenBody: Encodable {
    let platform: String
}

/// The request the app sends to mint a voice token. Always `platform: "ios"`
/// — the web softphone's request (no platform, or `"web"`) is a different
/// caller entirely.
func voiceTokenRequest(baseURL: URL, sessionToken: String) throws -> URLRequest {
    let body = try JSONEncoder().encode(VoiceTokenBody(platform: "ios"))
    return authedRequest(baseURL: baseURL, path: "telephony/token", sessionToken: sessionToken, method: "POST", body: body)
}

/// Pure — the server's answer to a token mint. A 503 means the provider
/// (Twilio) rejected `createClientToken`, most commonly because a VoIP push
/// credential isn't configured; surfaced the same as any other server
/// refusal (`SessionClientError.server`) rather than a bespoke case, since
/// there is nothing more specific for the caller to do about it than show an
/// error and let the rep retry later.
func decodeVoiceToken(_ data: Data, status: Int) throws -> VoiceToken {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let token = try? JSONDecoder().decode(VoiceToken.self, from: data) else {
        throw SessionClientError.malformedResponse
    }
    return token
}
