import XCTest

/// `SignOutFlow` is the Sign out button's whole job, pulled into its own type
/// so its order — and the guarantees that follow from it — can be pinned here
/// instead of trusted to a SwiftUI tap handler.
@MainActor
final class SignOutFlowTests: XCTestCase {

    // MARK: - Order

    func testTheOrderIsRevokeThenStopVoiceThenUnpair() async {
        // Every step but the last needs something the last one destroys.
        // `revokeDevice` (DELETE /mobile/devices/<id>) authenticates with the
        // SESSION token; `stopVoice` (VoiceRuntime.stop(), which best-effort
        // unregisters from Twilio) needs the cached voice token and the live
        // push registry. `unpair` deletes the session token and tears the
        // runtime's state down, so it goes last or both earlier steps
        // downgrade to "stop ringing locally and leave the server's rows
        // pointing at a handset that is no longer signed in".
        var order: [String] = []

        await SignOutFlow.run(
            revokeDevice: { order.append("revoke") },
            stopVoice: { order.append("stopVoice") },
            unpair: { order.append("unpair") }
        )

        XCTAssertEqual(order, ["revoke", "stopVoice", "unpair"])
    }

    // MARK: - Best effort means best effort

    func testUnpairStillRunsWhenTheServerRevokeFails() async {
        // The revoke is best-effort by nature — no network, an expired
        // session, a server that is down. A rep who taps Sign out must end up
        // signed out on this handset regardless; the device row is reachable
        // afterwards from the softphone's own device list.
        var order: [String] = []

        await SignOutFlow.run(
            revokeDevice: { throw SignOutFlowTestError.boom },
            stopVoice: { order.append("stopVoice") },
            unpair: { order.append("unpair") }
        )

        XCTAssertEqual(order, ["stopVoice", "unpair"], "a failed revoke must not block the rest of the sign-out")
    }

    func testUnpairStillRunsWhenStopVoiceThrows() async {
        // Same for the Twilio unregistration, which can fail for reasons that
        // have nothing to do with whether this phone should stay signed in.
        var unpairCalled = false

        await SignOutFlow.run(
            revokeDevice: {},
            stopVoice: { throw SignOutFlowTestError.boom },
            unpair: { unpairCalled = true }
        )

        XCTAssertTrue(unpairCalled, "a failed Twilio unregister must not block the actual sign-out")
    }

    // MARK: - What the revoke step is allowed to send

    func testTheRevokerCallsTheServerWithThisPhonesSessionAndDeviceId() async throws {
        let sent = Sent()
        let revoker = SignOutFlow.deviceRevoker(
            deviceId: "dev_row_1",
            sessionToken: "sess_1",
            revoke: { session, deviceId in await sent.record(session: session, deviceId: deviceId) }
        )

        try await revoker()

        let calls = await sent.calls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.session, "sess_1")
        XCTAssertEqual(calls.first?.deviceId, "dev_row_1")
    }

    /// A phone paired with a 6-digit code (before the sign-in flow existed)
    /// never learned its own device id, and a phone with no session has
    /// nothing to authenticate the DELETE with. Neither may send a request
    /// with a hole in it — the row is revoked from the admin device list
    /// instead.
    func testTheRevokerSendsNothingWithoutBothADeviceIdAndASession() async throws {
        let sent = Sent()
        let record: (String, String) async throws -> Void = { session, deviceId in
            await sent.record(session: session, deviceId: deviceId)
        }

        try await SignOutFlow.deviceRevoker(deviceId: nil, sessionToken: "sess_1", revoke: record)()
        try await SignOutFlow.deviceRevoker(deviceId: "dev_row_1", sessionToken: nil, revoke: record)()

        let calls = await sent.calls
        XCTAssertTrue(calls.isEmpty)
    }
}

private enum SignOutFlowTestError: Error {
    case boom
}

/// What the revoke step actually sent. An actor because `revoke` is a plain
/// async closure and does not inherit the test's main-actor isolation.
private actor Sent {
    private(set) var calls: [(session: String, deviceId: String)] = []

    func record(session: String, deviceId: String) {
        calls.append((session: session, deviceId: deviceId))
    }
}
