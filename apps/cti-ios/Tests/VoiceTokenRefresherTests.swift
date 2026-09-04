import XCTest

/// A one-shot async signal — the alternative to a sleep when a test needs to
/// know that something has *started* before it lets it finish.
actor Signal {
    private var isSet = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func send() {
        isSet = true
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume() }
    }

    func wait() async {
        if isSet { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

/// The one testable piece of the live voice stack: when a Twilio access token
/// is reused and when it is re-minted.
///
/// Worth pinning because both failure modes are invisible until a rep cannot
/// call. Minting on every dial burns a server round trip (and a Twilio JWT) on
/// the critical path; reusing one past its expiry makes `connect` fail with a
/// Twilio auth error the rep reads as "the app is broken".
final class VoiceTokenRefresherTests: XCTestCase {

    /// UTC, built from components rather than parsed — so this test does not
    /// prove `ISO8601DateFormatter` correct using `ISO8601DateFormatter`.
    private func utc(_ hour: Int, _ minute: Int, _ second: Int = 0) -> Date {
        var components = DateComponents()
        components.year = 2026
        components.month = 9
        components.day = 4
        components.hour = hour
        components.minute = minute
        components.second = second
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: components)!
    }

    func testRefreshesWhenWithinFiveMinutesOfExpiry() async throws {
        var fetches = 0
        let refresher = VoiceTokenRefresher(
            fetch: {
                fetches += 1
                return VoiceToken(
                    token: "t\(fetches)",
                    expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
                )
            },
            now: { Date() }
        )

        _ = try await refresher.current()
        _ = try await refresher.current()
        XCTAssertEqual(fetches, 1, "a token with an hour left is reused")

        refresher.forceExpiryForTest(Date().addingTimeInterval(120))
        _ = try await refresher.current()
        XCTAssertEqual(fetches, 2, "under five minutes of life left, the token is re-minted")
    }

    /// The server sends `new Date(...).toISOString()`
    /// (`services/cti-api/src/telephony/twilio.ts`), which carries
    /// milliseconds — a format `ISO8601DateFormatter`'s defaults refuse. A
    /// parse failure is indistinguishable from "expired", so getting this
    /// wrong would silently mint a fresh token on every single dial.
    func testParsesTheServersFractionalSecondExpiry() async throws {
        var fetches = 0
        let refresher = VoiceTokenRefresher(
            fetch: {
                fetches += 1
                return VoiceToken(token: "t", expiresAt: "2026-09-04T12:00:00.500Z")
            },
            now: { self.utc(11, 0) }
        )

        _ = try await refresher.current()
        _ = try await refresher.current()
        XCTAssertEqual(fetches, 1, "an hour of life left, read through the milliseconds")
    }

    /// An expiry the phone cannot read is treated as already expired. Erring
    /// towards a spare round trip beats erring towards a dial that cannot
    /// connect.
    func testAnUnreadableExpiryIsTreatedAsExpired() async throws {
        var fetches = 0
        let refresher = VoiceTokenRefresher(
            fetch: {
                fetches += 1
                return VoiceToken(token: "t", expiresAt: "not-a-date")
            },
            now: { self.utc(11, 0) }
        )

        _ = try await refresher.current()
        _ = try await refresher.current()
        XCTAssertEqual(fetches, 2)
    }

    /// `CallController.tokens` is synchronous — it is called on the way into
    /// `sdk.connect` and cannot await a mint — so the cached token has to be
    /// readable without one.
    func testCachedTokenIsReadableSynchronouslyAfterARefresh() async throws {
        let refresher = VoiceTokenRefresher(
            fetch: { VoiceToken(token: "minted", expiresAt: "2026-09-04T12:00:00.000Z") },
            now: { self.utc(11, 0) }
        )

        XCTAssertEqual(refresher.cachedAccessToken, "", "nothing minted yet")
        _ = try await refresher.current()
        XCTAssertEqual(refresher.cachedAccessToken, "minted")
    }

    /// Two callers arriving while a mint is in flight — the launch warm-up and
    /// a foreground, most often — must share it. Two mints would mean two
    /// Twilio registrations racing to bind the same PushKit token, and the
    /// loser silently stops the phone ringing.
    func testConcurrentCallersShareOneMint() async throws {
        let started = Signal()
        let mayFinish = Signal()
        var fetches = 0

        let refresher = VoiceTokenRefresher(
            fetch: {
                fetches += 1
                let minted = "t\(fetches)"
                await started.send()
                await mayFinish.wait()
                return VoiceToken(token: minted, expiresAt: "2026-09-04T12:00:00.000Z")
            },
            now: { self.utc(11, 0) }
        )

        let first = Task { try await refresher.current() }
        let second = Task { try await refresher.current() }
        // No sleep: the mint parks itself and says so, and only then is it let go.
        await started.wait()
        await mayFinish.send()

        let a = try await first.value
        let b = try await second.value
        XCTAssertEqual(fetches, 1)
        XCTAssertEqual(a, b, "both callers got the same token, so only one was ever minted")
    }

    /// A failed mint must not be cached as a token: the next dial has to try
    /// again rather than reuse a blank.
    func testAFailedMintPropagatesAndCachesNothing() async {
        struct Boom: Error {}
        let refresher = VoiceTokenRefresher(fetch: { throw Boom() }, now: { self.utc(11, 0) })

        do {
            _ = try await refresher.current()
            XCTFail("expected the fetch failure to propagate")
        } catch {
            XCTAssertTrue(error is Boom)
        }
        XCTAssertEqual(refresher.cachedAccessToken, "")
    }
}
