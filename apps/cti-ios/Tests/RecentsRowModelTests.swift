import XCTest

/// One `GET /calls` row as the Recents list draws it — and, more importantly,
/// as it redials.
///
/// The direction split is the whole point of this type. In `schema.calls` a
/// row's `toNumber`/`fromNumber` are literally the call's legs, so for an
/// *inbound* call `toNumber` is one of the org's own DIDs and `fromNumber` is
/// the person who rang. A list that showed `toNumber` for every row would put
/// the rep's own number on half the screen, and tapping it would dial the
/// company back.
final class RecentsRowModelTests: XCTestCase {

    private func summary(
        id: String = "call_1",
        direction: String = "outbound",
        toNumber: String = "+16198481782",
        fromNumber: String? = "+18585550100",
        disposition: String? = "Connected",
        durationSeconds: Int? = 65,
        createdAt: String = "2026-09-03T18:04:05.000Z",
        whoId: String? = nil,
        whatId: String? = nil
    ) -> CallSummary {
        CallSummary(
            id: id, direction: direction, toNumber: toNumber, fromNumber: fromNumber,
            disposition: disposition, durationSeconds: durationSeconds, createdAt: createdAt,
            salesforceWhoId: whoId, salesforceWhatId: whatId
        )
    }

    // MARK: - Who the row is about

    func testAnOutboundRowShowsAndRedialsThePersonWeCalled() {
        let row = RecentsRowModel.make(summary())
        XCTAssertEqual(row.id, "call_1")
        XCTAssertFalse(row.isInbound)
        XCTAssertEqual(row.title, "(619) 848-1782")
        XCTAssertEqual(row.redialTarget, "+16198481782")
    }

    func testAnInboundRowShowsAndRedialsTheCallerNotOurOwnDID() {
        let row = RecentsRowModel.make(summary(direction: "inbound"))
        XCTAssertTrue(row.isInbound)
        XCTAssertEqual(row.title, "(858) 555-0100")
        XCTAssertEqual(row.redialTarget, "+18585550100")
    }

    /// A withheld caller id leaves nothing to dial; the row must not fall back
    /// to the DID the call arrived on.
    func testAnInboundRowWithNoCallerIdIsNotRedialable() {
        let row = RecentsRowModel.make(summary(direction: "inbound", fromNumber: nil))
        XCTAssertNil(row.redialTarget)
        XCTAssertEqual(row.title, "Unknown caller")
    }

    func testAnInboundRowWithABlankCallerIdIsNotRedialable() {
        let row = RecentsRowModel.make(summary(direction: "inbound", fromNumber: "  "))
        XCTAssertNil(row.redialTarget)
    }

    func testDirectionGlyphsDiffer() {
        let outbound = RecentsRowModel.make(summary())
        let inbound = RecentsRowModel.make(summary(direction: "inbound"))
        XCTAssertFalse(outbound.glyph.isEmpty)
        XCTAssertNotEqual(outbound.glyph, inbound.glyph)
    }

    // MARK: - What the row says

    func testDispositionIsShownAsTheServerStoredIt() {
        XCTAssertEqual(RecentsRowModel.make(summary(disposition: "Left voicemail")).disposition, "Left voicemail")
    }

    /// An un-dispositioned outbound call is exactly what blocks the rep's next
    /// dial, so the row says so rather than leaving the line blank.
    func testAnUndispositionedCallSaysSo() {
        let row = RecentsRowModel.make(summary(disposition: nil))
        XCTAssertEqual(row.disposition, RecentsRowModel.noDisposition)
        XCTAssertTrue(row.needsDisposition)
    }

    /// The gate is outbound-only server-side; an inbound row with no
    /// disposition is not something the rep owes anything for.
    func testAnInboundRowIsNeverFlaggedAsOwingADisposition() {
        XCTAssertFalse(RecentsRowModel.make(summary(direction: "inbound", disposition: nil)).needsDisposition)
    }

    func testDurationIsFormattedAsMinutesAndSeconds() {
        XCTAssertEqual(RecentsRowModel.make(summary(durationSeconds: 65)).duration, "1:05")
        XCTAssertEqual(RecentsRowModel.make(summary(durationSeconds: 9)).duration, "0:09")
        XCTAssertEqual(RecentsRowModel.make(summary(durationSeconds: 3_725)).duration, "1:02:05")
    }

    func testACallWithNoDurationShowsNone() {
        XCTAssertNil(RecentsRowModel.make(summary(durationSeconds: nil)).duration)
        XCTAssertNil(RecentsRowModel.make(summary(durationSeconds: 0)).duration)
    }

    // MARK: - When

    func testCreatedAtIsParsedWithAndWithoutFractionalSeconds() {
        let withFraction = RecentsRowModel.make(summary(createdAt: "2026-09-03T18:04:05.123Z")).date
        let without = RecentsRowModel.make(summary(createdAt: "2026-09-03T18:04:05Z")).date
        XCTAssertNotNil(withFraction)
        XCTAssertNotNil(without)
        XCTAssertEqual(withFraction!.timeIntervalSince1970, without!.timeIntervalSince1970, accuracy: 1)
    }

    /// A timestamp the phone cannot parse must not become "now" — a row dated
    /// today that is actually a month old is worse than a row with no date.
    func testAnUnparseableTimestampBecomesNoDateRatherThanNow() {
        XCTAssertNil(RecentsRowModel.make(summary(createdAt: "not a date")).date)
        XCTAssertNil(RecentsRowModel.relativeText(nil, now: Date()))
    }

    func testRelativeTextIsRelativeToTheGivenNow() {
        let date = Date(timeIntervalSince1970: 1_780_000_000)
        let text = RecentsRowModel.relativeText(
            date, now: date.addingTimeInterval(2 * 3600), locale: Locale(identifier: "en_US")
        )
        XCTAssertNotNil(text)
        XCTAssertTrue(text!.lowercased().contains("hour"), "unexpected relative text: \(text ?? "nil")")
    }

    // MARK: - Salesforce

    func testTheWhoIdIsTheRecordTheRowOpens() {
        XCTAssertEqual(RecentsRowModel.make(summary(whoId: "00Q000000000001")).recordId, "00Q000000000001")
    }

    /// No Who (a call attached to an Account or Opportunity instead) still has
    /// somewhere to open.
    func testTheWhatIdIsUsedWhenThereIsNoWho() {
        XCTAssertEqual(RecentsRowModel.make(summary(whatId: "001000000000001")).recordId, "001000000000001")
    }

    func testACallWithNoSalesforceRecordHasNothingToOpen() {
        XCTAssertNil(RecentsRowModel.make(summary()).recordId)
    }
}
