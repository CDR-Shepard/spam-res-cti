import Foundation

/// The Sign out button's whole job, pulled out of `StatusView` so its order —
/// and the guarantees that follow from it — can be pinned by a host-free test
/// instead of trusted to a SwiftUI tap handler.
///
/// Three steps, and the order is a contract rather than an accident, because
/// each of the first two needs something the last one destroys:
///
/// 1. `revokeDevice` — `DELETE /mobile/devices/<id>`, authenticated with the
///    **session** token `unpair` is about to delete. Without it every sign-in
///    leaves another live `mobile_devices` row behind (`/mobile/register`
///    inserts a new one each time), each still a valid bearer for the org's
///    caller directory on a handset nobody is signed in to.
/// 2. `stopVoice` — `VoiceRuntime.stop()`, which best-effort unregisters this
///    handset from Twilio via the push registry. It needs the in-memory voice
///    token cache and the live registry, both of which the runtime tears down
///    as part of stopping.
/// 3. `unpair` — what actually signs the phone out. It flips `hasSession`, and
///    the root view swaps to sign-in on the next redraw.
///
/// The first two are **best effort and no other API call in this app is**:
/// these are the only two `try?`s on a network call, and they are deliberate
/// (everything else that swallows an error here is a file handle or a Keychain
/// delete, which cannot meaningfully fail). A rep who taps
/// Sign out and lands on `SignInView` must be signed out on this handset
/// whether or not the server and Twilio could be reached — a phone stuck
/// signed-in because the network was down is the worse failure, and the device
/// row stays revocable from the softphone's own device list either way.
///
/// There is no session-logout call to make alongside the revoke: `revokeSession`
/// exists in `services/cti-api/src/auth/session.ts` but no route reaches it,
/// and this wave does not add server routes. The session token is destroyed
/// locally by `unpair`; it expires server-side on its own 30-day clock.
enum SignOutFlow {
    @MainActor
    static func run(
        revokeDevice: () async throws -> Void,
        stopVoice: () throws -> Void,
        unpair: () -> Void
    ) async {
        try? await revokeDevice()
        try? stopVoice()
        unpair()
    }

    /// The revoke step, built from what this phone actually knows about itself.
    ///
    /// Sends nothing unless it has BOTH halves: a device row id (only a phone
    /// registered through `/mobile/register` has one — a legacy code-paired
    /// phone predates that route) and a session to authenticate with. A
    /// request with a hole in either would just be a 404 or a 401.
    static func deviceRevoker(
        deviceId: String?,
        sessionToken: String?,
        revoke: @escaping (_ sessionToken: String, _ deviceId: String) async throws -> Void
    ) -> () async throws -> Void {
        {
            guard let deviceId, let sessionToken else { return }
            try await revoke(sessionToken, deviceId)
        }
    }

    /// The production revoke step: `deviceRevoker` pointed at the real
    /// `DELETE /mobile/devices/:id`.
    @MainActor
    static func liveDeviceRevoker(
        deviceId: String?,
        sessions: SessionTokenStoring = SessionTokenStore(),
        baseURL: URL = AppConfig.baseURL
    ) -> () async throws -> Void {
        deviceRevoker(deviceId: deviceId, sessionToken: sessions.load()) { sessionToken, deviceId in
            try await liveRevokeDevice(baseURL: baseURL, sessionToken: sessionToken, deviceId: deviceId)
        }
    }
}
