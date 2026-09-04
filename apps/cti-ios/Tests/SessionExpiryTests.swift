import XCTest

/// Session tokens expire after 30 days (`services/cti-api/src/auth/session.ts`)
/// and device tokens never do. Before this, a rep whose session had run out saw
/// a confusing dial error while the Status tab still read "Signed in" and the
/// directory kept syncing — a phone that looked fine and could not call.
///
/// Two decisions carry that recovery, and both live here so they can be pinned
/// without a network: **which** errors mean the session expired, and **how many
/// times** that may sign the phone out.
@MainActor
final class SessionExpiryTests: XCTestCase {

    // MARK: - Which errors mean the session is gone

    func testA401FromASessionAuthenticatedCallIsAnExpiredSession() {
        // Every `Shared/` client decodes a 401 into this one error.
        XCTAssertTrue(isSessionExpired(SessionClientError.server(status: 401)))
        // And the disposition POST, which has its own error because its
        // message is what a rep reads on the wrap-up screen.
        XCTAssertTrue(isSessionExpired(DispositionFailed(status: 401)))
    }

    func testAnyOtherServerStatusIsNotAnExpiredSession() {
        // A 403 is the firewall, a 409 the disposition gate, a 500 a bad day.
        // Signing the rep out for any of them would be a self-inflicted
        // outage.
        for status in [400, 403, 409, 412, 500, 503] {
            XCTAssertFalse(isSessionExpired(SessionClientError.server(status: status)), "\(status)")
            XCTAssertFalse(isSessionExpired(DispositionFailed(status: status)), "\(status)")
        }
        XCTAssertFalse(isSessionExpired(SessionClientError.malformedResponse))
        XCTAssertFalse(isSessionExpired(SessionClientError.timedOut))
    }

    /// The load-bearing exclusion. A 401 on the caller-directory feed means the
    /// *device* token was revoked from the admin device list — `SyncEngine`
    /// already unpairs and explains that, and it is a different event with a
    /// different message. Routing it here too would double-handle a revoked
    /// phone and tell the rep their sign-in expired when it did not.
    func testA401FromADeviceTokenCallIsSomebodyElsesProblem() {
        XCTAssertFalse(isSessionExpired(FeedError.http(status: 401)))
    }

    // MARK: - How many times one expiry may sign the phone out

    /// An expiry does not arrive once. The dial, the recents load, the pending
    /// lookup and the voice-token mint can all be in flight together and all
    /// come back 401 — and each of those would otherwise run a whole sign-out
    /// (revoke, Twilio unregister, unpair) against a phone already halfway
    /// through one.
    func testTheLatchFiresOnceHoweverManyCallsComeBackUnauthorized() {
        var fired = 0
        let latch = SessionExpiryLatch { fired += 1 }

        latch.fire()
        latch.fire()
        latch.fire()

        XCTAssertEqual(fired, 1)
        XCTAssertTrue(latch.hasFired)
    }

    func testAFreshLatchHasNotFired() {
        let latch = SessionExpiryLatch {}
        XCTAssertFalse(latch.hasFired)
    }

    // MARK: - The voice-token mint

    /// `POST /telephony/token` is session-authenticated too, and on a phone
    /// that is not being dialled from it is the *first* call to notice the
    /// session has gone: the refresher mints on every foreground.
    func testAMintThatComesBack401ReportsTheExpiryAndStillThrows() async {
        var fired = 0
        let watched = sessionExpiryWatching(
            { throw SessionClientError.server(status: 401) },
            onSessionExpired: { fired += 1 }
        )

        do {
            _ = try await watched()
            XCTFail("the mint failure must still propagate — the caller logs it")
        } catch {
            XCTAssertEqual(error as? SessionClientError, .server(status: 401))
        }
        XCTAssertEqual(fired, 1)
    }

    func testAMintThatFailsForAnyOtherReasonIsNotAnExpiry() async {
        var fired = 0
        let watched = sessionExpiryWatching(
            { throw SessionClientError.server(status: 503) },
            onSessionExpired: { fired += 1 }
        )

        _ = try? await watched()

        XCTAssertEqual(fired, 0, "Twilio being unconfigured must not sign the rep out")
    }

    func testASuccessfulMintPassesStraightThrough() async throws {
        var fired = 0
        let watched = sessionExpiryWatching(
            { VoiceToken(token: "tok_1", expiresAt: "2026-09-03T01:00:00Z") },
            onSessionExpired: { fired += 1 }
        )

        let token = try await watched()

        XCTAssertEqual(token, VoiceToken(token: "tok_1", expiresAt: "2026-09-03T01:00:00Z"))
        XCTAssertEqual(fired, 0)
    }
}
