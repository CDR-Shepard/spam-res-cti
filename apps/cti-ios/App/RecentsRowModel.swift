import Foundation

/// One `GET /calls` row as the Recents list draws it — and, more importantly,
/// as it redials.
///
/// The direction split is the reason this type exists. In `schema.calls` a
/// row's `toNumber`/`fromNumber` are literally the call's two legs, so on an
/// *inbound* row `toNumber` is one of the org's own DIDs and `fromNumber` is
/// the person who rang. A list that rendered `toNumber` for every row would
/// show the rep their own number on half the screen, and tapping it would dial
/// the company back.
struct RecentsRowModel: Equatable, Identifiable {
    static let noDisposition = "No disposition"

    let id: String
    let isInbound: Bool
    /// SF Symbol.
    let glyph: String
    /// The other party, formatted — or an honest admission there is nobody to
    /// name.
    let title: String
    let disposition: String
    /// `nil` for a call that never carried audio, rather than "0:00".
    let duration: String?
    /// `nil` when `createdAt` could not be parsed. Deliberately not defaulted
    /// to `now`: a month-old row dated today is worse than a row with no date.
    let date: Date?
    /// The other party's number as the server stored it, ready to hand
    /// straight back to `placeCall`. `nil` when there is nothing to dial (an
    /// inbound call from a withheld number) — the DID is *not* a fallback.
    let redialTarget: String?
    /// The Salesforce record this call is attached to, if any.
    let recordId: String?
    /// An outbound call the rep still owes a disposition for. This is exactly
    /// what blocks their next dial server-side, so the row says so.
    let needsDisposition: Bool

    static func make(_ call: CallSummary) -> RecentsRowModel {
        let isInbound = call.direction == "inbound"
        let counterparty = nonBlank(isInbound ? call.fromNumber : call.toNumber)

        return RecentsRowModel(
            id: call.id,
            isInbound: isInbound,
            glyph: isInbound ? "phone.arrow.down.left" : "phone.arrow.up.right",
            title: counterparty.map(formatNANP) ?? "Unknown caller",
            disposition: call.disposition ?? noDisposition,
            duration: formatDuration(call.durationSeconds),
            date: parseTimestamp(call.createdAt),
            redialTarget: counterparty,
            // Who first: a Lead/Contact is the record a rep actually wants
            // open. `salesforceRecordURL` rejects anything that is not an id
            // shape, so a junk value here simply yields no button.
            recordId: call.salesforceWhoId ?? call.salesforceWhatId,
            // `findPendingDisposition` (calls.ts) only ever matches
            // un-dispositioned OUTBOUND calls, so an inbound row with no
            // disposition is not something the rep owes anything for.
            needsDisposition: !isInbound && call.disposition == nil
        )
    }

    /// "2 hours ago". `nil` in, `nil` out — a row with no parseable timestamp
    /// gets no time rather than a wrong one.
    ///
    /// The app path reuses one cached formatter, because this runs once per
    /// visible row on every redraw and allocating fifty `DateFormatter`s per
    /// scroll frame is exactly the kind of thing that makes a list feel cheap.
    /// Only a test pinning a specific locale pays for a fresh one — which also
    /// keeps the shared instance immutable rather than having its locale
    /// rewritten under whoever is using it.
    static func relativeText(_ date: Date?, now: Date, locale: Locale? = nil) -> String? {
        guard let date else { return nil }
        guard let locale else { return sharedRelative.localizedString(for: date, relativeTo: now) }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: now)
    }

    private static let sharedRelative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private static func nonBlank(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    /// `65` → `"1:05"`, `3725` → `"1:02:05"`. Nothing (or zero) is `nil`: a
    /// call that never connected did not last "0:00", it has no duration.
    private static func formatDuration(_ seconds: Int?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let remainder = seconds % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, remainder)
        }
        return String(format: "%d:%02d", minutes, remainder)
    }

    /// Postgres timestamps reach the app as ISO-8601 with *or* without
    /// fractional seconds depending on the column, so both are tried before
    /// giving up.
    private static func parseTimestamp(_ value: String) -> Date? {
        if let date = fractionalISO.date(from: value) { return date }
        return plainISO.date(from: value)
    }

    private static let fractionalISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
