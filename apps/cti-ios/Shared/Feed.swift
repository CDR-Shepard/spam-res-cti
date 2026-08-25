import Foundation

// -----------------------------------------------------------------------------
// The caller-directory feed: GET /mobile/caller-directory
// (services/cti-api/src/routes/mobile.ts).
//
//   {"version":N,"unchanged":true}                        — nothing new
//   {"version":N,"page":p,"pageCount":c,"entries":[...]}  — one page of the feed
//
// Paging is pure logic over an injected transport so it can be unit tested
// without a network; `liveTransport` is the only part that talks to URLSession.
// -----------------------------------------------------------------------------

/// One caller-ID directory entry exactly as the server publishes it.
struct DirectoryEntry: Codable, Equatable {
    let e164: String
    let label: String
}

/// One page of the feed. Every field past `version` is optional because the
/// "unchanged" answer carries none of them.
struct FeedPage: Codable, Equatable {
    let version: Int
    let unchanged: Bool?
    let page: Int?
    let pageCount: Int?
    let entries: [DirectoryEntry]?
}

/// Performs one request and returns its body. Non-2xx is the transport's job
/// to turn into a thrown `FeedError.http` — `fetchAll` only ever sees bodies.
typealias FeedTransport = (URLRequest) async throws -> Data

enum FeedError: Error, Equatable {
    /// The base URL could not be turned into a feed URL.
    case invalidURL
    /// The server answered with a non-2xx status.
    case http(status: Int)
    /// The body was not a feed page (undecodable, or a page missing entries).
    case malformedResponse
    /// The directory kept being republished while we paged through it.
    case versionUnstable
}

/// How many times a whole fetch restarts before giving up when the directory
/// version keeps moving underneath it (see `fetchAll`).
let maxFeedFetchRestarts = 3

/// Pulls the whole directory, page 1..pageCount ascending.
///
/// Returns `nil` when the server says the directory is unchanged since
/// `since`, otherwise the version and every entry, concatenated in server
/// order (already ascending by phone number).
///
/// The server re-reads the latest version on every request, so a directory
/// republished mid-pagination can hand back page 1 at v3 and page 2 at v4.
/// Concatenating those would publish half of one directory and half of
/// another — entries dropped or duplicated with no way to tell — so any
/// version change abandons the partial result and restarts the whole fetch
/// from page 1. Bounded at `maxFeedFetchRestarts` so a directory being
/// rewritten continuously fails loudly instead of looping forever.
func fetchAll(
    baseURL: URL,
    token: String,
    since: Int?,
    transport: @escaping FeedTransport = liveTransport
) async throws -> (version: Int, entries: [DirectoryEntry])? {
    for _ in 0...maxFeedFetchRestarts {
        switch try await fetchAllOnce(baseURL: baseURL, token: token, since: since, transport: transport) {
        case .unchanged:
            return nil
        case let .complete(version, entries):
            return (version, entries)
        case .versionChanged:
            continue
        }
    }
    throw FeedError.versionUnstable
}

// MARK: - One pass over the pages

private enum FetchOutcome {
    case unchanged
    case complete(version: Int, entries: [DirectoryEntry])
    case versionChanged
}

private func fetchAllOnce(
    baseURL: URL,
    token: String,
    since: Int?,
    transport: FeedTransport
) async throws -> FetchOutcome {
    var currentPage = 1
    var version: Int?
    var entries: [DirectoryEntry] = []

    while true {
        let request = try feedRequest(baseURL: baseURL, token: token, since: since, page: currentPage)
        let page = try decodeFeedPage(try await transport(request))

        if page.unchanged == true { return .unchanged }
        if let started = version, started != page.version { return .versionChanged }
        version = page.version

        guard let pageCount = page.pageCount, let pageEntries = page.entries else {
            throw FeedError.malformedResponse
        }
        entries.append(contentsOf: pageEntries)

        // pageCount 0 means an org with no published directory yet: one empty
        // page, and no page 2 to ask for.
        if currentPage >= pageCount { break }
        currentPage += 1
    }

    return .complete(version: version ?? 0, entries: entries)
}

private func decodeFeedPage(_ data: Data) throws -> FeedPage {
    do {
        return try JSONDecoder().decode(FeedPage.self, from: data)
    } catch {
        throw FeedError.malformedResponse
    }
}

private func feedRequest(baseURL: URL, token: String, since: Int?, page: Int) throws -> URLRequest {
    let url = baseURL.appendingPathComponent("mobile/caller-directory")
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        throw FeedError.invalidURL
    }
    var items = [URLQueryItem(name: "page", value: String(page))]
    if let since {
        items.append(URLQueryItem(name: "since", value: String(since)))
    }
    components.queryItems = items
    guard let requestURL = components.url else { throw FeedError.invalidURL }

    var request = URLRequest(url: requestURL)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    return request
}

// MARK: - The real transport

/// The only networking in the feed path: performs the request and hands the
/// response to `feedBody` so callers never have to inspect a `URLResponse`.
func liveTransport(_ request: URLRequest) async throws -> Data {
    let (data, response) = try await URLSession.shared.data(for: request)
    return try feedBody(data: data, response: response)
}

/// Pure — turns one URLSession answer into either a body or a typed
/// `FeedError`. Separate from `liveTransport` because this mapping is the sole
/// input to the revocation path: a revoked device's feed request comes back
/// 401, and `SyncEngine` unpairs the phone on exactly `FeedError.http(401)`.
/// If a non-2xx ever stopped becoming that error, revocation would silently
/// stop working — a phone removed from the softphone's device list would keep
/// its directory and keep syncing. Pinned by FeedTests.
func feedBody(data: Data, response: URLResponse?) throws -> Data {
    guard let http = response as? HTTPURLResponse else { throw FeedError.malformedResponse }
    guard (200..<300).contains(http.statusCode) else { throw FeedError.http(status: http.statusCode) }
    return data
}
