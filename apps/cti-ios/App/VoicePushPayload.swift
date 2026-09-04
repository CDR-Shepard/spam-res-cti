import Foundation

/// What a VoIP push is, read straight off the payload — before the Twilio SDK
/// has seen it.
///
/// This exists because of one iOS rule with a hard penalty: an app that takes
/// a VoIP push and reports no call to CallKit is terminated, and repeat
/// offenders lose the VoIP push entitlement. `PushRegistry` therefore has to
/// know whether the push it just handed to the SDK was one that *must* end in
/// a CallKit report — a `twilio.voice.call` — or a cancel, for which reporting
/// a new incoming call would invent a phantom ring.
///
/// Keys per Twilio's own documentation of the payload
/// (`TwilioVoice.h`: "The notification type is encoded in the dictionary with
/// the key `twi_message_type` and the value `twilio.voice.call`").
enum VoicePushKind: Equatable {
    /// Someone is calling: a CallKit report is mandatory.
    case callInvite
    /// The caller gave up or was answered elsewhere: end any ringing call.
    case cancel
    /// Not Twilio's, or a message type this build does not know. Left alone.
    case other
}

private enum VoicePushKeys {
    static let messageType = "twi_message_type"
    static let from = "twi_from"
}

func voicePushKind(of payload: [AnyHashable: Any]) -> VoicePushKind {
    // Deliberately not a `default:` on a String — an unrecognized message type
    // is `.other`, so a future Twilio message type cannot be mistaken for a
    // call and made to ring a phone.
    switch payload[VoicePushKeys.messageType] as? String {
    case "twilio.voice.call": return .callInvite
    case "twilio.voice.cancel": return .cancel
    default: return .other
    }
}

/// The caller's number as the raw push carries it, when it carries one. Only
/// used for the fallback CallKit report — the real ring gets its caller
/// identity from the invite's custom parameters via `CallerInfo.from`.
func voicePushCallerNumber(in payload: [AnyHashable: Any]) -> String? {
    guard let from = payload[VoicePushKeys.from] as? String, !from.isEmpty else { return nil }
    return from
}
