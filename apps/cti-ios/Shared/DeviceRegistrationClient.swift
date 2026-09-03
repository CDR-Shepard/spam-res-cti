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
