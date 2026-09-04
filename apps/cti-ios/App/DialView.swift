import SwiftUI

/// The keypad.
///
/// Two things on this screen are load-bearing and neither is the pad itself.
///
/// The first is the refusal banner. `CallController` never dials without the
/// server's verdict, which means a refused call is a call that visibly did
/// nothing — and the server's sentence is the rep's only explanation. It is
/// printed verbatim (`DialViewModel.banner`), and it is dismissible per-message
/// so that dismissing one refusal cannot hide the next.
///
/// The second is that the typed string is sent as typed. The phone does not
/// normalize, does not add a country code, and does not decide what is
/// dialable: `POST /firewall/precall` normalizes and audits, and the app shows
/// what comes back.
struct DialView: View {
    @EnvironmentObject private var controller: CallController
    @EnvironmentObject private var feed: CallsFeedStore

    @State private var raw = ""
    /// The refusal text the rep already swiped away — see `DialViewModel.banner`.
    @State private var dismissedRefusal: String?

    private static let keys: [(key: String, letters: String)] = [
        ("1", " "), ("2", "ABC"), ("3", "DEF"),
        ("4", "GHI"), ("5", "JKL"), ("6", "MNO"),
        ("7", "PQRS"), ("8", "TUV"), ("9", "WXYZ"),
        ("*", " "), ("0", "+"), ("#", " "),
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                banners
                Spacer(minLength: 0)
                numberDisplay
                keypad
                callDock
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 8)
            .navigationTitle("Callsign")
            .navigationBarTitleDisplayMode(.inline)
            .task { await feed.loadPending() }
            // A dismissal is scoped to the call it was made about. Without
            // this, a redial from Recents that comes back with the *same*
            // refusal would be silently swallowed by the stale dismissal, and
            // the rep would tap a row and watch nothing happen.
            .onChange(of: controller.phase) { _, phase in
                dismissedRefusal = DialViewModel.dismissal(dismissedRefusal, survives: phase)
            }
        }
    }

    // MARK: - Banners

    @ViewBuilder
    private var banners: some View {
        if let banner = DialViewModel.banner(for: controller.lastRefusal, dismissed: dismissedRefusal) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: banner.style == .server ? "exclamationmark.octagon.fill" : "info.circle.fill")
                Text(banner.text)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    dismissedRefusal = banner.text
                } label: {
                    Image(systemName: "xmark").font(.footnote.weight(.semibold))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
            .foregroundStyle(banner.style == .server ? Color.red : Color.secondary)
            .padding(12)
            .background(
                (banner.style == .server ? Color.red : Color.secondary).opacity(0.10),
                in: RoundedRectangle(cornerRadius: 12)
            )
        }

        if let pending = DialViewModel.pendingBanner(for: feed.pending) {
            Label(pending, systemImage: "clock.badge.exclamationmark")
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        }

        // A pending-disposition lookup that failed is worth one quiet line: it
        // is why the banner above is missing, and the rep's next dial may be
        // refused because of a call this screen could not see.
        if let error = feed.pendingError {
            Text(error).font(.caption2).foregroundStyle(.secondary)
        }
    }

    // MARK: - Number

    /// Editable, so a number copied out of an email or a CRM tab can be pasted
    /// rather than re-keyed a digit at a time — the commonest way a rep on a
    /// phone actually gets a number. Whatever arrives is sanitized by
    /// `DialViewModel.accept` and shown back through the same formatter the
    /// pad's own typing goes through, so the two are indistinguishable and the
    /// pad keeps appending to a pasted number.
    private var numberDisplay: some View {
        TextField(
            DialViewModel.placeholder,
            text: Binding(
                get: { DialViewModel.formatDialString(raw) },
                set: { raw = DialViewModel.accept($0) }
            )
        )
        .keyboardType(.phonePad)
        .textContentType(.telephoneNumber)
        .autocorrectionDisabled()
        .multilineTextAlignment(.center)
        .font(.system(size: 36, weight: .regular, design: .rounded))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .frame(height: 52)
        .accessibilityLabel("Number")
    }

    // MARK: - Keypad

    private var keypad: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 20), count: 3), spacing: 14) {
            ForEach(Self.keys, id: \.key) { entry in
                Button {
                    raw = DialViewModel.append(entry.key, to: raw)
                } label: {
                    VStack(spacing: 1) {
                        Text(entry.key).font(.system(size: 30, weight: .regular, design: .rounded))
                        Text(entry.letters)
                            .font(.system(size: 10, weight: .semibold))
                            .kerning(1.5)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 62)
                    .background(Color.secondary.opacity(0.12), in: Circle())
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                // Long-pressing 0 for "+" is the standard phone gesture, and
                // the only way to type an international prefix on this pad.
                .onLongPressGesture {
                    if entry.key == "0" { raw = DialViewModel.append("+", to: raw) }
                }
            }
        }
    }

    // MARK: - Call

    private var callDock: some View {
        HStack {
            Spacer().frame(maxWidth: .infinity)

            Button {
                dismissedRefusal = nil
                let number = raw
                Task { await controller.placeCall(to: number) }
            } label: {
                Image(systemName: "phone.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.white)
                    .frame(width: 68, height: 68)
                    .background(canDial ? Color.green : Color.green.opacity(0.35), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canDial)
            .accessibilityLabel("Call")

            Group {
                if raw.isEmpty {
                    Color.clear
                } else {
                    Button {
                        raw = DialViewModel.backspace(raw)
                    } label: {
                        Image(systemName: "delete.left").font(.title2).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Backspace")
                    .onLongPressGesture { raw = "" }
                }
            }
            .frame(maxWidth: .infinity)
        }
        .frame(height: 78)
    }

    private var canDial: Bool {
        DialViewModel.canDial(phase: controller.phase, raw: raw)
    }
}
