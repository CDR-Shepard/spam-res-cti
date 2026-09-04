import AVFoundation
import CallKit
import Foundation
import TwilioVoice
import os

/// CallKit, wired both ways.
///
/// Outward (`CallSystem`) it is what `CallController` calls to put a call on
/// the system's call screen. Inward (`CXProviderDelegate`) it is what the
/// system calls when the rep presses answer, end, or mute — on the lock
/// screen, on a car stereo, on a watch — and those all route back into the
/// same controller, so there is exactly one state machine no matter where the
/// tap came from.
///
/// The controller reference is **weak**: the controller does not own this
/// object and this object must not keep it alive, or every call the app ever
/// makes would leak a controller behind CallKit's provider.
final class LiveCallSystem: NSObject, CallSystem {
    /// Set by whoever builds the pair, immediately after construction — the
    /// controller needs the system at `init`, so the link can only be made in
    /// this direction afterwards.
    weak var controller: CallController?

    private let provider: CXProvider
    private let calls = CXCallController()

    /// Keeps the outgoing start/connected reports in the order CallKit needs,
    /// however out of order Twilio delivers them. See `OutgoingCallLedger`.
    private var ledger = OutgoingCallLedger()
    private let ledgerLock = NSLock()
    private let log = os.Logger(subsystem: AppConfig.loggingSubsystem, category: "CallKit")

    /// Twilio's own audio device — **the same instance the SDK uses**, since
    /// toggling any other one would do nothing.
    ///
    /// It ships enabled: `TVODefaultAudioDevice.h` on `enabled` — "By default,
    /// the SDK initializes this property to YES" — and, on the configuration
    /// block, "If `TVODefaultAudioDevice` is `enabled`, the SDK executes this
    /// block and activates the audio session while connecting to a Call". That
    /// is Twilio activating the `AVAudioSession` ahead of CallKit, which is
    /// CallKit's job and nobody else's: it is what decides when a call may be
    /// heard, and it does it around the system's own ringtone, other calls,
    /// and interruptions. So the device is switched off before anything can
    /// connect and driven purely from `didActivate`/`didDeactivate`.
    private let audioDevice: DefaultAudioDevice

    override init() {
        // Adopt the SDK's device if it still has the default one, otherwise
        // install ours — either way `TwilioVoiceSDK.audioDevice` and
        // `self.audioDevice` are the same object from here on, and this runs
        // at sign-in, before any connect or accept is possible.
        if let existing = TwilioVoiceSDK.audioDevice as? DefaultAudioDevice {
            audioDevice = existing
        } else {
            let device = DefaultAudioDevice()
            TwilioVoiceSDK.audioDevice = device
            audioDevice = device
        }
        audioDevice.isEnabled = false

        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallsPerCallGroup = 1
        // One call at a time, matching `CallController`: a second invite is
        // rejected rather than queued, so there is never a group to manage.
        configuration.maximumCallGroups = 1
        configuration.supportedHandleTypes = [.phoneNumber]
        provider = CXProvider(configuration: configuration)
        super.init()
        // `nil` queue: delegate callbacks arrive on the main queue, which is
        // where `CallController` lives.
        provider.setDelegate(self, queue: nil)
    }

    // MARK: - CallSystem

    /// Synchronous, on the caller's stack, because PushKit's deadline is
    /// measured in that stack frame — see `CallSystem.reportIncoming`.
    func reportIncoming(uuid: UUID, title: String, handle: String, completion: @escaping (Error?) -> Void) {
        let update = CXCallUpdate()
        update.localizedCallerName = title
        update.remoteHandle = CXHandle(type: .phoneNumber, value: handle)
        update.hasVideo = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsHolding = false
        // The in-call keypad: `ActiveCall.sendDigits` is what carries them.
        update.supportsDTMF = true
        provider.reportNewIncomingCall(with: uuid, update: update, completion: completion)
    }

    /// The leg is live and the callee's phone is ringing (the server dials
    /// with `answerOnBridge: true`, so `sdk.connect` returns at ringback). The
    /// start action is a formality — the firewall audit and `POST /calls` both
    /// passed long before this — but it is what puts the call on the system
    /// call screen and gives the lock screen an end button during ringback.
    ///
    /// `startedConnectingAt`, not `connectedAt`: the callee has not answered
    /// yet, and claiming otherwise would start CallKit's call timer (and the
    /// Recents duration) on the ringing. `reportOutgoingConnected` closes that
    /// out when they actually pick up.
    func reportOutgoingStarted(uuid: UUID, handle: String) {
        withLedger { $0.startRequested(uuid) }
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .phoneNumber, value: handle))
        calls.request(CXTransaction(action: action)) { [weak self] error in
            guard let self else { return }
            if let error {
                // Not fatal to the call: the media is up either way. It costs
                // the system call screen (and with it the lock-screen end
                // button), which is worth a log line.
                log.error("CallKit refused the outgoing call: \(error.localizedDescription, privacy: .public)")
                // And it costs the audio, because a refused start action means
                // no `didActivate` is coming — the one path where the app has
                // to turn the audio on itself, or the rep sits on a connected
                // call that is silent in both directions forever.
                audioDevice.isEnabled = true
                withLedger { $0.startFailed(uuid) }
                return
            }
            provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
            // CallKit only knows the call from this line onwards, so an answer
            // that arrived while the transaction was in flight has been held
            // rather than dropped. This is the first moment it can be told.
            if let connectedAt = withLedger({ $0.startSucceeded(uuid) }) {
                provider.reportOutgoingCall(with: uuid, connectedAt: connectedAt)
            }
        }
    }

    /// The callee picked up. Starts CallKit's call timer, and is what makes
    /// the Recents entry show the conversation's length rather than the
    /// conversation plus however long it rang.
    ///
    /// Held rather than reported when CallKit has not seen the call yet — an
    /// IVR or voicemail answers on the first ring, well inside the start
    /// transaction's round trip, and a connect reported too early is silently
    /// discarded (leaving the system screen on "connecting…" for the whole
    /// call). `OutgoingCallLedger` owns that decision.
    func reportOutgoingConnected(uuid: UUID) {
        guard let connectedAt = withLedger({ $0.connected(uuid, at: Date()) }) else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: connectedAt)
    }

    /// The ledger is touched from the main actor (`onOutboundCallConnected`)
    /// and from `CXCallController`'s completion queue, so every access goes
    /// through here.
    private func withLedger<T>(_ body: (inout OutgoingCallLedger) -> T) -> T {
        ledgerLock.withLock { body(&ledger) }
    }

    /// Sign-out. `CXProvider` holds its delegate — and therefore this object,
    /// and therefore the provider — so dropping the last reference is not
    /// enough to let it go; `invalidate()` is what ends any call still up and
    /// breaks that ring.
    func shutDown() {
        controller = nil
        audioDevice.isEnabled = false
        provider.invalidate()
    }

    func reportEnded(uuid: UUID) {
        withLedger { $0.ended(uuid) }
        // `.remoteEnded` covers every way the controller gets here: the far
        // end hung up, the media died, or the rep ended it in the app. When
        // the end came from CallKit's own button the action has already
        // fulfilled and this is a harmless no-op.
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
    }
}

// MARK: - CXProviderDelegate

extension LiveCallSystem: CXProviderDelegate {
    /// The system tore everything down (a crash of the call service, the user
    /// resetting call state). Every call is gone whether the app agrees or
    /// not, so the controller is brought in line rather than left holding a
    /// call CallKit no longer knows about.
    func providerDidReset(_ provider: CXProvider) {
        audioDevice.isEnabled = false
        onMainActor { [weak self] in self?.controller?.hangUp() }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        onMainActor { [weak self] in
            self?.controller?.answer()
            action.fulfill()
        }
    }

    /// One button, two meanings. A ringing call has no media to hang up, only
    /// an invite to refuse; an active one is the other way round. Both are
    /// safe either way — the controller routes a `hangUp()` on a ringing call
    /// to `decline()` itself — so this picks the honest one and relies on that
    /// as a backstop, not as the mechanism.
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        onMainActor { [weak self] in
            if let controller = self?.controller {
                if case .ringing = controller.phase {
                    controller.decline()
                } else {
                    controller.hangUp()
                }
            }
            action.fulfill()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        onMainActor { [weak self] in
            self?.controller?.setMuted(action.isMuted)
            action.fulfill()
        }
    }

    /// Nothing to do: `CallController.dial` only reaches
    /// `reportOutgoingStarted` after Twilio has connected, so by the time this
    /// arrives the call it describes is already up.
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        audioDevice.isEnabled = true
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        audioDevice.isEnabled = false
    }
}
