import AVFAudio
import SwiftUI
import UIKit

/// The live call.
///
/// Shown for `.dialing` as well as `.active` (see `CallRoute`), which is why
/// `since` is optional: before the callee picks up there is no elapsed time to
/// run, only "Calling…". Everything on screen comes from the phase's own
/// `CallerInfo` and from the controller — in particular the "from" line is
/// `controller.fromNumber`, the DID the *server* pinned and dialed. The app
/// never picks a caller id, so it can only ever report one.
struct InCallView: View {
    @EnvironmentObject private var controller: CallController
    let info: CallerInfo
    let since: Date?

    @State private var speakerOn = false
    @State private var showKeypad = false
    /// A failed audio-route change is shown rather than swallowed: a Speaker
    /// button that silently does nothing is indistinguishable from a dead
    /// handset.
    @State private var audioError: String?

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            header
            Spacer()
            if let audioError {
                Text(audioError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.bottom, 12)
            }
            controls
            hangUp
            Spacer(minLength: 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
        // An overlay rather than a `.sheet`. A sheet here would be a
        // presentation nested inside the call cover, and an IVR that hangs up
        // while it is open would tear down its owner in the same update the
        // cover's content swaps to the wrap-up — the exact nested-dismissal
        // race the single-cover design exists to avoid. An overlay simply
        // disappears with the view that owns it.
        .overlay(alignment: .bottom) {
            if showKeypad {
                InCallKeypad(send: { controller.sendDigits($0) }, onDone: { showKeypad = false })
                    .transition(.move(edge: .bottom))
            }
        }
        .animation(.snappy, value: showKeypad)
        // Belt and braces: the pad has no meaning once this call is over, and
        // `sendDigits` drops anything that is not `.active` anyway.
        .onChange(of: since) { _, _ in showKeypad = false }
    }

    // MARK: - Who / how long

    private var header: some View {
        VStack(spacing: 8) {
            Text(info.displayTitle)
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            if let subtitle = info.displaySubtitle {
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }

            Group {
                if let since {
                    // `Text(_:style:)` ticks on its own — no timer, no state.
                    Text(since, style: .timer)
                } else {
                    Text("Calling…")
                }
            }
            .font(.title3.monospacedDigit())
            .foregroundStyle(.secondary)

            if let fromNumber = controller.fromNumber {
                Text("From \(formatNANP(fromNumber))")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }

            if let recordId = info.recordId, let url = salesforceRecordURL(recordId) {
                Button {
                    UIApplication.shared.open(url)
                } label: {
                    Label("Open in Salesforce", systemImage: "arrow.up.forward.app")
                        .font(.footnote.weight(.medium))
                }
                .buttonStyle(.bordered)
                .padding(.top, 8)
            }
        }
        .padding(.horizontal, 24)
    }

    // MARK: - Controls

    private var controls: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 24), count: 3), spacing: 24) {
            CallControlButton(
                title: "Mute", symbol: controller.isMuted ? "mic.slash.fill" : "mic.fill", isOn: controller.isMuted
            ) {
                controller.setMuted(!controller.isMuted)
            }

            CallControlButton(title: "Keypad", symbol: "circle.grid.3x3.fill", isOn: false) {
                showKeypad = true
            }

            CallControlButton(
                title: "Speaker", symbol: speakerOn ? "speaker.wave.3.fill" : "speaker.fill", isOn: speakerOn
            ) {
                setSpeaker(!speakerOn)
            }
        }
        .padding(.horizontal, 48)
        .padding(.bottom, 36)
    }

    private var hangUp: some View {
        Button {
            controller.hangUp()
        } label: {
            Image(systemName: "phone.down.fill")
                .font(.system(size: 28))
                .foregroundStyle(.white)
                .frame(width: 72, height: 72)
                .background(Color.red, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Hang up")
    }

    /// CallKit owns the audio session for the call; this only overrides which
    /// port it comes out of. A throw here means the route did not change, so
    /// the toggle must not flip to match a state the hardware is not in.
    private func setSpeaker(_ on: Bool) {
        do {
            try AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
            speakerOn = on
            audioError = nil
        } catch {
            audioError = error.localizedDescription
        }
    }
}

private struct CallControlButton: View {
    let title: String
    let symbol: String
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 24))
                    .foregroundStyle(isOn ? Color(uiColor: .systemBackground) : Color.primary)
                    .frame(width: 68, height: 68)
                    .background(isOn ? AnyShapeStyle(Color.primary) : AnyShapeStyle(.thinMaterial), in: Circle())
                Text(title).font(.caption).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}

/// The in-call pad. Tones go straight down the live leg via
/// `CallController.sendDigits` (which drops them unless the call is `.active`,
/// since there is nothing to tone into otherwise); the string above is only a
/// record of what the rep pressed.
private struct InCallKeypad: View {
    let send: (String) -> Void
    let onDone: () -> Void
    @State private var entered = ""

    private static let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]

    var body: some View {
        VStack(spacing: 16) {
            Text(entered.isEmpty ? " " : entered)
                .font(.system(size: 28, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .padding(.top, 24)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 20), count: 3), spacing: 14) {
                ForEach(Self.keys, id: \.self) { key in
                    Button {
                        entered = DialViewModel.append(key, to: entered)
                        send(key)
                    } label: {
                        Text(key)
                            .font(.system(size: 28, design: .rounded))
                            .frame(maxWidth: .infinity, minHeight: 60)
                            .background(Color.secondary.opacity(0.12), in: Circle())
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 32)

            Button("Done", action: onDone).padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .shadow(radius: 12, y: -2)
    }
}
