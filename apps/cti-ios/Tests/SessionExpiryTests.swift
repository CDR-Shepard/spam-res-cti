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
    /// through one. Three back-to-back `fire()`s with a confirmation that
    /// resolves true must still only ever confirm and sign out once.
    func testTheGateFiresOnceHoweverManyCallsComeBackUnauthorized() async {
        var fired = 0
        let gate = SessionExpiryGate(confirm: { true }, onExpired: { fired += 1 })

        gate.fire()
        gate.fire()
        gate.fire()
        await gate.waitUntilSettledForTest()

        XCTAssertEqual(fired, 1)
        XCTAssertTrue(gate.hasFired)
    }

    func testAFreshGateHasNotFiredOrStartedConfirming() {
        let gate = SessionExpiryGate(confirm: { true }, onExpired: {})
        XCTAssertFalse(gate.hasFired)
        XCTAssertFalse(gate.isConfirming)
    }

    // MARK: - Confirm before acting (the fix for a spurious 401)
    //
    // A single 401 is not proof the session is gone — an edge/proxy blip or a
    // brief auth-service hiccup can produce one too, and signing out on it
    // would drop every phone in the fleet at once. `SessionExpiryGate.fire()`
    // sends ONE cheap confirmation call first and only signs out if that also
    // comes back 401.

    /// The straightforward case: the confirmation agrees, so the phone signs
    /// out.
    func testAConfirmedExpiryFiresExactlyOnce() async {
        var fired = 0
        let gate = SessionExpiryGate(confirm: { true }, onExpired: { fired += 1 })

        gate.fire()
        await gate.waitUntilSettledForTest()

        XCTAssertEqual(fired, 1)
        XCTAssertTrue(gate.hasFired)
    }

    /// The whole point of asking twice: a confirmation that comes back clean
    /// (this closure standing in for the confirmation GET's 200) must not
    /// sign the rep out — and the gate must reset so it is not deaf to the
    /// NEXT, genuine expiry.
    func testARejectedConfirmationResetsTheGateForALaterGenuineExpiry() async {
        var fired = 0
        var confirmationSaysExpired = false
        let gate = SessionExpiryGate(confirm: { confirmationSaysExpired }, onExpired: { fired += 1 })

        gate.fire()
        await gate.waitUntilSettledForTest()

        XCTAssertEqual(fired, 0, "a clean confirmation must not sign the rep out")
        XCTAssertFalse(gate.hasFired)
        XCTAssertFalse(gate.isConfirming, "must reset so a later genuine expiry is still caught")

        confirmationSaysExpired = true
        gate.fire()
        await gate.waitUntilSettledForTest()

        XCTAssertEqual(fired, 1, "the second, confirmed expiry must still sign out")
        XCTAssertTrue(gate.hasFired)
    }

    /// Four suspected-expiry reports arriving together — a dial, the recents
    /// load, the pending lookup and the mint all 401ing within milliseconds
    /// of each other, exactly as the file header describes — must still send
    /// exactly one confirmation and run exactly one sign-out. The confirmation
    /// is parked on `Signal` (an injected continuation, not a sleep) so the
    /// test can prove the extra `fire()`s land while it is genuinely still in
    /// flight, not just before some scheduler quantum expires.
    func testFourFiresWhileOneConfirmationIsInFlightIssueExactlyOneConfirmation() async {
        var confirmCalls = 0
        var fired = 0
        let entered = Signal()
        let park = Signal()

        let gate = SessionExpiryGate(
            confirm: {
                confirmCalls += 1
                await entered.send()
                await park.wait()
                return true
            },
            onExpired: { fired += 1 }
        )

        gate.fire()
        await entered.wait()
        gate.fire()
        gate.fire()
        gate.fire()

        await park.send()
        await gate.waitUntilSettledForTest()

        XCTAssertEqual(confirmCalls, 1, "one suspected expiry must send exactly one confirmation")
        XCTAssertEqual(fired, 1)
        XCTAssertTrue(gate.hasFired)
    }

    /// Once a sign-out has actually run, the gate is done for this session —
    /// `VoiceRuntime` builds a fresh one on the next sign-in. A later `fire()`
    /// (a stray call arriving after the graph has already been torn down)
    /// must not confirm again or sign out again.
    func testFireAfterAConfirmedSignOutIsANoOp() async {
        var confirmCalls = 0
        var fired = 0
        let gate = SessionExpiryGate(
            confirm: { confirmCalls += 1; return true },
            onExpired: { fired += 1 }
        )

        gate.fire()
        await gate.waitUntilSettledForTest()
        XCTAssertEqual(fired, 1)

        gate.fire()
        await gate.waitUntilSettledForTest()

        XCTAssertEqual(confirmCalls, 1, "an already-fired gate must not confirm again")
        XCTAssertEqual(fired, 1, "an already-fired gate must not sign out twice")
    }

    // MARK: - The confirmation request itself

    /// `confirmSessionExpired` is the real confirmation `VoiceRuntime` builds:
    /// one `GET /calls?limit=1`, the lightest session-authenticated read
    /// there is, chosen over inventing an endpoint. It returns true only when
    /// that GET itself comes back 401 — the same signal `isSessionExpired`
    /// reads elsewhere.
    func testConfirmSessionExpiredReadsA401AsConfirmed() async {
        let confirm = confirmSessionExpired(
            baseURL: URL(string: "https://cti.example.com")!,
            sessionToken: "session_t",
            transport: { _ in (Data(), 401) }
        )

        let confirmed = await confirm()

        XCTAssertTrue(confirmed)
    }

    /// A 200 (or anything else that isn't 401) means the session is fine —
    /// the original error the rep saw was something else, and this must not
    /// read as a confirmed expiry.
    func testConfirmSessionExpiredReadsA200AsNotConfirmed() async {
        let confirm = confirmSessionExpired(
            baseURL: URL(string: "https://cti.example.com")!,
            sessionToken: "session_t",
            transport: { _ in (Data(#"{"calls":[]}"#.utf8), 200) }
        )

        let confirmed = await confirm()

        XCTAssertFalse(confirmed)
    }

    /// A thrown transport error (no connectivity, a timeout, DNS) is not
    /// evidence of anything — the safe default when in doubt is NOT to sign
    /// the rep out, so this must read the same as a 200.
    func testConfirmSessionExpiredReadsAThrownTransportErrorAsNotConfirmed() async {
        struct Boom: Error {}
        let confirm = confirmSessionExpired(
            baseURL: URL(string: "https://cti.example.com")!,
            sessionToken: "session_t",
            transport: { _ in throw Boom() }
        )

        let confirmed = await confirm()

        XCTAssertFalse(confirmed, "a thrown transport error must not be read as a confirmed expiry")
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
