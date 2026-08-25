import XCTest

/// Store tests run against a throwaway container directory rather than the
/// real App Group, so they exercise the same code the extension reads through
/// without needing a provisioned shared container on the simulator.
final class DirectoryStoreTests: XCTestCase {
    private var containerURL: URL!
    private var store: DirectoryStore!

    override func setUpWithError() throws {
        containerURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("DirectoryStoreTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: containerURL, withIntermediateDirectories: true)
        store = DirectoryStore(containerURL: containerURL)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: containerURL)
        containerURL = nil
        store = nil
    }

    // MARK: - Round trip

    func testSaveThenLoadRoundTripsVersionAndEntries() throws {
        let entries = [
            DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe"),
            DirectoryEntry(e164: "+16195550101", label: "Contact: John Roe"),
        ]

        try store.save(version: 12, entries: entries)
        let loaded = try XCTUnwrap(store.load())

        XCTAssertEqual(loaded.version, 12)
        XCTAssertEqual(loaded.entries, entries)
    }

    func testSavingAgainReplacesThePreviousSnapshot() throws {
        try store.save(version: 1, entries: [DirectoryEntry(e164: "+16195550100", label: "old")])
        try store.save(version: 2, entries: [DirectoryEntry(e164: "+16195550111", label: "new")])

        let loaded = try XCTUnwrap(store.load())

        XCTAssertEqual(loaded.version, 2)
        XCTAssertEqual(loaded.entries.map(\.label), ["new"])
    }

    func testSaveLeavesNoTemporaryFilesInTheContainer() throws {
        try store.save(version: 1, entries: [DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe")])
        try store.save(version: 2, entries: [DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe")])

        let contents = try FileManager.default.contentsOfDirectory(atPath: containerURL.path)

        XCTAssertEqual(
            contents.filter { $0.hasSuffix(".tmp") },
            [],
            "the temp file must be renamed over the snapshot, never left behind"
        )
        XCTAssertEqual(contents, [store.fileURL.lastPathComponent])
    }

    // MARK: - Ordering

    func testEntriesArePersistedAscendingByNumericValue() throws {
        // Numeric, not lexicographic: as text "+15550000000" sorts before
        // "+25550000", but 15.5 billion is not smaller than 25.5 million, and
        // CallKit requires numerically ascending numbers.
        let entries = [
            DirectoryEntry(e164: "+15550000000", label: "eleven digits"),
            DirectoryEntry(e164: "+25550000", label: "eight digits"),
            DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe"),
        ]

        try store.save(version: 3, entries: entries)
        let loaded = try XCTUnwrap(store.load())

        XCTAssertEqual(loaded.entries.map(\.e164), ["+25550000", "+15550000000", "+16195550100"])
    }

    func testAscendingOrderIsPersistedOnDiskNotOnlyOnLoad() throws {
        try store.save(version: 3, entries: [
            DirectoryEntry(e164: "+16195550101", label: "second"),
            DirectoryEntry(e164: "+16195550100", label: "first"),
        ])

        let raw = try String(contentsOf: store.fileURL, encoding: .utf8)

        let firstOffset = try XCTUnwrap(raw.range(of: "+16195550100")).lowerBound
        let secondOffset = try XCTUnwrap(raw.range(of: "+16195550101")).lowerBound
        XCTAssertLessThan(firstOffset, secondOffset, "the file itself must hold entries ascending")
    }

    // MARK: - Missing / corrupt

    func testLoadReturnsNilWhenNothingHasBeenSaved() {
        XCTAssertNil(store.load())
    }

    func testLoadReturnsNilOnACorruptFile() throws {
        try Data("not json".utf8).write(to: store.fileURL)

        XCTAssertNil(store.load(), "a corrupt snapshot must read as absent, never crash the extension")
    }

    func testLoadReturnsNilWhenTheFileIsOutOfOrder() throws {
        // A hand-corrupted (descending) file would make CallKit reject the
        // whole load part-way through, so the store refuses to serve it.
        let descending = #"{"version":3,"entries":[{"e164":"+16195550101","label":"b"},{"e164":"+16195550100","label":"a"}]}"#
        try Data(descending.utf8).write(to: store.fileURL)

        XCTAssertNil(store.load())
    }

    // MARK: - Phone-number conversion

    func testPhoneNumberValueIsTheDigitsOfTheE164() {
        XCTAssertEqual(DirectoryStore.phoneNumberValue("+16195550100"), 16_195_550_100)
        XCTAssertEqual(DirectoryStore.phoneNumberValue("+1 (619) 555-0100"), 16_195_550_100)
        XCTAssertEqual(DirectoryStore.phoneNumberValue("nonsense"), 0)
    }

    func testUnusableNumbersAreDroppedRatherThanBreakingTheLoad() throws {
        try store.save(version: 1, entries: [
            DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe"),
            DirectoryEntry(e164: "no digits at all", label: "junk"),
            DirectoryEntry(e164: "+16195550100", label: "duplicate number"),
        ])

        let loaded = try XCTUnwrap(store.load())

        XCTAssertEqual(loaded.entries.map(\.label), ["Lead: Jane Doe"])
    }
}
