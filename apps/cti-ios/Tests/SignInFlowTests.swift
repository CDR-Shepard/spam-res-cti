import XCTest

/// `SignInFlow` is the one rule this whole file exists to pin down: a session
/// this phone cannot use must never be persisted, and a cancel must not sit
/// waiting for the poll to give up on its own. Every collaborator is a
/// closure fake — no network, no browser, no Keychain — so these run in
/// milliseconds and drive cancellation directly rather than hoping for it.
final class SignInFlowTests: XCTestCase {
    private let start = LoginStart(authUrl: URL(string: "https://login.example.test/sso")!, handshake: "hs_1")
    private let connected = LoginStatus.connected(token: "sess_1", expiresAt: "2099-01-01T00:00:00Z", displayName: "Jane Rep")

    func testARegistrationFailureNeverSavesTheSessionAndDeletesItInstead() async {
        let log = CallLog()
        let deps = SignInFlow.Deps(
            startLogin: { self.start },
            openWeb: { _ in try await Self.hangUntilCancelled() },
            pollStatus: { handshake in
                XCTAssertEqual(handshake, "hs_1")
                return self.connected
            },
            registerDevice: { token, label in
                log.record("register")
                XCTAssertEqual(token, "sess_1")
                XCTAssertEqual(label, "Jane's iPhone")
                throw TestError.boom
            },
            saveSession: { _ in
                XCTFail("a session this phone could not register with must never be saved")
            },
            deleteSession: { log.record("delete") },
            adoptDevice: { _, _ in
                XCTFail("adoptDevice must not run after a failed registration")
            }
        )

        do {
            try await SignInFlow.run(label: "Jane's iPhone", deps: deps)
            XCTFail("expected .registrationFailed")
        } catch let error as SignInFlow.SignInFlowError {
            guard case .registrationFailed = error else {
                return XCTFail("expected .registrationFailed, got \(error)")
            }
        } catch {
            XCTFail("expected a SignInFlowError, got \(error)")
        }

        XCTAssertEqual(log.calls, ["register", "delete"], "delete must run, and only after register — saveSession never runs at all")
    }

    func testADeviceTokenWriteFailureAfterTheSessionSaveDeletesTheSessionAndSurfacesAnError() async {
        let log = CallLog()
        let deps = SignInFlow.Deps(
            startLogin: { self.start },
            openWeb: { _ in try await Self.hangUntilCancelled() },
            pollStatus: { _ in self.connected },
            registerDevice: { _, _ in
                log.record("register")
                return DeviceRegistration(deviceToken: "dev_1", deviceId: "d1")
            },
            saveSession: { _ in log.record("save") },
            deleteSession: { log.record("delete") },
            adoptDevice: { _, _ in
                log.record("adopt")
                throw TestError.boom
            }
        )

        do {
            try await SignInFlow.run(label: "Jane's iPhone", deps: deps)
            XCTFail("expected .registrationFailed")
        } catch let error as SignInFlow.SignInFlowError {
            guard case .registrationFailed = error else {
                return XCTFail("expected .registrationFailed, got \(error)")
            }
        } catch {
            XCTFail("expected a SignInFlowError, got \(error)")
        }

        XCTAssertEqual(
            log.calls,
            ["register", "save", "adopt", "delete"],
            "a device-token write failure must delete the session that was just saved, so the next launch returns to sign-in"
        )
    }

    func testTheHappyPathRegistersSavesThenAdoptsInThatOrder() async throws {
        let log = CallLog()
        let deps = SignInFlow.Deps(
            startLogin: { self.start },
            openWeb: { _ in try await Self.hangUntilCancelled() },
            pollStatus: { _ in self.connected },
            registerDevice: { token, label in
                XCTAssertEqual(token, "sess_1")
                XCTAssertEqual(label, "Jane's iPhone")
                log.record("register")
                return DeviceRegistration(deviceToken: "dev_1", deviceId: "d1")
            },
            saveSession: { token in
                XCTAssertEqual(token, "sess_1")
                log.record("save")
            },
            deleteSession: {
                XCTFail("nothing failed; the session must not be deleted")
            },
            adoptDevice: { deviceToken, displayName in
                XCTAssertEqual(deviceToken, "dev_1")
                XCTAssertEqual(displayName, "Jane Rep")
                log.record("adopt")
            }
        )

        try await SignInFlow.run(label: "Jane's iPhone", deps: deps)

        XCTAssertEqual(
            log.calls,
            ["register", "save", "adopt"],
            "a session may be saved only once registration has succeeded, and adopted only once it is saved"
        )
    }

    func testCancellingTheWebSheetAbortsAnInFlightPollPromptly() async {
        // The poll fake hangs for up to 10 real seconds unless it is actually
        // cancelled — if `run` waited for it instead of racing, this test
        // would take that long (or longer) instead of finishing at once.
        let deps = SignInFlow.Deps(
            startLogin: { self.start },
            openWeb: { _ in throw SignInFlow.SignInFlowError.cancelled },
            pollStatus: { _ in
                try await Self.hangUntilCancelled()
                XCTFail("the poll must be cancelled, not left to run to its own timeout")
                return .unknown
            },
            registerDevice: { _, _ in
                XCTFail("registerDevice must not run after a cancel")
                throw TestError.boom
            },
            saveSession: { _ in XCTFail("nothing must be saved after a cancel") },
            deleteSession: { XCTFail("no session was ever obtained; there is nothing to delete") },
            adoptDevice: { _, _ in XCTFail("adoptDevice must not run after a cancel") }
        )

        let started = Date()
        do {
            try await SignInFlow.run(label: "Jane's iPhone", deps: deps)
            XCTFail("expected .cancelled")
        } catch SignInFlow.SignInFlowError.cancelled {
            // expected
        } catch {
            XCTFail("expected .cancelled, got \(error)")
        }

        XCTAssertLessThan(
            Date().timeIntervalSince(started), 2,
            "a cancel must abort the poll immediately, not wait anywhere near its 10-second fake timeout"
        )
    }

    func testAFailedLoginStatusMapsToLoginFailedWithoutTouchingTheSession() async {
        let deps = SignInFlow.Deps(
            startLogin: { self.start },
            openWeb: { _ in try await Self.hangUntilCancelled() },
            pollStatus: { _ in .failed },
            registerDevice: { _, _ in
                XCTFail("registerDevice must not run when the login itself failed")
                throw TestError.boom
            },
            saveSession: { _ in XCTFail("nothing must be saved when the login failed") },
            deleteSession: { XCTFail("no session was ever obtained; there is nothing to delete") },
            adoptDevice: { _, _ in XCTFail("adoptDevice must not run when the login failed") }
        )

        do {
            try await SignInFlow.run(label: "Jane's iPhone", deps: deps)
            XCTFail("expected .loginFailed")
        } catch SignInFlow.SignInFlowError.loginFailed {
            // expected
        } catch {
            XCTFail("expected .loginFailed, got \(error)")
        }
    }

    func testEverySignInFlowErrorHasTheExactCopyTheFixSpecifies() {
        XCTAssertEqual(SignInFlow.SignInFlowError.cancelled.errorDescription, "Sign-in was cancelled.")
        XCTAssertEqual(SignInFlow.SignInFlowError.loginFailed.errorDescription, "Salesforce didn't complete the sign-in. Try again.")
        XCTAssertEqual(
            SignInFlow.SignInFlowError.registrationFailed("boom").errorDescription,
            "Signed in, but this iPhone couldn't be registered: boom"
        )
        XCTAssertEqual(SignInFlow.SignInFlowError.timedOut.errorDescription, "Sign-in timed out. Try again.")
    }

    // MARK: - Fixtures

    private enum TestError: Error { case boom }

    /// Suspends until cancelled (checking `Task.isCancelled` rather than
    /// relying solely on `Task.sleep`'s own cancellation throw), capped at 10
    /// real seconds so a broken cancel fails the test slowly instead of
    /// hanging the suite forever.
    private static func hangUntilCancelled() async throws {
        for _ in 0..<200 {
            if Task.isCancelled { throw CancellationError() }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}

/// Records the order `SignInFlow.run` calls its collaborators in. A plain
/// class, not an actor: in every test above exactly one side of the
/// `openWeb`/`pollStatus` race ever touches it (the other is the inert
/// `hangUntilCancelled` fake), and everything after the race resolves runs
/// strictly sequentially within `run`'s own task — never two writers at once.
private final class CallLog {
    private(set) var calls: [String] = []
    func record(_ entry: String) { calls.append(entry) }
}
