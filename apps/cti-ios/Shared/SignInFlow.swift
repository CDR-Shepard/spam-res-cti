import Foundation

/// The sign-in path's orchestration, pulled out of `SignInView` so the order
/// of operations — and, above all, the rule that a session is never persisted
/// before this phone is actually registered — is something a test can pin
/// down without a browser, a network, or the Keychain.
///
/// Every side effect is a closure on `Deps`, so the live implementation
/// (built in `SignInView`) and a test's fakes share exactly one code path:
/// `run(label:deps:)`.
enum SignInFlow {
    struct Deps {
        /// POST auth/salesforce/login/start.
        var startLogin: () async throws -> LoginStart
        /// Presents the Salesforce login page and suspends until it closes.
        /// Throws `SignInFlowError.cancelled` if the person dismisses it,
        /// something else for any other web-auth failure. Runs concurrently
        /// with `pollStatus`; whichever finishes first decides the outcome,
        /// and the loser is cancelled — a `openWeb` that never returns on its
        /// own MUST still return promptly once its `Task` is cancelled, or a
        /// poll that already succeeded (or a cancel that already fired) would
        /// hang waiting for it.
        var openWeb: (URL) async throws -> Void
        /// Polls login/status from `handshake` to a terminal status. Expected
        /// to wrap `SignInPoller`, which already loops until `.failed`,
        /// `.done`, `.connected`, or its own timeout — so this is a single
        /// call from `run`'s point of view.
        var pollStatus: (_ handshake: String) async throws -> LoginStatus
        /// Registers this phone with the freshly-obtained session token.
        var registerDevice: (_ sessionToken: String, _ label: String) async throws -> DeviceRegistration
        /// Persists the session token. Called ONLY after `registerDevice`
        /// succeeds — a session this phone cannot use must never be saved.
        var saveSession: (String) throws -> Void
        /// Clears any session token. Called on every failure path once a
        /// session was obtained from Salesforce, even though nothing may have
        /// been saved yet — harmless if there is nothing to delete.
        var deleteSession: () throws -> Void
        /// Hands the registration — the minted device token AND the id of the
        /// `mobile_devices` row it belongs to — to `SyncEngine`. The id is
        /// what lets a later sign-out revoke this row rather than leave it
        /// live.
        var adoptDevice: (_ registration: DeviceRegistration, _ displayName: String?) throws -> Void
    }

    enum SignInFlowError: Error, Equatable {
        case cancelled
        case loginFailed
        case registrationFailed(String)
        case timedOut
    }

    static func run(label: String, deps: Deps) async throws {
        let start = try await deps.startLogin()

        let status: LoginStatus
        do {
            status = try await race(authUrl: start.authUrl, handshake: start.handshake, deps: deps)
        } catch let error as SignInFlowError {
            throw error
        } catch SessionClientError.timedOut {
            throw SignInFlowError.timedOut
        } catch {
            throw SignInFlowError.loginFailed
        }

        switch status {
        case let .connected(sessionToken, _, displayName):
            do {
                let registration = try await deps.registerDevice(sessionToken, label)
                // Only now — after the server has confirmed this specific
                // phone is allowed to use this session — is anything written
                // to the Keychain.
                try deps.saveSession(sessionToken)
                try deps.adoptDevice(registration, displayName)
            } catch {
                // A session this phone could not register with must not be
                // left behind, whether or not `saveSession` ever ran.
                try? deps.deleteSession()
                throw SignInFlowError.registrationFailed(describe(error))
            }
        case .failed, .unknown, .done, .pending:
            throw SignInFlowError.loginFailed
        }
    }

    /// Runs `openWeb` and `pollStatus` concurrently; the first to finish wins.
    ///
    /// Leaving a task-group scope only guarantees that every child task is
    /// AWAITED before the group returns — it does NOT, on its own, cancel a
    /// child that is still running just because a sibling already answered.
    /// (A child that throws its way out IS enough to cancel its siblings;
    /// only the plain "we got our answer" exit needs the explicit call
    /// below.) Skipping `cancelAll()` here would leave the loser running to
    /// its own conclusion — for `pollStatus` that means however long
    /// `SignInPoller` takes to reach its own timeout — before `race` could
    /// ever return, defeating the entire point of racing them.
    private static func race(authUrl: URL, handshake: String, deps: Deps) async throws -> LoginStatus {
        try await withThrowingTaskGroup(of: LoginStatus?.self) { group in
            group.addTask {
                try await deps.openWeb(authUrl)
                // The web sheet closed on its own without the poller having
                // reported anything yet — there is no status to act on.
                return nil
            }
            group.addTask {
                try await deps.pollStatus(handshake)
            }

            do {
                let first = try await group.next()
                group.cancelAll()
                guard let first, let status = first else {
                    throw SignInFlowError.loginFailed
                }
                return status
            } catch {
                group.cancelAll()
                throw error
            }
        }
    }

    private static func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
}

extension SignInFlow.SignInFlowError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .cancelled: return "Sign-in was cancelled."
        case .loginFailed: return "Salesforce didn't complete the sign-in. Try again."
        case let .registrationFailed(message): return "Signed in, but this iPhone couldn't be registered: \(message)"
        case .timedOut: return "Sign-in timed out. Try again."
        }
    }
}
