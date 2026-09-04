import Foundation

/// POST /mobile/register — the sign-in path's counterpart to
/// `PairingClient.claimPairingCode`. Instead of trading a 6-digit code for a
/// device token, the phone already holds a Salesforce session (from
/// `SessionClient`'s login flow) and asks the server to mint a device token
/// for it directly, carrying the session as a bearer rather than a code in
/// the body.
struct DeviceRegistration: Decodable, Equatable {
    let deviceToken: String
    let deviceId: String
}

private struct RegisterBody: Encodable {
    let deviceLabel: String
}

/// The request the app sends to register this phone. Pure, so a test can
/// assert the path, the bearer, and the body without a network — same shape
/// as `pairingClaimRequest`.
func registerDeviceRequest(baseURL: URL, sessionToken: String, label: String) throws -> URLRequest {
    var r = URLRequest(url: baseURL.appendingPathComponent("mobile/register"))
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
    r.httpBody = try JSONEncoder().encode(RegisterBody(deviceLabel: label))
    return r
}

/// Pure — the server's answer as `SignInView` understands it. Reuses
/// `SessionClientError` rather than inventing a third error enum: a 401 here
/// means the session bearer was bad or expired, which is exactly what
/// `SessionClientError.server` already says.
func decodeRegistration(_ data: Data, status: Int) throws -> DeviceRegistration {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let d = try? JSONDecoder().decode(DeviceRegistration.self, from: data) else { throw SessionClientError.malformedResponse }
    return d
}

/// Live transport for the one registration request.
func liveRegisterDevice(baseURL: URL, sessionToken: String, label: String) async throws -> DeviceRegistration {
    let request = try registerDeviceRequest(baseURL: baseURL, sessionToken: sessionToken, label: label)
    let (data, response) = try await URLSession.shared.data(for: request)
    return try decodeRegistration(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
}

/// `DELETE /mobile/devices/:id` — the sign-out counterpart to `/mobile/register`.
///
/// **Session auth, not device auth.** The route resolves a *session* and scopes
/// the lookup to that rep's own devices, so the bearer is the Salesforce
/// session token — the device token being revoked would be refused. Pure, so
/// the path and the bearer can be pinned without a network.
func revokeDeviceRequest(baseURL: URL, sessionToken: String, deviceId: String) -> URLRequest {
    authedRequest(
        baseURL: baseURL, path: "mobile/devices/\(deviceId)", sessionToken: sessionToken, method: "DELETE"
    )
}

/// Live transport for the revoke. A non-2xx is thrown rather than ignored so
/// the one caller (`SignOutFlow`, where this is explicitly best-effort) is the
/// place that decides to carry on regardless — not this function.
func liveRevokeDevice(baseURL: URL, sessionToken: String, deviceId: String) async throws {
    let request = revokeDeviceRequest(baseURL: baseURL, sessionToken: sessionToken, deviceId: deviceId)
    let (_, status) = try await livePairingTransport(request)
    guard (200..<300).contains(status) else { throw SessionClientError.server(status: status) }
}
