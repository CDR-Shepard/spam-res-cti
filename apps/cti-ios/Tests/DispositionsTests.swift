import XCTest

/// The wrap-up disposition list is not the phone's to invent: it is copied
/// verbatim from `apps/cti-web/src/components/WrapupForm.tsx`'s `DISPOSITIONS`,
/// because the same strings are what the server stores, what the Salesforce
/// Task shows, and what every report downstream groups by. A phone that
/// shipped "Voicemail" where the web sends "Left voicemail" would quietly
/// fracture a customer's call reporting, and nothing in the pipeline would
/// complain — so the list is pinned here, in order, instead.
final class DispositionsTests: XCTestCase {
    func testFirstFourMatchTheWebApp() {
        XCTAssertEqual(
            Array(Dispositions.all.prefix(4)),
            ["Connected", "Left voicemail", "No answer", "Wrong number"]
        )
    }

    func testNoDuplicates() {
        XCTAssertEqual(Set(Dispositions.all).count, Dispositions.all.count)
    }

    /// The whole list, in the web app's own order — a picker that reordered
    /// them would still pass the prefix check above while training reps to
    /// tap the wrong row.
    func testFullListMatchesTheWebAppVerbatim() {
        XCTAssertEqual(Dispositions.all, [
            "Connected", "Left voicemail", "No answer", "Wrong number",
            "Do not call", "Busy", "Bad number", "Call back",
        ])
    }

    func testEveryEntryIsNonBlank() {
        for disposition in Dispositions.all {
            XCTAssertFalse(
                disposition.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                "a blank disposition would post an empty string to the server"
            )
        }
    }
}
