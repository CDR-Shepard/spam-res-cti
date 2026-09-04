import Foundation

/// The Twilio Voice access token, minted on demand and reused until it is
/// nearly spent.
///
/// Registration (`PushRegistry`) awaits a mint via `current()` — and so does a
/// dial now: `CallController.tokens` is `() async throws -> String`, awaited
/// before the pre-call audit and before `POST /calls`, never between the
/// server's "allowed" verdict and `sdk.connect` (see `CallController.dial`).
/// A token that cannot be minted throws there and is reported before any
/// server-side call row exists, rather than reaching Twilio with an empty
/// string. The one caller left that wants the synchronous, no-await
/// `cachedAccessToken` is `PushRegistry.detach()`'s sign-out unregistration,
/// which deliberately avoids a fresh mint — see that property's own comment.
/// The app still refreshes at launch and on every foreground to keep that
/// cache warm for it.
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

    /// The last token this refresher minted, read without awaiting. Empty
    /// when nothing has been minted yet (or the last mint failed). No longer
    /// read on a dial — `CallController` awaits `current()` instead, before
    /// `POST /calls` — so the one remaining reader is
    /// `PushRegistry.detach()`'s sign-out unregistration, which deliberately
    /// wants whatever is cached rather than risking a fresh mint against a
    /// session that has usually just been cleared.
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
