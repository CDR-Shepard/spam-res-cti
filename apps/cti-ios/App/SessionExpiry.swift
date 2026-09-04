import Foundation

// -----------------------------------------------------------------------------
// The 30-day cliff.
//
// A Salesforce session token expires after 30 days
// (`services/cti-api/src/auth/session.ts`); the paired *device* token never
// does. So a phone whose session has run out keeps syncing the caller
// directory, keeps saying "Signed in" on the Status tab, and cannot place,
// answer, log, or list a single call — every session-authenticated route
// answers 401, and the rep reads whatever generic sentence that 401 happened
// to become.
//
// The recovery is deliberately blunt: one 401 from a session-authenticated
// call signs the phone out for real (revoke, stop, unpair) and drops it on
// `SignInView` with a line saying why. Signing in again is the only fix, so
// getting there in one step beats any amount of retrying.
// -----------------------------------------------------------------------------

/// Whether `error` means **the Salesforce session is gone**, as opposed to any
/// of the other things a server can say no to.
///
/// Two error types can carry it, because two clients decode 401 differently:
/// every `Shared/` request path produces `SessionClientError.server`, and the
/// disposition POST has `DispositionFailed` (its message is what a rep reads
/// on the wrap-up screen, so it could not reuse the sign-in wording).
///
/// What is deliberately **not** here is a 401 on a DEVICE-token call — the
/// caller-directory feed's `FeedError.http(status: 401)`, or a refused
/// `/mobile/voip-token`. That 401 means an admin revoked this handset from the
/// device list, which `SyncEngine` already handles with its own unpair and its
/// own message. Treating the two as one event would tell a rep whose phone was
/// revoked that their sign-in expired, and run two sign-outs over each other.
func isSessionExpired(_ error: Error) -> Bool {
    if case .server(status: 401) = error as? SessionClientError { return true }
    if let failed = error as? DispositionFailed, failed.status == 401 { return true }
    return false
}

/// Fires the sign-out **once**, however many calls report the expiry.
///
/// An expiry never arrives alone: a dial, the recents load, the pending
/// lookup and the voice-token mint can all be in flight together and all come
/// back 401 within a few milliseconds of each other. Each of those would
/// otherwise run a whole sign-out — a server revoke, a Twilio unregister, a
/// Keychain wipe — against a phone already halfway through one, and the rep
/// would watch the sign-in screen flicker.
///
/// Scoped to one signed-in session by construction: `VoiceRuntime` builds a
/// fresh latch every time it starts, so the next sign-in starts unfired.
@MainActor
final class SessionExpiryLatch {
    private let onExpired: () -> Void
    private(set) var hasFired = false

    init(onExpired: @escaping () -> Void) {
        self.onExpired = onExpired
    }

    func fire() {
        guard !hasFired else { return }
        hasFired = true
        onExpired()
    }
}

/// Wraps a voice-token mint so an expired session is reported before the
/// failure is rethrown.
///
/// `POST /telephony/token` is session-authenticated like everything else, and
/// on a phone nobody is dialling from it is usually the *first* call to notice
/// the session has gone — the refresher mints at launch and on every
/// foreground. The error still propagates: the caller logs it, and a mint that
/// failed must not look like one that worked.
func sessionExpiryWatching(
    _ fetch: @escaping VoiceTokenRefresher.Fetch,
    onSessionExpired: @escaping @MainActor () -> Void
) -> VoiceTokenRefresher.Fetch {
    {
        do {
            return try await fetch()
        } catch {
            if isSessionExpired(error) { await onSessionExpired() }
            throw error
        }
    }
}
