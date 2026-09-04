import XCTest

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
