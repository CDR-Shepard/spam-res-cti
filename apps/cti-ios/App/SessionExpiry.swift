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
// The recovery used to be blunt: the FIRST 401 from a session-authenticated
// call signed the phone out for real (revoke, stop, unpair) and dropped it on
// `SignInView`. That is right for a genuine expiry and wrong for a spurious
// one — a brief auth-service blip, a single unlucky request — which would
// sign out every phone in the fleet at once, each needing a manual Salesforce
// sign-in to recover.
//
// So the gate confirms before it acts: on the first qualifying 401 it sends
// ONE cheap session-authenticated GET of its own (`confirmSessionExpired`),
// and only signs the phone out if THAT also comes back 401. A 200, any other
// status, or a thrown transport error all mean "don't know" — and the safe
// default when in doubt is not to sign the rep out; the original error still
// surfaces through its own path exactly as before.
//
// Be honest about the size of that guarantee: the confirmation goes out
// milliseconds later, over the same edge, to a route that can 401 for the same
// reason, with the same token and no backoff. So this catches a MOMENTARY
// fault, not a sustained one — a persistent misconfiguration returning 401 to
// everything will still sign the fleet out. Widening that (a longer delay,
// several probes) would trade away the thing that makes the sign-out useful:
// getting a rep whose session really has expired back to the sign-in screen
// promptly instead of leaving them on a phone that silently cannot call.
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

/// Confirms a suspected expiry before it signs the phone out — see the file
/// header for why acting on the very first 401 is not safe.
///
/// An expiry never arrives alone: a dial, the recents load, the pending
/// lookup and the voice-token mint can all be in flight together and all come
/// back 401 within a few milliseconds of each other. `fire()` treats all of
/// those as ONE suspected expiry — a confirmation already in flight makes
/// every later `fire()` (while it is pending) a no-op, so at most one
/// confirmation call is ever sent for it, and at most one sign-out ever runs.
///
/// A rejected confirmation resets `isConfirming` but leaves `hasFired` false,
/// so a later, genuine expiry is still caught. A confirmed one leaves
/// `hasFired` true forever — the old latch's guarantee, preserved.
///
/// Scoped to one signed-in session by construction: `VoiceRuntime` builds a
/// fresh gate every time it starts, so the next sign-in starts unconfirmed
/// and unfired.
@MainActor
final class SessionExpiryGate {
    /// Returns true only when the session is confirmed gone (the
    /// confirmation GET itself came back 401). Never throws: a thrown
    /// transport error is exactly as inconclusive as any other non-401, and
    /// `confirmSessionExpired` maps both to `false` before this ever sees it.
    private let confirm: () async -> Bool
    private let onExpired: () -> Void
    private(set) var hasFired = false
    private(set) var isConfirming = false

    /// The one confirmation currently running, if any — `nil` once it has
    /// resolved. Exists only so `waitUntilSettledForTest()` has something to
    /// await; no production code reads it.
    private var inFlight: Task<Void, Never>?

    init(confirm: @escaping () async -> Bool, onExpired: @escaping () -> Void) {
        self.confirm = confirm
        self.onExpired = onExpired
    }

    /// No-op if already fired or a confirmation is already in flight.
    /// Otherwise starts the ONE confirmation call and signs out only if it
    /// also comes back 401. Synchronous by contract — every call site fires
    /// it from a `@MainActor` context and never awaits it.
    func fire() {
        guard !hasFired, !isConfirming else { return }
        isConfirming = true
        inFlight = Task { [weak self] in
            guard let self else { return }
            let confirmed = await self.confirm()
            self.resolve(confirmed: confirmed)
        }
    }

    private func resolve(confirmed: Bool) {
        isConfirming = false
        inFlight = nil
        guard confirmed, !hasFired else { return }
        hasFired = true
        onExpired()
    }

    #if DEBUG
    /// Awaits the in-flight confirmation, if any — the deterministic
    /// alternative to a sleep for a test that needs to observe the gate
    /// after `fire()`'s unstructured task has actually finished, rather than
    /// racing its own continuation resumption against `resolve()`.
    func waitUntilSettledForTest() async {
        await inFlight?.value
    }
    #endif
}

/// Builds the ONE cheap call `SessionExpiryGate` sends to confirm a suspected
/// expiry before it signs the phone out, rather than inventing an endpoint:
/// `GET /calls?limit=1`, the lightest session-authenticated read there is.
///
/// Returns `true` only when that GET itself comes back 401 — the same signal
/// `isSessionExpired` reads elsewhere. A 200, any other status, or a thrown
/// transport error (a timeout, no connectivity, DNS) all become `false`: none
/// of them says the session is gone, and the safe default when in doubt is
/// NOT to sign the rep out. Never logs `sessionToken`.
func confirmSessionExpired(
    baseURL: URL,
    sessionToken: String,
    transport: @escaping PairingTransport = livePairingTransport
) -> () async -> Bool {
    {
        do {
            var request = recentCallsRequest(baseURL: baseURL, sessionToken: sessionToken, limit: 1)
            // While this is in flight the gate swallows every further 401, so a
            // stalled connection would delay a genuine sign-out for URLSession's
            // 60s default. Failing fast is safe in the direction that matters:
            // a throw reads as "not confirmed", the gate re-arms, and the next
            // 401 tries again.
            request.timeoutInterval = 10
            let (_, status) = try await transport(request)
            return status == 401
        } catch {
            return false
        }
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
