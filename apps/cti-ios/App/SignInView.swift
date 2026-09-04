import AuthenticationServices
import SwiftUI
import UIKit

/// First run under the sign-in flow: one button, a Salesforce web login, then
/// this phone registers itself. Every decision that can be tested — the
/// requests, the decoding, the poll's state machine, the order of operations,
/// and what `adoptDeviceToken` stores — lives in `SessionClient`,
/// `DeviceRegistrationClient`, `SignInFlow` and `SyncEngine`; this view only
/// wires the live pieces together, presents the web sheet, and shows the
/// error text, so it is not unit-tested.
struct SignInView: View {
    @EnvironmentObject private var engine: SyncEngine

    @State private var isSigningIn = false
    @State private var errorMessage: String?
    @State private var webAuth = WebAuthPresenter()

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Spacer()

                Text("Callsign")
                    .font(.largeTitle.bold())
                Text(subtitle)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)

                if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                Spacer()

                Button {
                    Task { await signIn() }
                } label: {
                    HStack {
                        Text("Sign in with Salesforce")
                        if isSigningIn { ProgressView() }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSigningIn)
                .padding()
            }
            .navigationTitle("Callsign")
        }
    }

    /// A legacy code-paired phone (a device token from before Salesforce
    /// sign-in existed, no session token) already has calling set up in every
    /// sense except this one — telling it to "set up this iPhone" would read
    /// as a reset. `engine.isLegacyPairedDevice` is what tells the two apart.
    private var subtitle: String {
        engine.isLegacyPairedDevice
            ? "Sign in with Salesforce to enable calling"
            : "Sign in with your Salesforce account to set up this iPhone."
    }

    @MainActor
    private func signIn() async {
        isSigningIn = true
        errorMessage = nil
        do {
            try await SignInFlow.run(label: "\(UIDevice.current.name) (Callsign)", deps: deps)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isSigningIn = false
    }

    /// The live wiring: every request/poll piece already exists and is
    /// tested on its own (`SessionClient`, `DeviceRegistrationClient`); this
    /// only points `SignInFlow` at them and at this phone's stores.
    private var deps: SignInFlow.Deps {
        SignInFlow.Deps(
            startLogin: {
                let (data, response) = try await URLSession.shared.data(for: loginStartRequest(baseURL: AppConfig.baseURL))
                return try decodeLoginStart(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
            },
            openWeb: { url in try await webAuth.open(url) },
            pollStatus: { handshake in
                try await SignInPoller(
                    handshake: handshake,
                    status: liveLoginStatus(baseURL: AppConfig.baseURL),
                    sleep: { try? await Task.sleep(for: .seconds($0)) }
                ).run()
            },
            registerDevice: { sessionToken, label in
                try await liveRegisterDevice(baseURL: AppConfig.baseURL, sessionToken: sessionToken, label: label)
            },
            saveSession: { try SessionTokenStore().save($0) },
            deleteSession: { try SessionTokenStore().delete() },
            adoptDevice: { deviceToken, displayName in
                try engine.adoptDeviceToken(deviceToken, displayName: displayName)
            }
        )
    }
}

/// Presents the Salesforce login page in an `ASWebAuthenticationSession` and
/// suspends until it closes — the `openWeb` half of `SignInFlow.Deps`.
///
/// A class (not a value captured per-call) for two reasons: its
/// `presentationContextProvider` is `weak`, so something has to outlive the
/// single request to hold the anchor; and cancellation needs a place to keep
/// the in-flight session so `onCancel` — which can fire from any isolation —
/// has something to call `.cancel()` on.
@MainActor
private final class WebAuthPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }

    /// `callbackURLScheme: nil` — the redirect Salesforce sends back lands on
    /// the API's own page, not a scheme this app owns, so the session's own
    /// completion handler (rather than a callback URL) is the only signal it
    /// ever gives. That handler now actually drives this method's result
    /// instead of being ignored: a person cancelling the sheet resolves
    /// `.cancelled` immediately rather than leaving `SignInFlow`'s poll to run
    /// until it times out on its own.
    func open(_ url: URL) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let session = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) { _, error in
                    if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                        continuation.resume(throwing: SignInFlow.SignInFlowError.cancelled)
                    } else if error != nil {
                        continuation.resume(throwing: SignInFlow.SignInFlowError.loginFailed)
                    } else {
                        continuation.resume()
                    }
                }
                session.presentationContextProvider = self
                // Ephemeral: this is a company phone that changes hands
                // between reps, so no Salesforce cookie from this login may
                // survive past this sign-in.
                session.prefersEphemeralWebBrowserSession = true
                self.session = session
                guard session.start() else {
                    // The OS refused to present the sheet at all — not a
                    // server response, so this must not borrow
                    // `SessionClientError.malformedResponse`'s "the server
                    // sent an unexpected response" copy for something the
                    // server was never involved in.
                    continuation.resume(throwing: SignInFlow.SignInFlowError.loginFailed)
                    return
                }
            }
        } onCancel: {
            // `SignInFlow` cancels this the moment the poller wins the race
            // (or the poller loses to an already-cancelled sheet) — without
            // this, a session the poller already resolved would sit open
            // on screen until the person dismissed it themselves.
            Task { @MainActor in self.session?.cancel() }
        }
    }
}
