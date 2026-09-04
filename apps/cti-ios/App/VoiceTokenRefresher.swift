import Foundation

/// The Twilio Voice access token, minted on demand and reused until it is
/// nearly spent.
///
/// Two things use it and they want it differently. Registration
/// (`PushRegistry`) can await a mint, so it takes `current()`. A dial cannot —
/// `CallController.tokens` is a synchronous `() -> String` called on the way
/// into `sdk.connect`, precisely so that nothing can await between the
/// server's "allowed" and the radio — so it reads `cachedAccessToken`, which
/// is whatever the last refresh left behind. That is why the app refreshes at
/// launch and on every foreground rather than lazily at dial time.
///
/// Pure by construction: the mint itself is an injected closure, so the cache
/// rule and the expiry arithmetic are testable without a network.
final class VoiceTokenRefresher: @unchecked Sendable {
    typealias Fetch = () async throws -> VoiceToken

    /// How much life a token must have left to be handed out again.
    ///
    /// Five minutes, because the token has to outlive not just the dial but
    /// the call it starts: Twilio checks it at connect time, and a token that
    /// expires seconds later would still leave a rep re-authenticating
    /// mid-conversation on any reconnect.
    static let refreshMargin: TimeInterval = 300

    private let fetch: Fetch
    private let now: () -> Date

    /// One lock over all four fields below. They are read from the main actor
    /// (a dial) and written from a background task (a refresh), so "the token"
    /// and "its expiry" have to move together or a dial can read a new token
    /// against an old expiry.
    private let lock = NSLock()
    private var token = ""
    private var expiresAt: Date?
    /// The mint in progress, so two overlapping callers (launch and a
    /// foreground, say) share one round trip instead of racing two.
    private var inFlight: Task<String, Error>?

    init(fetch: @escaping Fetch, now: @escaping () -> Date = Date.init) {
        self.fetch = fetch
        self.now = now
    }

    /// The token a dial should carry, without awaiting. Empty when nothing has
    /// been minted yet (or the last mint failed) — `connect` will then fail
    /// with a Twilio auth error the controller surfaces as a refusal, which is
    /// the honest outcome: better a named failure than a dial placed with a
    /// token the phone knows is stale.
    var cachedAccessToken: String {
        lock.withLock { token }
    }

    /// The token, minting a new one if the cached one is gone or nearly spent.
    func current() async throws -> String {
        if let fresh = cachedIfFresh() { return fresh }
        return try await mint().value
    }

    private func cachedIfFresh() -> String? {
        lock.withLock {
            guard !token.isEmpty, let expiresAt,
                  expiresAt.timeIntervalSince(now()) >= Self.refreshMargin else { return nil }
            return token
        }
    }

    private func mint() -> Task<String, Error> {
        lock.withLock {
            if let inFlight { return inFlight }
            let task = Task<String, Error> { [weak self] in
                guard let self else { throw CancellationError() }
                defer { self.finishMint() }
                let minted = try await self.fetch()
                self.store(minted)
                return minted.token
            }
            inFlight = task
            return task
        }
    }

    private func store(_ minted: VoiceToken) {
        // An expiry the phone cannot read counts as expired, not as forever:
        // a format change on the server should cost a spare round trip per
        // dial, never a call that cannot connect.
        let expiry = Self.parseExpiry(minted.expiresAt)
        lock.withLock {
            token = minted.token
            expiresAt = expiry
        }
    }

    private func finishMint() {
        lock.withLock { inFlight = nil }
    }

    /// `POST /telephony/token` answers `new Date(...).toISOString()`
    /// (`services/cti-api/src/telephony/twilio.ts`), i.e. *with* milliseconds
    /// — which `ISO8601DateFormatter`'s default options reject. Both spellings
    /// are accepted so neither a server that drops the milliseconds nor one
    /// that keeps them makes every token look expired.
    static func parseExpiry(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        return ISO8601DateFormatter().date(from: raw)
    }

    #if DEBUG
    /// Moves the cached token's expiry, so a test can reach the "nearly spent"
    /// branch without waiting an hour.
    func forceExpiryForTest(_ date: Date) {
        lock.withLock { expiresAt = date }
    }
    #endif
}
