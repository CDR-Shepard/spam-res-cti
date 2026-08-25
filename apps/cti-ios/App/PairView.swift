import SwiftUI
import UIKit

/// First run: the rep generates a 6-digit code in the softphone and types it
/// here. A successful claim stores the device token in the Keychain and pulls
/// the directory immediately.
struct PairView: View {
    @EnvironmentObject private var engine: SyncEngine

    @State private var code = ""
    @State private var deviceLabel = UIDevice.current.name
    @State private var isPairing = false
    @State private var errorMessage: String?
    @FocusState private var codeFieldFocused: Bool

    private static let codeLength = 6

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("000000", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.system(.largeTitle, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .focused($codeFieldFocused)
                        .onChange(of: code) { _, newValue in
                            code = Self.sanitize(newValue)
                        }
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("Open the softphone on your computer and choose “Pair iPhone”. The code expires after five minutes.")
                }

                Section("This iPhone") {
                    TextField("Device name", text: $deviceLabel)
                        .textInputAutocapitalization(.words)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await pair() }
                    } label: {
                        HStack {
                            Text("Pair this iPhone")
                            Spacer()
                            if isPairing { ProgressView() }
                        }
                    }
                    .disabled(!canPair)
                }
            }
            .navigationTitle("CTI Caller ID")
            .onAppear { codeFieldFocused = true }
        }
    }

    private var canPair: Bool {
        code.count == Self.codeLength
            && !deviceLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isPairing
    }

    private func pair() async {
        isPairing = true
        errorMessage = nil
        do {
            try await engine.pair(
                code: code,
                deviceLabel: deviceLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            // A code is single-use even when the claim fails on our side, so
            // never leave a dead one in the field.
            code = ""
            codeFieldFocused = true
        }
        isPairing = false
    }

    /// Digits only, capped at the code length — the number pad still offers
    /// paste, and the server rejects anything that is not exactly six digits.
    private static func sanitize(_ input: String) -> String {
        String(input.filter(\.isNumber).prefix(codeLength))
    }
}
