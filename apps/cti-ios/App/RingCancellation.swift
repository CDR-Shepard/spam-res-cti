import Foundation

/// Whether a cancelled invite should stop the phone ringing.
///
/// The obvious route — a `twilio.voice.cancel` VoIP push — does not work in
/// the SDK this app ships. `TwilioVoice.h` lists the Insights event
/// `unsupported-cancel-message-error`: "Reported when a 'cancel' push
/// notification is processed by the SDK. This version of the SDK does not
/// support 'cancel' push notifications". The live signal is instead the SDK's
/// own out-of-band `cancelledCallInviteReceived:error:`, which requires that
/// "the TVOCallInvite must be retained until the call is accepted or rejected"
/// (same header) — hence `LiveVoiceSDK.outstandingInvites`.
///
/// That callback carries a UUID and nothing else, and `CallController` keeps
/// its own invite private, so the match has to be made out here. Two things
/// must both hold, and the asymmetry between the two failure modes is the
/// whole design: declining the wrong call drops a live conversation, while
/// missing a cancellation costs a ring that stops by itself.
///
/// - `controllerIsRinging`: the rep has not answered. A cancellation that
///   arrives after they picked up is just a race, and must not tear down the
///   call they are on.
/// - exactly one outstanding invite, and this is it. A second invite is
///   rejected synchronously by `CallController` (one call at a time), so two
///   outstanding at once is a moment, not a state — and in that moment there
///   is no way to tell which one the phone is ringing for.
func shouldDeclineCancelledInvite(
    _ cancelled: UUID,
    outstanding: Set<UUID>,
    controllerIsRinging: Bool
) -> Bool {
    guard controllerIsRinging else { return false }
    return outstanding == [cancelled]
}
