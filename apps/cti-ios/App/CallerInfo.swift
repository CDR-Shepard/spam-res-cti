import Foundation

/// Who is on the call, as the ring screen, the CallKit banner, and the
/// in-call screen show them.
///
/// For an inbound call this is built entirely from the custom parameters the
/// server attaches to the inbound TwiML
/// (`services/cti-api/src/routes/inbound-caller-params.ts`): `callerName`,
/// `recordId`, `recordType`, and *only* when the server matched the caller to
/// a Salesforce record — an unmatched caller's TwiML carries no parameters at
/// all, which is why every field but `number` is optional here. Nothing in
/// this type does a lookup of its own; the phone shows what the server
/// matched, so the ring screen and the CRM can never disagree.
struct CallerInfo: Equatable {
    /// The other party's number in whatever form it arrived. Empty when an
    /// inbound call has no caller id at all (blocked/withheld).
    let number: String
    let name: String?
    let recordId: String?
    let recordType: String?

    /// The big line: the matched name, else the number, else an honest
    /// admission that there is nothing to show.
    var displayTitle: String {
        if let name { return name }
        if let formatted = formattedNumber { return formatted }
        return "Unknown caller"
    }

    /// The small line — strictly the facts the title did *not* already use, so
    /// an unmatched caller (whose title is the number) gets no subtitle at all
    /// rather than the number twice.
    var displaySubtitle: String? {
        var parts: [String] = []
        if name != nil, let formatted = formattedNumber { parts.append(formatted) }
        if let recordType { parts.append(recordType) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var formattedNumber: String? {
        number.isEmpty ? nil : formatNANP(number)
    }

    /// Builds the caller from one invite's custom parameters. A blank
    /// `callerName` is treated as no name (Twilio delivers parameters as
    /// strings, and an empty one would leave the ring screen's title blank);
    /// the same guard applies to the record fields.
    static func from(customParameters: [String: String], from: String?) -> CallerInfo {
        CallerInfo(
            number: nonBlank(from) ?? "",
            name: nonBlank(customParameters["callerName"]),
            recordId: nonBlank(customParameters["recordId"]),
            recordType: nonBlank(customParameters["recordType"])
        )
    }

    private static func nonBlank(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

/// `+18585550100` → `(858) 555-0100`.
///
/// Deliberately conservative: anything that is not a 10-digit NANP number (or
/// an 11-digit one behind a country code of 1) comes back **verbatim**. A
/// number the rep is about to dial is not the place to guess at a format —
/// showing `+442071838750` unchanged is right, and reshaping it into something
/// that looks domestic would be a lie about who is being called.
func formatNANP(_ number: String) -> String {
    let digits = number.filter(\.isNumber)
    let national: Substring
    switch digits.count {
    case 10:
        national = digits[...]
    case 11 where digits.hasPrefix("1"):
        national = digits.dropFirst()
    default:
        return number
    }
    let area = national.prefix(3)
    let exchange = national.dropFirst(3).prefix(3)
    let line = national.suffix(4)
    return "(\(area)) \(exchange)-\(line)"
}

/// The deep link that opens a record in the Salesforce mobile app.
///
/// `nil` for anything that is not a Salesforce id. Ids are 15 or 18
/// alphanumeric characters, so rejecting everything else keeps a value that
/// arrived over the wire (a custom parameter is attacker-influenced input, not
/// a constant) from being pasted into a URL the app then opens.
func salesforceRecordURL(_ recordId: String) -> URL? {
    guard (15...18).contains(recordId.count),
          recordId.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
    else { return nil }
    return URL(string: "salesforce1://sObject/\(recordId)/view")
}
