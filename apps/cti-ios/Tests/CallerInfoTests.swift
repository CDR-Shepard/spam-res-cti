import XCTest

/// What the ring screen and the CallKit banner show for an inbound call, built
/// from the `<Parameter>` custom parameters the server attaches to the inbound
/// TwiML (`services/cti-api/src/routes/inbound-caller-params.ts`:
/// `callerName`, `recordId`, `recordType` — and *only* on a matched caller;
/// an unmatched caller's TwiML carries no parameters at all). Pure value type,
/// so every display rule is pinned here without a device.
final class CallerInfoTests: XCTestCase {
    func testMatchedCallerShowsNameAndType() {
        let info = CallerInfo.from(
            customParameters: ["callerName": "Jordyn Freedman", "recordId": "00Q000000000001", "recordType": "Lead"],
            from: "+18585550100"
        )
        XCTAssertEqual(info.displayTitle, "Jordyn Freedman")
        XCTAssertEqual(info.displaySubtitle, "(858) 555-0100 · Lead")
        XCTAssertEqual(info.recordId, "00Q000000000001")
    }

    func testUnmatchedCallerShowsNumberOnly() {
        let info = CallerInfo.from(customParameters: [:], from: "+18585550100")
        XCTAssertEqual(info.displayTitle, "(858) 555-0100")
        XCTAssertNil(info.displaySubtitle)
        XCTAssertNil(info.recordId)
    }

    func testNoFromShowsUnknownCaller() {
        XCTAssertEqual(CallerInfo.from(customParameters: [:], from: nil).displayTitle, "Unknown caller")
    }

    func testSalesforceDeepLink() {
        XCTAssertEqual(salesforceRecordURL("00Q000000000001"), URL(string: "salesforce1://sObject/00Q000000000001/view"))
    }

    // MARK: - The edges the four above leave open

    /// `setParameter(client, 'callerName', ...)` is guarded by `if (matched.name)`,
    /// so a matched record with no name on it arrives as recordId/recordType
    /// with no `callerName`. The number stays the title (there is no name to
    /// promote), and the type still has to reach the rep — as the subtitle on
    /// its own, not glued to a number the title already shows.
    func testMatchedRecordWithNoNameKeepsTheNumberAsTitleAndTypeAsSubtitle() {
        let info = CallerInfo.from(
            customParameters: ["recordId": "a0X000000000009AAA", "recordType": "Record"],
            from: "+18585550100"
        )
        XCTAssertEqual(info.displayTitle, "(858) 555-0100")
        XCTAssertEqual(info.displaySubtitle, "Record")
        XCTAssertEqual(info.recordId, "a0X000000000009AAA")
    }

    /// An empty `callerName` is not a name. Twilio delivers custom parameters
    /// as strings, and an empty one would otherwise make the title blank.
    func testBlankCallerNameIsTreatedAsNoName() {
        let info = CallerInfo.from(customParameters: ["callerName": "   "], from: "+18585550100")
        XCTAssertNil(info.name)
        XCTAssertEqual(info.displayTitle, "(858) 555-0100")
    }

    func testFormatNANPHandlesTenDigitAndBareNumbers() {
        XCTAssertEqual(formatNANP("+18585550100"), "(858) 555-0100")
        XCTAssertEqual(formatNANP("8585550100"), "(858) 555-0100")
        // Not NANP (or not a number at all): shown verbatim rather than mangled
        // into a shape that would misrepresent what is actually being dialed.
        XCTAssertEqual(formatNANP("+442071838750"), "+442071838750")
        XCTAssertEqual(formatNANP("anonymous"), "anonymous")
        XCTAssertEqual(formatNANP(""), "")
    }

    /// The deep link is only ever built from a Salesforce id, so anything that
    /// is not one must not silently produce a URL the app would then open.
    func testSalesforceDeepLinkRefusesAnEmptyOrNonIdRecord() {
        XCTAssertNil(salesforceRecordURL(""))
        XCTAssertNil(salesforceRecordURL("../../evil"))
    }
}
