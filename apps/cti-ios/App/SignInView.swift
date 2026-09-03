import AuthenticationServices
import SwiftUI
import UIKit

/// First run under the sign-in flow: one button, a Salesforce web login, then
/// this phone registers itself. Every decision that can be tested — the
/// requests, the decoding, the poll's state machine, and what
/// `adoptDeviceToken` stores — lives in `SessionClient`,
/// `DeviceRegistrationClient` and `SyncEngine`; this view is only the button,
/// the web sheet, and the error text, so it is not unit-tested.
struct SignInView: View {
    @EnvironmentObject private var engine: SyncEngine

    @State private var isSigningIn = false
    @State private var errorMessage: String?
    @State private var presentationContext = AuthPresentationContext()

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Spacer()

                Text("Callsign")
                    .font(.largeTitle.bold())
                Text("Sign in with your Salesforce account to set up this iPhone.")
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

    @MainActor
    private func signIn() async {
        isSigningIn = true
        errorMessage = nil
        var authSession: ASWebAuthenticationSession?
        do {
            let (data, response) = try await URLSession.shared.data(for: loginStartRequest(baseURL: AppConfig.baseURL))
            let start = try decodeLoginStart(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)

            // `callbackURLScheme: nil` — the redirect Salesforce sends back
            // lands on the API's own page, not a scheme this app owns. This
            // session is only here to show the login page; the poller below
            // is the real completion signal, and once it reports `.connected`
            // this session is cancelled rather than awaited.
            let session = ASWebAuthenticationSession(url: start.authUrl, callbackURLScheme: nil) { _, _ in }
            session.presentationContextProvider = presentationContext
            authSession = session
            guard session.start() else { throw SessionClientError.malformedResponse }

            let status = try await SignInPoller(
                handshake: start.handshake,
                status: liveLoginStatus(baseURL: AppConfig.baseURL),
                sleep: { try? await Task.sleep(for: .seconds($0)) }
            ).run()

            authSession?.cancel()
            authSession = nil

            guard case let .connected(sessionToken, _, displayName) = status else {
                throw SessionClientError.malformedResponse
            }

            try SessionTokenStore.save(sessionToken)
            let registration = try await liveRegisterDevice(
                baseURL: AppConfig.baseURL,
                sessionToken: sessionToken,
                label: "\(UIDevice.current.name) (Callsign)"
            )
            try engine.adoptDeviceToken(registration.deviceToken, displayName: displayName)
        } catch {
            authSession?.cancel()
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isSigningIn = false
    }
}

/// `ASWebAuthenticationSession.presentationContextProvider` is `weak`, so it
/// needs a holder that outlives the request that sets it — `@State` keeps this
/// alive for the view's lifetime rather than the single `signIn()` call.
private final class AuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
