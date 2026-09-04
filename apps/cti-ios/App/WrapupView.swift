import SwiftUI

/// The disposition the call is closed out with.
///
/// This screen is not optional politeness: the server gates a rep's *next* dial
/// on the previous call having a disposition, so a wrap-up that is quietly lost
/// resurfaces minutes later as a refusal on an unrelated number. Two
/// consequences shape the screen — a failed save keeps the screen open with the
/// rep's notes intact (rather than dismissing and discarding them), and there
/// is always a Skip, because a rep stuck behind a broken save is worse than a
/// call the server auto-dispositions.
///
/// `Dispositions.all` is the web app's list, verbatim; see that file.
struct WrapupView: View {
    @EnvironmentObject private var controller: CallController
    let callId: String?
    let info: CallerInfo
    /// Raises a toast on the surfaces that outlive this screen. Used for the
    /// one outcome that has something to say on the way out: a save superseded
    /// by the next call, where this view is already being replaced.
    let onToast: (String) -> Void

    @State private var disposition: String?
    @State private var notes = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(info.displayTitle).font(.headline)
                        if let subtitle = info.displaySubtitle {
                            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }

                Section("Disposition") {
                    ForEach(Dispositions.all, id: \.self) { option in
                        Button {
                            disposition = option
                        } label: {
                            HStack {
                                Text(option).foregroundStyle(.primary)
                                Spacer()
                                if disposition == option {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }

                Section("Notes") {
                    TextEditor(text: $notes)
                        .frame(minHeight: 96)
                        .accessibilityLabel("Notes")
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    } footer: {
                        Text("Your notes are still here. Try again, or skip and let the server close the call out.")
                    }
                }
            }
            .navigationTitle("Wrap up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Skip") { controller.skipWrapup() }
                        .disabled(!WrapupViewModel.canSkip(isSubmitting: controller.isSubmittingWrapup))
                }
                ToolbarItem(placement: .confirmationAction) {
                    if controller.isSubmittingWrapup {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .fontWeight(.semibold)
                            .disabled(!canSave)
                    }
                }
            }
        }
    }

    private var canSave: Bool {
        WrapupViewModel.canSave(disposition: disposition, isSubmitting: controller.isSubmittingWrapup)
    }

    private func save() async {
        guard let disposition else { return }
        error = nil
        // Trimmed here rather than at the API: `dispositionRequest` omits the
        // field entirely when it is empty, so a `TextEditor` the rep tapped
        // into and backed out of posts as "no notes" instead of as a
        // Salesforce Task whose body is a blank line.
        await controller.finishWrapup(
            disposition: disposition, notes: WrapupViewModel.notesForPosting(notes)
        )

        let outcome = WrapupViewModel.outcome(after: controller.phase, refusal: controller.lastRefusal)
        if case let .failed(message) = outcome { error = message }
        // Anything the outcome wants said out loud goes to a surface that
        // outlives this screen — by the time a save is superseded, this view is
        // already being replaced by the next call's.
        if let toast = WrapupViewModel.toast(for: outcome) { onToast(toast) }
    }
}
