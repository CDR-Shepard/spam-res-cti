import Foundation

/// The dial screen's banner: whatever the last dial attempt left behind, and
/// how loudly to say it.
///
/// The style split exists because `CallController.lastRefusal` carries two very
/// different kinds of sentence. Most of them are the *server's* — a firewall
/// BLOCK, a calling-hours stop, a disposition gate — and those are the only
/// explanation a rep ever gets for a call that did not happen, so they are
/// shown in full and in red. One of them ("Finish your current call first.") is
/// the app's own answer to a tap it never sent anywhere; painting that red too
/// would teach reps that red on this screen means nothing in particular.
struct RefusalBanner: Equatable {
    enum Style: Equatable {
        /// The server's words. Verbatim, and loud.
        case server
        /// The app's own, about a request that was never made.
        case local
    }

    let text: String
    let style: Style
}

/// What the review sheet puts in front of a rep before they can acknowledge a
/// REQUIRE_REVIEW verdict and dial anyway.
struct AcknowledgementPrompt: Equatable {
    let title: String
    let subtitle: String?
    /// The server's reason codes/text, **unedited**. This is the list the rep
    /// is about to attest they read, and the audit row holds the same strings.
    let reasons: [String]
    let scriptNote: String?
}

/// Every decision the dial screen makes, kept out of the SwiftUI body so it can
/// be pinned by `DialViewModelTests` without a simulator.
enum DialViewModel {
    static let placeholder = "Enter a number"

    /// Long enough for any E.164 number plus an extension's worth of tones,
    /// short enough that a stuck key cannot grow an unbounded string.
    static let maxDigits = 24

    private static let dialableKeys: Set<Character> = Set("0123456789*#+")

    /// The banner for the last refusal, or `nil` when there is nothing to say.
    ///
    /// `dismissed` is the text the rep already swiped away. Comparing the text
    /// (rather than holding a bool) is what makes the *next* refusal reappear:
    /// a rep who dismissed "outside calling hours" still has to be told that
    /// their second attempt was refused too.
    @MainActor
    static func banner(for refusal: String?, dismissed: String?) -> RefusalBanner? {
        guard let refusal, refusal != dismissed else { return nil }
        return RefusalBanner(text: refusal, style: refusal == CallController.busyRefusal ? .local : .server)
    }

    /// How long a dismissal lasts.
    ///
    /// `banner` compares the refusal *text*, which is what lets one refusal be
    /// swiped away without hiding the next — but it leaves a hole: refuse the
    /// same number twice and the second refusal is the same string, so a stale
    /// dismissal would swallow it. That is not hypothetical. A redial from the
    /// Recents tab does exactly this, and the rep would tap a row and watch
    /// nothing happen at all.
    ///
    /// So a dismissal is scoped to the call it was made about: the controller
    /// leaving `.idle` is a new call starting, and it clears the dismissal.
    @MainActor
    static func dismissal(_ current: String?, survives phase: CallController.Phase) -> String? {
        if case .idle = phase { return current }
        return nil
    }

    static func prompt(for info: CallerInfo, reasons: [String], requiredScriptId: String?) -> AcknowledgementPrompt {
        AcknowledgementPrompt(
            title: info.displayTitle,
            subtitle: info.displaySubtitle,
            // No filtering, no de-duplication, no rewording: a REQUIRE_REVIEW
            // that arrives with no reasons stays empty on screen rather than
            // having one manufactured for the rep to acknowledge.
            reasons: reasons,
            scriptNote: requiredScriptId.map { "Required script: \($0)" }
        )
    }

    /// Whether the green button is live. The controller refuses a second dial
    /// on its own (`CallController.busyRefusal`); this kills the button first,
    /// so the rep never earns a refusal for a tap the screen could have
    /// declined.
    @MainActor
    static func canDial(phase: CallController.Phase, raw: String) -> Bool {
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if case .idle = phase { return true }
        return false
    }

    static func append(_ key: String, to raw: String) -> String {
        guard key.count == 1, let character = key.first, dialableKeys.contains(character),
              raw.count < maxDigits
        else { return raw }
        return raw + key
    }

    static func backspace(_ raw: String) -> String {
        String(raw.dropLast())
    }

    /// Sanitizes anything that arrives through the number *field* — a pasted
    /// number out of an email or a CRM tab, or an edit made with the system
    /// keyboard — down to the same alphabet the pad produces.
    ///
    /// The field shows `formatDialString(raw)`, so this is the inverse half of
    /// a round trip: paste "+1 (619) 848-1782", store "+16198481782", and the
    /// field reads back exactly what was pasted. A pasted number and a typed
    /// one are indistinguishable from here on.
    static func accept(_ typed: String) -> String {
        String(typed.filter { dialableKeys.contains($0) }.prefix(maxDigits))
    }

    /// `"6198481782"` → `"(619) 848-1782"`, progressively, as the rep types.
    ///
    /// A direct port of `apps/cti-web/src/format.ts`'s `formatDialString`, so
    /// the phone and the web dialer shape a half-typed number the same way.
    /// Display only — the raw string is what gets sent, and the server does
    /// the normalization it audits against.
    ///
    /// Deliberately gives up in three places rather than guess: anything
    /// holding `*`/`#`, a `+` in front of a non-NANP country code, and an
    /// overflow past ten national digits all come back exactly as typed.
    /// Reshaping those would be a lie about which number is on the button.
    static func formatDialString(_ raw: String) -> String {
        if raw.isEmpty { return "" }
        if raw.contains("*") || raw.contains("#") { return raw }

        let hasPlus = raw.hasPrefix("+")
        // ASCII only, matching the web's `\D`. `Character.isNumber` would also
        // count an Arabic-Indic "٦", which is not a 6 to any carrier — and
        // counting one would shift a ten-digit number into the eleven-digit
        // branch and print a "+1" nobody typed.
        let digits = raw.filter(asciiDigits.contains)
        if hasPlus, !digits.hasPrefix("1") { return raw }

        let isCountryCoded = digits.hasPrefix("1") && (hasPlus || digits.count > 10)
        let national = isCountryCoded ? String(digits.dropFirst()) : digits
        let prefix = isCountryCoded ? "+1 " : ""

        if national.count > 10 { return raw }
        if national.isEmpty { return prefix.trimmingCharacters(in: .whitespaces) }
        if national.count <= 3 { return prefix + national }
        if national.count <= 7 { return "\(prefix)\(national.prefix(3))-\(national.dropFirst(3))" }
        return "\(prefix)(\(national.prefix(3))) \(national.dropFirst(3).prefix(3))-\(national.suffix(4))"
    }

    private static let asciiDigits: Set<Character> = Set("0123456789")

    /// The persistent "you still owe this call a disposition" line. The
    /// pending row's `toNumber` is already the server's normalized E.164.
    static func pendingBanner(for pending: CallSummary?) -> String? {
        guard let pending else { return nil }
        return "Finish your last call — \(formatNANP(pending.toNumber))"
    }
}
