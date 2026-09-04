import SwiftUI
import UIKit

/// The rep's last 50 calls.
///
/// Redial is the reason this list is tappable, and the reason `RecentsRowModel`
/// exists: a row's number is the *other party*, which on an inbound row is
/// `fromNumber`, not the DID the call arrived on. Tapping never dials
/// directly — it hands the number back to `CallController.placeCall`, which
/// runs the same server audit as any other dial.
struct RecentsView: View {
    @EnvironmentObject private var feed: CallsFeedStore
    let onRedial: (String, String?) -> Void

    var body: some View {
        NavigationStack {
            List {
                if let error = feed.recentsError {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }

                if feed.recents.isEmpty, feed.recentsError == nil, !feed.isLoadingRecents {
                    Section {
                        Text("No calls yet").foregroundStyle(.secondary)
                    }
                }

                ForEach(feed.recents) { row in
                    RecentsRow(row: row, onRedial: onRedial)
                }
            }
            .listStyle(.plain)
            .navigationTitle("Recents")
            .overlay {
                if feed.isLoadingRecents, feed.recents.isEmpty { ProgressView() }
            }
            .refreshable { await feed.loadRecents() }
            .task { await feed.loadRecents() }
        }
    }
}

private struct RecentsRow: View {
    let row: RecentsRowModel
    let onRedial: (String, String?) -> Void

    var body: some View {
        // Deliberately not a `Button` wrapping the row: the "Open in
        // Salesforce" control is a button of its own, and nesting one button
        // inside another makes which of the two a tap reaches a matter of
        // SwiftUI's mood. A plain row plus `onTapGesture` leaves the inner
        // button owning its own hit area and everything else redialling.
        HStack(spacing: 12) {
            Image(systemName: row.glyph)
                .font(.footnote)
                .foregroundStyle(row.needsDisposition ? Color.orange : Color.secondary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).font(.body)
                Text(metaLine).font(.caption).foregroundStyle(.secondary)
            }
            // Combined so VoiceOver reads "(619) 848-1782, 2 hours ago ·
            // Connected" as one element rather than two, and reads it as a
            // button when there is something to call back. Scoped to the text
            // on purpose: combining the whole row would swallow the Salesforce
            // button beside it.
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(row.redialTarget == nil ? [] : .isButton)

            Spacer(minLength: 8)

            if let duration = row.duration {
                Text(duration).font(.caption).monospacedDigit().foregroundStyle(.tertiary)
            }

            if let recordId = row.recordId, let url = salesforceRecordURL(recordId) {
                Button {
                    UIApplication.shared.open(url)
                } label: {
                    Image(systemName: "arrow.up.forward.app")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Open in Salesforce")
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: redial)
    }

    /// A row with nothing to dial (an inbound call from a withheld number) is
    /// simply inert — the DID the call arrived on is never a fallback.
    private func redial() {
        guard let target = row.redialTarget else { return }
        onRedial(target, row.recordId)
    }

    /// "2 hours ago · Left voicemail" — and just the disposition when the
    /// timestamp could not be parsed, rather than a made-up time.
    private var metaLine: String {
        let relative = RecentsRowModel.relativeText(row.date, now: Date())
        return [relative, row.disposition].compactMap { $0 }.joined(separator: " · ")
    }
}
