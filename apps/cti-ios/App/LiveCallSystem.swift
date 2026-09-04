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
    private let log = os.Logger(subsystem: AppConfig.loggingSubsystem, category: "CallKit")

    /// Twilio's own audio device, which owns the `AVAudioSession` while a call
    /// is up. CallKit decides *when* that session is live, so the device stays
    /// disabled until `didActivate` says otherwise.
    private let audioDevice = TwilioVoiceSDK.audioDevice as? DefaultAudioDevice

    override init() {
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
        if audioDevice == nil {
            log.error("Twilio's audio device is not a DefaultAudioDevice; call audio will not follow CallKit")
        }
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

    /// The outbound call is already connected through Twilio by the time this
    /// runs — the server's firewall audit and `POST /calls` both had to pass
    /// first — so the start action is a formality that puts the call on the
    /// system call screen, and the connect timestamp is now.
    func reportOutgoingStarted(uuid: UUID, handle: String) {
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .phoneNumber, value: handle))
        calls.request(CXTransaction(action: action)) { [weak self] error in
            guard let self else { return }
            if let error {
                // Not fatal to the call: the media is up either way. It costs
                // the system call screen (and with it the lock-screen end
                // button), which is worth a log line.
                log.error("CallKit refused the outgoing call: \(error.localizedDescription, privacy: .public)")
                return
            }
            provider.reportOutgoingCall(with: uuid, connectedAt: Date())
        }
    }

    /// Sign-out. `CXProvider` holds its delegate — and therefore this object,
    /// and therefore the provider — so dropping the last reference is not
    /// enough to let it go; `invalidate()` is what ends any call still up and
    /// breaks that ring.
    func shutDown() {
        controller = nil
        audioDevice?.isEnabled = false
        provider.invalidate()
    }

    func reportEnded(uuid: UUID) {
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
        audioDevice?.isEnabled = false
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
        audioDevice?.isEnabled = true
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        audioDevice?.isEnabled = false
    }
}

/// Runs `body` on the main actor, without a hop when it is already there.
///
/// The provider's delegate queue is `nil`, i.e. the main queue, so this is
/// normally a straight call — which matters, because a CallKit action must be
/// fulfilled promptly and a deferred `Task` would fulfil it a turn later. The
/// async branch is the safety net for a callback that arrives elsewhere.
private func onMainActor(_ body: @escaping @MainActor () -> Void) {
    if Thread.isMainThread {
        MainActor.assumeIsolated { body() }
    } else {
        Task { @MainActor in body() }
    }
}
