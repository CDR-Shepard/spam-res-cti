import Foundation

/// POST /mobile/pair/claim — trades the 6-digit code the rep reads off the
/// softphone for the phone's long-lived device token
/// (services/cti-api/src/routes/mobile.ts).
struct PairClaim: Decodable, Equatable {
    struct PairedUser: Decodable, Equatable {
        let displayName: String?
    }

    let deviceToken: String
    let user: PairedUser
}

enum PairingError: LocalizedError, Equatable {
    /// 401: unknown, already-used, or expired code — the server deliberately
    /// does not say which.
    case invalidCode
    /// 429: too many attempts.
    case rateLimited
    case server(status: Int)
    case malformedResponse

    var errorDescription: String? {
        switch self {
        case .invalidCode:
            return "That code is not valid any more. Generate a new one in the softphone."
        case .rateLimited:
            return "Too many attempts. Wait a minute and try again."
        case let .server(status):
            return "The server refused the pairing (HTTP \(status))."
        case .malformedResponse:
            return "The server sent an unexpected response."
        }
    }
}

private struct ClaimRequestBody: Encodable {
    let code: String
    let deviceLabel: String
}

/// Performs one pairing request and returns its body with the HTTP status.
/// Injected — unlike the feed's transport this one hands the status back
/// rather than mapping it, because which status means "bad code" and which
/// means "slow down" is the pairing screen's whole error vocabulary and is
/// mapped in `pairingResult` below.
typealias PairingTransport = (URLRequest) async throws -> (Data, Int)

/// The only networking in the pairing path.
func livePairingTransport(_ request: URLRequest) async throws -> (Data, Int) {
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw PairingError.malformedResponse }
    return (data, http.statusCode)
}

/// The request the app sends to claim a code. Pure, so a test can assert the
/// method, path, content type and body the server is actually promised.
func pairingClaimRequest(baseURL: URL, code: String, deviceLabel: String) throws -> URLRequest {
    var request = URLRequest(url: baseURL.appendingPathComponent("mobile/pair/claim"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(ClaimRequestBody(code: code, deviceLabel: deviceLabel))
    return request
}

/// Pure — the server's answer as the pairing screen understands it. Split out
/// of the request so the status mapping (401 → "that code is dead", 429 →
/// "wait a minute", anything else → a plain server error) can be pinned
/// without a network.
func pairingResult(data: Data, status: Int) throws -> PairClaim {
    switch status {
    case 200:
        guard let claim = try? JSONDecoder().decode(PairClaim.self, from: data) else {
            throw PairingError.malformedResponse
        }
        return claim
    case 401:
        throw PairingError.invalidCode
    case 429:
        throw PairingError.rateLimited
    default:
        throw PairingError.server(status: status)
    }
}

func claimPairingCode(
    baseURL: URL = AppConfig.baseURL,
    code: String,
    deviceLabel: String,
    transport: PairingTransport = livePairingTransport
) async throws -> PairClaim {
    let request = try pairingClaimRequest(baseURL: baseURL, code: code, deviceLabel: deviceLabel)
    let (data, status) = try await transport(request)
    return try pairingResult(data: data, status: status)
}
