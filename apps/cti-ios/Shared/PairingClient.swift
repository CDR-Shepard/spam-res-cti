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

func claimPairingCode(
    baseURL: URL = AppConfig.baseURL,
    code: String,
    deviceLabel: String
) async throws -> PairClaim {
    var request = URLRequest(url: baseURL.appendingPathComponent("mobile/pair/claim"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(ClaimRequestBody(code: code, deviceLabel: deviceLabel))

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw PairingError.malformedResponse }

    switch http.statusCode {
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
        throw PairingError.server(status: http.statusCode)
    }
}
