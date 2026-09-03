import Foundation

struct LoginStart: Decodable, Equatable { let authUrl: URL; let handshake: String }

enum LoginStatus: Equatable {
    case pending, unknown, failed, done
    case connected(token: String, expiresAt: String, displayName: String?)
}

enum SessionClientError: LocalizedError, Equatable {
    case server(status: Int), malformedResponse, timedOut
    var errorDescription: String? {
        switch self {
        case let .server(status): return "The server refused the sign-in (HTTP \(status))."
        case .malformedResponse: return "The server sent an unexpected response."
        case .timedOut: return "Sign-in took too long. Try again."
        }
    }
}

func loginStartRequest(baseURL: URL) throws -> URLRequest {
    var r = URLRequest(url: baseURL.appendingPathComponent("auth/salesforce/login/start"))
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = Data("{}".utf8)
    return r
}

func loginStatusRequest(baseURL: URL, handshake: String) -> URLRequest {
    var c = URLComponents(url: baseURL.appendingPathComponent("auth/salesforce/login/status"), resolvingAgainstBaseURL: false)!
    c.queryItems = [URLQueryItem(name: "handshake", value: handshake)]
    return URLRequest(url: c.url!)
}

func decodeLoginStart(_ data: Data, status: Int) throws -> LoginStart {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let s = try? JSONDecoder().decode(LoginStart.self, from: data) else { throw SessionClientError.malformedResponse }
    return s
}

private struct StatusWire: Decodable {
    struct User: Decodable { let displayName: String? }
    let status: String; let token: String?; let expiresAt: String?; let user: User?
}

func decodeLoginStatus(_ data: Data, status: Int) throws -> LoginStatus {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let w = try? JSONDecoder().decode(StatusWire.self, from: data) else { throw SessionClientError.malformedResponse }
    switch w.status {
    case "pending": return .pending
    case "failed": return .failed
    case "done": return .done
    case "connected":
        guard let t = w.token, let e = w.expiresAt else { throw SessionClientError.malformedResponse }
        return .connected(token: t, expiresAt: e, displayName: w.user?.displayName)
    default: return .unknown
    }
}

/// Polls login/status until it resolves. Injected status + sleep so the state
/// machine is testable without a network or a clock.
struct SignInPoller {
    typealias StatusFetch = (_ handshake: String) async throws -> LoginStatus
    typealias Sleep = (_ seconds: TimeInterval) async -> Void
    let handshake: String
    var interval: TimeInterval = 2
    var maxAttempts: Int = 150 // ~5 minutes at 2s; the server's state expires at 10
    let status: StatusFetch
    let sleep: Sleep

    func run() async throws -> LoginStatus {
        for _ in 0..<maxAttempts {
            let s = try await status(handshake)
            switch s {
            case .pending, .unknown: await sleep(interval)
            case .failed, .done, .connected: return s
            }
        }
        throw SessionClientError.timedOut
    }
}

/// Live transport for the two sign-in requests.
func liveLoginStatus(baseURL: URL) -> SignInPoller.StatusFetch {
    { handshake in
        let (data, resp) = try await URLSession.shared.data(for: loginStatusRequest(baseURL: baseURL, handshake: handshake))
        return try decodeLoginStatus(data, status: (resp as? HTTPURLResponse)?.statusCode ?? 0)
    }
}
