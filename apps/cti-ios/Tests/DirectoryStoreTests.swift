import XCTest

/// Store tests run against a throwaway container directory rather than the
/// real App Group, so they exercise the same code the extension reads through
/// without needing a provisioned shared container on the simulator.
///
/// The snapshot is a binary file the extension STREAMS, so most of what is
/// pinned here is the parser's refusal to hand CallKit anything it cannot
/// fully vouch for: every corruption below has to throw, because a partial
/// stream published as a complete one is a directory of wrong labels.
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

    func testSaveThenStreamRoundTripsVersionOrderAndLabels() throws {
        let entries = [
            DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe"),
            DirectoryEntry(e164: "+16195550101", label: "Contact: John Roe"),
        ]

        try store.save(version: 12, entries: entries)

        let header = try XCTUnwrap(store.loadHeader())
        XCTAssertEqual(header.version, 12)
        XCTAssertEqual(header.entryCount, 2)
        let entriesRead = try streamed()
        XCTAssertEqual(entriesRead.map(\.number), [16_195_550_100, 16_195_550_101])
        XCTAssertEqual(entriesRead.map(\.label), ["Lead: Jane Doe", "Contact: John Roe"])
    }

    func testLabelsSurviveNonASCIICharacters() throws {
        // Salesforce names carry accents, CJK, and the odd emoji; the label is
        // length-prefixed UTF-8, so multi-byte scalars have to survive the
        // round trip byte for byte.
        let entries = [
            DirectoryEntry(e164: "+16195550100", label: "Lead: José Ñuñez"),
            DirectoryEntry(e164: "+16195550101", label: "Deal: 山田太郎 🏠"),
        ]

        try store.save(version: 1, entries: entries)

        XCTAssertEqual(try streamed().map(\.label), ["Lead: José Ñuñez", "Deal: 山田太郎 🏠"])
    }

    func testAnEmptyDirectoryRoundTripsAsAnEmptyStream() throws {
        // This is the unpair wipe: version 0, no entries. It must read back as
        // a valid, empty snapshot rather than as a corrupt one.
        try store.save(version: 0, entries: [])

        let header = try XCTUnwrap(store.loadHeader())
        XCTAssertEqual(header.version, 0)
        XCTAssertEqual(header.entryCount, 0)
        XCTAssertEqual(try streamed().count, 0)
    }

    func testAnEntryCountLargerThanOneReadChunkStreamsWholeAndInOrder() throws {
        // The parser reads in fixed chunks, so records straddle chunk
        // boundaries and a record's own bytes can arrive in two reads. Enough
        // entries here (with wide labels) to cross that boundary many times.
        let count = 5_000
        let entries = (0..<count).map {
            DirectoryEntry(
                e164: "+16192\(String(format: "%06d", $0))",
                label: "Lead: a reasonably wide Salesforce name \($0)"
            )
        }

        try store.save(version: 7, entries: entries)

        var seen = 0
        var previous: Int64 = 0
        try store.streamEntries { number, label in
            XCTAssertGreaterThan(number, previous)
            previous = number
            XCTAssertEqual(label, "Lead: a reasonably wide Salesforce name \(seen)")
            seen += 1
        }
        XCTAssertEqual(seen, count)
        XCTAssertEqual(store.loadHeader()?.entryCount, count)
    }

    func testSavingAgainReplacesThePreviousSnapshot() throws {
        try store.save(version: 1, entries: [DirectoryEntry(e164: "+16195550100", label: "old")])
        try store.save(version: 2, entries: [DirectoryEntry(e164: "+16195550111", label: "new")])

        XCTAssertEqual(store.loadHeader()?.version, 2)
        XCTAssertEqual(try streamed().map(\.label), ["new"])
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

    func testSaveSweepsTempFilesAnInterruptedWriteLeftBehind() throws {
        // The failed-rename cleanup only runs when the rename fails. A crash
        // or a jetsam kill mid-write skips it, and nothing else sweeps the
        // shared container — so without this each interruption strands a full
        // copy of the directory in the App Group forever.
        let stranded = containerURL
            .appendingPathComponent("\(store.fileURL.lastPathComponent).\(UUID().uuidString).tmp")
        try Data("half a directory".utf8).write(to: stranded)
        let unrelated = containerURL.appendingPathComponent("something-else.txt")
        try Data("keep me".utf8).write(to: unrelated)

        try store.save(version: 1, entries: [DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe")])

        XCTAssertFalse(FileManager.default.fileExists(atPath: stranded.path))
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: unrelated.path),
            "only this store's own temp files may be swept — the container is shared"
        )
        XCTAssertEqual(store.loadHeader()?.entryCount, 1, "the sweep must not disturb the write it precedes")
    }

    // MARK: - The header is all `loadHeader` reads

    func testLoadHeaderReadsTheHeaderWithoutTheBody() throws {
        // The whole point of the split: the app and the status screen want the
        // version and the count, and reading 149,800 records to learn them is
        // exactly the cost this format exists to avoid. Proven behaviourally —
        // the body is amputated, and the header still reads clean.
        try store.save(version: 42, entries: [
            DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe"),
            DirectoryEntry(e164: "+16195550101", label: "Lead: John Roe"),
        ])
        let whole = try Data(contentsOf: store.fileURL)
        try whole.prefix(DirectoryStore.headerSize).write(to: store.fileURL)

        let header = try XCTUnwrap(store.loadHeader())

        XCTAssertEqual(header.version, 42)
        XCTAssertEqual(header.entryCount, 2, "the count is the header's, not a tally of records read")
        XCTAssertThrowsError(try store.streamEntries { _, _ in }, "…and streaming the same file still refuses it")
    }

    func testLoadHeaderReturnsNilWhenNothingHasBeenSaved() {
        XCTAssertNil(store.loadHeader())
    }

    func testLoadHeaderReturnsNilOnAFileShorterThanAHeader() throws {
        try Data(SnapshotBytes().data.prefix(DirectoryStore.headerSize - 1)).write(to: store.fileURL)

        XCTAssertNil(store.loadHeader(), "a short file must read as absent, never crash the extension")
    }

    func testLoadHeaderReturnsNilOnBadMagic() throws {
        var raw = SnapshotBytes()
        raw.magic = Array("JSON".utf8)
        try raw.data.write(to: store.fileURL)

        XCTAssertNil(store.loadHeader())
    }

    func testLoadHeaderReturnsNilOnAnUnknownFormatVersion() throws {
        var raw = SnapshotBytes()
        raw.formatVersion = 2
        try raw.data.write(to: store.fileURL)

        XCTAssertNil(store.loadHeader(), "a format this build cannot parse is not a snapshot it may serve")
    }

    func testLoadHeaderReturnsNilOnAFileOfGarbage() throws {
        try Data("not a snapshot at all, just some bytes".utf8).write(to: store.fileURL)

        XCTAssertNil(store.loadHeader())
    }

    // MARK: - Streaming refuses everything it cannot vouch for

    func testStreamEntriesThrowsWhenThereIsNoFile() {
        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .unreadable)
        }
    }

    func testStreamEntriesThrowsOnBadMagic() throws {
        var raw = SnapshotBytes()
        raw.magic = Array("JSON".utf8)
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .badHeader)
        }
    }

    func testStreamEntriesThrowsOnAnUnknownFormatVersion() throws {
        var raw = SnapshotBytes()
        raw.formatVersion = 99
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .badHeader)
        }
    }

    func testStreamEntriesThrowsOnARecordTruncatedMidNumber() throws {
        var raw = SnapshotBytes()
        raw.entryCount = 2
        raw.body = snapshotRecord(16_195_550_100, "Lead: Jane Doe") + [0x01, 0x02, 0x03]
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .truncatedRecord)
        }
    }

    func testStreamEntriesThrowsWhenALabelLengthRunsPastTheEndOfTheFile() throws {
        // The length prefix is the one field a reader has to trust before it
        // can bound the read. A lie here is how a corrupt file turns into an
        // out-of-bounds read, so it has to be checked against what is left.
        var raw = SnapshotBytes()
        raw.entryCount = 1
        raw.body = snapshotRecord(16_195_550_100, labelLen: 4_096, labelBytes: Array("short".utf8))
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .truncatedRecord)
        }
    }

    func testStreamEntriesThrowsOnANonAscendingPair() throws {
        // CallKit rejects a non-ascending stream outright, part-way through,
        // and the extension cannot un-publish what it already handed over. So
        // the order is checked on the way out, record by record.
        var raw = SnapshotBytes()
        raw.entryCount = 2
        raw.body = snapshotRecord(16_195_550_101, "second") + snapshotRecord(16_195_550_100, "first")
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .notAscending)
        }
    }

    func testStreamEntriesThrowsOnARepeatedNumber() throws {
        var raw = SnapshotBytes()
        raw.entryCount = 2
        raw.body = snapshotRecord(16_195_550_100, "one") + snapshotRecord(16_195_550_100, "the same again")
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .notAscending)
        }
    }

    func testStreamEntriesThrowsWhenTheHeaderPromisesMoreRecordsThanTheFileHolds() throws {
        var raw = SnapshotBytes()
        raw.entryCount = 3
        raw.body = snapshotRecord(16_195_550_100, "one") + snapshotRecord(16_195_550_101, "two")
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .entryCountMismatch)
        }
    }

    func testStreamEntriesThrowsWhenTheHeaderPromisesFewerRecordsThanTheFileHolds() throws {
        var raw = SnapshotBytes()
        raw.entryCount = 1
        raw.body = snapshotRecord(16_195_550_100, "one") + snapshotRecord(16_195_550_101, "two")
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .trailingBytes)
        }
    }

    func testStreamEntriesThrowsOnTrailingBytes() throws {
        // No footer: whatever follows the last record is something this build
        // does not understand, and publishing the prefix would be a guess.
        var raw = SnapshotBytes()
        raw.entryCount = 1
        raw.body = snapshotRecord(16_195_550_100, "one") + [0xDE, 0xAD]
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .trailingBytes)
        }
    }

    func testStreamEntriesThrowsOnAnInvalidUTF8Label() throws {
        var raw = SnapshotBytes()
        raw.entryCount = 1
        raw.body = snapshotRecord(16_195_550_100, labelLen: 2, labelBytes: [0xFF, 0xFE])
        try raw.data.write(to: store.fileURL)

        XCTAssertThrowsError(try store.streamEntries { _, _ in }) { error in
            XCTAssertEqual(error as? DirectoryStoreError, .invalidLabel)
        }
    }

    func testStreamEntriesStopsAtTheBadRecordRatherThanRunningPastIt() throws {
        var raw = SnapshotBytes()
        raw.entryCount = 3
        raw.body = snapshotRecord(16_195_550_100, "first")
            + snapshotRecord(16_195_550_099, "out of order")
            + snapshotRecord(16_195_550_200, "never reached")
        try raw.data.write(to: store.fileURL)

        var published: [String] = []
        XCTAssertThrowsError(try store.streamEntries { _, label in published.append(label) })

        XCTAssertEqual(published, ["first"], "the parser must not read past the record it refused")
    }

    func testStreamEntriesPropagatesAnErrorTheBodyThrows() throws {
        // CallKit's own `addIdentificationEntry` can fail the request; the
        // extension's `cancelRequest` path depends on that error reaching it
        // rather than being swallowed into a "complete" stream.
        try store.save(version: 1, entries: [
            DirectoryEntry(e164: "+16195550100", label: "one"),
            DirectoryEntry(e164: "+16195550101", label: "two"),
        ])

        XCTAssertThrowsError(try store.streamEntries { _, _ in throw BodyFailure.refused }) { error in
            XCTAssertEqual(error as? BodyFailure, .refused)
        }
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

        XCTAssertEqual(try streamed().map(\.number), [25_550_000, 15_550_000_000, 16_195_550_100])
    }

    func testAscendingOrderIsPersistedOnDiskNotOnlyOnLoad() throws {
        // Read the first record's number straight out of the file's bytes: the
        // ORDER has to be a property of what was written, not of what the
        // reader happens to do with it.
        try store.save(version: 3, entries: [
            DirectoryEntry(e164: "+16195550101", label: "second"),
            DirectoryEntry(e164: "+16195550100", label: "first"),
        ])

        let raw = try Data(contentsOf: store.fileURL)
        let firstNumber = raw[DirectoryStore.headerSize..<(DirectoryStore.headerSize + 8)]
            .reversed()
            .reduce(Int64(0)) { ($0 << 8) | Int64($1) }

        XCTAssertEqual(firstNumber, 16_195_550_100, "the file itself must hold the lowest number first")
    }

    func testUnusableNumbersAreDroppedRatherThanBreakingTheLoad() throws {
        try store.save(version: 1, entries: [
            DirectoryEntry(e164: "+16195550100", label: "Lead: Jane Doe"),
            DirectoryEntry(e164: "no digits at all", label: "junk"),
            DirectoryEntry(e164: "+16195550100", label: "duplicate number"),
        ])

        XCTAssertEqual(try streamed().map(\.label), ["Lead: Jane Doe"])
        XCTAssertEqual(store.loadHeader()?.entryCount, 1, "the header counts what was actually written")
    }

    // MARK: - The publish ceiling

    func testSaveRefusesToWriteMoreEntriesThanTheCeilingAllows() throws {
        // Belt and suspenders against a server that forgot its own cap. The
        // ceiling is injected here so the test costs a handful of rows rather
        // than a quarter of a million; production takes `AppConfig`'s.
        let bounded = DirectoryStore(containerURL: containerURL, maxEntries: 5)
        let entries = (0..<8).map {
            DirectoryEntry(e164: "+16192\(String(format: "%06d", $0))", label: "Lead: \($0)")
        }

        try bounded.save(version: 1, entries: entries)

        let streamedEntries = try streamed(from: bounded)
        XCTAssertEqual(streamedEntries.count, 5)
        XCTAssertEqual(bounded.loadHeader()?.entryCount, 5, "the header must agree with the records written")
        // The prefix kept is the LOWEST-numbered entries, so what is left is
        // still strictly ascending — CallKit rejects anything else.
        XCTAssertEqual(streamedEntries.first?.number, 16_192_000_000)
        XCTAssertEqual(streamedEntries.last?.number, 16_192_000_004)
    }

    func testTheProductionCeilingIsTheSharedConstant() throws {
        // The default is what ships; the injected ceiling above must never
        // become the thing the app actually enforces.
        XCTAssertEqual(DirectoryStore(containerURL: containerURL).maxEntries, AppConfig.maxDirectoryEntries)
    }

    // MARK: - Phone-number conversion

    func testPhoneNumberValueIsTheDigitsOfTheE164() {
        XCTAssertEqual(DirectoryStore.phoneNumberValue("+16195550100"), 16_195_550_100)
        XCTAssertEqual(DirectoryStore.phoneNumberValue("+1 (619) 555-0100"), 16_195_550_100)
        XCTAssertEqual(DirectoryStore.phoneNumberValue("nonsense"), 0)
    }

    // MARK: - Helpers

    private func streamed(from source: DirectoryStore? = nil) throws -> [(number: Int64, label: String)] {
        var out: [(number: Int64, label: String)] = []
        try (source ?? store).streamEntries { number, label in out.append((number, label)) }
        return out
    }
}

private enum BodyFailure: Error, Equatable {
    case refused
}

// MARK: - Hand-built snapshot bytes

/// A snapshot assembled field by field, so a test can break exactly one thing.
/// Deliberately independent of `DirectoryStore`'s own writer: a parser checked
/// only against its own encoder proves nothing about a corrupt file.
private struct SnapshotBytes {
    var magic: [UInt8] = Array("CTID".utf8)
    var formatVersion: UInt32 = 1
    var directoryVersion: Int64 = 1
    var entryCount: UInt32 = 0
    var body: [UInt8] = []

    var data: Data {
        var out = Data(magic)
        out.append(contentsOf: littleEndianBytes(formatVersion))
        out.append(contentsOf: littleEndianBytes(directoryVersion))
        out.append(contentsOf: littleEndianBytes(entryCount))
        out.append(contentsOf: body)
        return out
    }
}

private func littleEndianBytes<T: FixedWidthInteger>(_ value: T) -> [UInt8] {
    withUnsafeBytes(of: value.littleEndian) { Array($0) }
}

private func snapshotRecord(_ number: Int64, _ label: String) -> [UInt8] {
    let bytes = Array(label.utf8)
    return snapshotRecord(number, labelLen: UInt16(bytes.count), labelBytes: bytes)
}

/// The length prefix and the bytes are separate on purpose: a lying length is
/// the corruption a streaming parser has to survive.
private func snapshotRecord(_ number: Int64, labelLen: UInt16, labelBytes: [UInt8]) -> [UInt8] {
    littleEndianBytes(number) + littleEndianBytes(labelLen) + labelBytes
}
