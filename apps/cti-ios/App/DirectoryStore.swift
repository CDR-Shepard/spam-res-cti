import Foundation
import os

/// Why the snapshot could not be streamed. Every case means the same thing to
/// the extension — do not publish this file — but they are distinct so a log
/// line says which invariant a corrupt container actually broke.
enum DirectoryStoreError: Error, Equatable {
    /// The file is missing, or the read itself failed.
    case unreadable
    /// Short header, wrong magic, or a format version this build cannot parse.
    case badHeader
    /// A record's number or its label bytes cross the end of the file.
    case truncatedRecord
    /// A label's bytes are not valid UTF-8.
    case invalidLabel
    /// A number is not strictly greater than the one before it. CallKit
    /// rejects such a stream part-way through, so the parser refuses first.
    case notAscending
    /// The file ran out, on a record boundary, before the header's entryCount
    /// records had been read.
    case entryCountMismatch
    /// Bytes remain after the last record the header promised — either an
    /// entryCount smaller than what was written, or trailing garbage. The
    /// format has no footer, so anything there is something this build does
    /// not understand.
    case trailingBytes
    /// The snapshot could not be written (the container refused the file).
    case unwritable
}

/// The one file the app writes and the Call Directory extension reads: the
/// whole published directory, in the App Group container, replaced atomically.
///
/// The on-disk format is binary and little-endian throughout, so the extension
/// can STREAM it — the reason the entry ceiling is a quarter of a million and
/// not fifteen thousand. A JSON snapshot had to be decoded whole before the
/// first entry could be published, which cost ~0.5 KB of footprint per entry
/// against an app extension's ~12 MB budget; the format below is parsed in
/// fixed-size chunks and never materializes an entry array at all.
///
///   Header (`headerSize` bytes)
///     magic            4 bytes, "CTID"
///     formatVersion    UInt32, == `formatVersion`
///     directoryVersion Int64
///     entryCount       UInt32
///   Then exactly `entryCount` records, strictly ascending by number, deduped:
///     number           Int64  (the e164's digits — `phoneNumberValue`)
///     labelLen         UInt16
///     label            `labelLen` bytes of UTF-8
///   No footer. Anything after the last record is corruption.
///
/// The container is injected rather than looked up, so the same code the
/// extension runs is what the tests exercise — against a temp directory,
/// with no provisioned shared container needed on the simulator.
struct DirectoryStore {
    /// Where the snapshot lives. Exposed so tests can corrupt it on purpose.
    let fileURL: URL

    /// The most entries this store will write. Injectable so the cap's own
    /// tests cost a handful of rows instead of a quarter of a million;
    /// everything in the app takes `AppConfig.maxDirectoryEntries`.
    let maxEntries: Int

    private let containerURL: URL
    private static let fileName = "caller-directory.bin"
    private static let log = Logger(subsystem: AppConfig.loggingSubsystem, category: "DirectoryStore")

    // MARK: - The format

    private static let magic: [UInt8] = Array("CTID".utf8)
    private static let formatVersion: UInt32 = 1
    /// magic (4) + formatVersion (4) + directoryVersion (8) + entryCount (4).
    static let headerSize = 20
    /// number (8) + labelLen (2), before the label's own bytes.
    private static let recordPrefixSize = 10
    /// Read granularity. Big enough that a 250,000-entry file is a few
    /// thousand reads, small enough that the parser's live footprint is a
    /// rounding error against the extension's budget.
    private static let readChunkSize = 64 * 1024
    /// The writer flushes once its buffer passes this, so a whole directory is
    /// never held as one `Data`.
    private static let writeChunkSize = 64 * 1024

    init(containerURL: URL, maxEntries: Int = AppConfig.maxDirectoryEntries) {
        self.containerURL = containerURL
        self.maxEntries = maxEntries
        self.fileURL = containerURL.appendingPathComponent(Self.fileName)
    }

    /// The real store, in the shared container. `nil` when the App Group is
    /// missing from the entitlements — a build/provisioning fault, which the
    /// extension reports by cancelling rather than by publishing nothing.
    static func appGroup() -> DirectoryStore? {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: AppConfig.appGroupIdentifier) else {
            return nil
        }
        return DirectoryStore(containerURL: container)
    }

    // MARK: - Writing

    /// Replaces the snapshot atomically: write a temp file alongside it, then
    /// rename over the old one. A reader (the extension can run at any moment)
    /// therefore only ever opens a whole snapshot — never a half-written one.
    func save(version: Int, entries: [DirectoryEntry]) throws {
        let ordered = Self.capped(Self.ascending(entries), ceiling: maxEntries)
        // The server already publishes ascending; the sort above is defensive,
        // and this pins the invariant the whole design rests on — every
        // reader, including CallKit, requires strictly ascending numbers.
        // Debug only: it checks `ascending`'s own postcondition, so tripping
        // it is a bug here, never bad data, and shipping builds must not die
        // over data they can simply refuse to load.
        #if DEBUG
        precondition(Self.isStrictlyAscending(ordered), "entries must be persisted strictly ascending")
        #endif

        let fileManager = FileManager.default
        try fileManager.createDirectory(at: containerURL, withIntermediateDirectories: true)
        removeStrayTemporaryFiles(fileManager)

        let temporaryURL = containerURL.appendingPathComponent("\(Self.fileName).\(UUID().uuidString).tmp")
        do {
            try Self.writeSnapshot(version: version, entries: ordered, to: temporaryURL)
            if fileManager.fileExists(atPath: fileURL.path) {
                _ = try fileManager.replaceItemAt(fileURL, withItemAt: temporaryURL)
            } else {
                try fileManager.moveItem(at: temporaryURL, to: fileURL)
            }
        } catch {
            // Never leave a stray temp file in the shared container behind a
            // failed write or a failed rename.
            try? fileManager.removeItem(at: temporaryURL)
            throw error
        }
    }

    /// Header then records, flushed in chunks. Incremental on purpose: a
    /// single encode of the whole directory is the cost this format was
    /// introduced to remove, and paying it on the write side would just move
    /// the spike from the extension into the app.
    private static func writeSnapshot(version: Int, entries: [DirectoryEntry], to url: URL) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw DirectoryStoreError.unwritable
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }

        var buffer = Data()
        buffer.reserveCapacity(writeChunkSize + recordPrefixSize + Int(UInt16.max))
        buffer.append(contentsOf: magic)
        appendLittleEndian(formatVersion, to: &buffer)
        appendLittleEndian(Int64(version), to: &buffer)
        appendLittleEndian(UInt32(entries.count), to: &buffer)

        for entry in entries {
            let label = labelBytes(entry.label)
            appendLittleEndian(phoneNumberValue(entry.e164), to: &buffer)
            appendLittleEndian(UInt16(label.count), to: &buffer)
            buffer.append(contentsOf: label)
            if buffer.count >= writeChunkSize {
                try handle.write(contentsOf: buffer)
                buffer.removeAll(keepingCapacity: true)
            }
        }
        if !buffer.isEmpty {
            try handle.write(contentsOf: buffer)
        }
    }

    private static func appendLittleEndian<T: FixedWidthInteger>(_ value: T, to buffer: inout Data) {
        withUnsafeBytes(of: value.littleEndian) { buffer.append(contentsOf: $0) }
    }

    /// A label's UTF-8 bytes, bounded by the format's `UInt16` length field.
    /// Truncation (which no real Salesforce name reaches) backs off to a
    /// scalar boundary, so a bounded label is still decodable UTF-8 rather
    /// than a record the reader would have to reject.
    private static func labelBytes(_ label: String) -> [UInt8] {
        let utf8 = Array(label.utf8)
        guard utf8.count > Int(UInt16.max) else { return utf8 }
        var end = Int(UInt16.max)
        while end > 0 && (utf8[end] & 0xC0) == 0x80 { end -= 1 }
        return Array(utf8[0..<end])
    }

    /// Deletes temp files a PREVIOUS write left behind. The cleanup in `save`
    /// only runs when that write fails; a crash, a jetsam kill, or a phone
    /// that powers off mid-write skips it entirely, and nothing else ever
    /// sweeps the shared container — so each interruption strands a full copy
    /// of the directory in the App Group forever. Interrupted writes get more
    /// likely, not less, as the directory grows.
    ///
    /// Only files matching this store's own temp pattern are touched, and the
    /// sweep runs before the new temp file is created so it can never delete
    /// the write in progress.
    private func removeStrayTemporaryFiles(_ fileManager: FileManager) {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: containerURL,
            includingPropertiesForKeys: nil
        ) else { return }
        for url in contents where url.pathExtension == "tmp"
            && url.lastPathComponent.hasPrefix("\(Self.fileName).") {
            try? fileManager.removeItem(at: url)
            Self.log.notice("removed a stray snapshot temp file left by an interrupted write")
        }
    }

    // MARK: - Reading the header

    /// What the snapshot says about itself, without reading a single record —
    /// `headerSize` bytes, whatever the directory's size. `nil` when there is
    /// nothing usable to read: no file, a short one, wrong magic, or a format
    /// version this build does not know. Never throws and never traps: it runs
    /// inside the Call Directory extension, where a crash is a failed reload.
    ///
    /// A valid header is NOT a promise that the records behind it parse —
    /// only `streamEntries` can say that, and it re-validates the header
    /// itself rather than trusting a caller to have checked first.
    func loadHeader() -> (version: Int, entryCount: Int)? {
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return nil }
        defer { try? handle.close() }
        guard let bytes = try? handle.read(upToCount: Self.headerSize) else { return nil }
        return Self.decodeHeader(bytes)
    }

    private static func decodeHeader(_ data: Data?) -> (version: Int, entryCount: Int)? {
        guard let data, data.count == headerSize else { return nil }
        let bytes = [UInt8](data)
        guard Array(bytes[0..<4]) == magic else { return nil }
        guard littleEndian(UInt32.self, bytes, at: 4) == formatVersion else { return nil }
        let version = littleEndian(Int64.self, bytes, at: 8)
        let entryCount = littleEndian(UInt32.self, bytes, at: 16)
        return (Int(version), Int(entryCount))
    }

    private static func littleEndian<T: FixedWidthInteger>(_ type: T.Type, _ bytes: [UInt8], at offset: Int) -> T {
        var value = T.zero
        for i in stride(from: MemoryLayout<T>.size - 1, through: 0, by: -1) {
            value = (value << 8) | T(truncatingIfNeeded: bytes[offset + i])
        }
        return value
    }

    // MARK: - Streaming the records

    /// Hands every record to `body` in file order, holding only one read chunk
    /// at a time — never an entry array, and never the file. This is what lets
    /// the extension publish a directory far larger than its own memory
    /// budget.
    ///
    /// Throws, rather than yielding what it managed to parse, on any breach of
    /// the format: bad header, truncated record, a label that is not UTF-8, a
    /// number that does not exceed its predecessor, a record count that
    /// disagrees with the header, or bytes past the last record. The caller's
    /// only correct response is to abandon the whole reload — a partial stream
    /// published as a complete one is a directory of wrong labels, which is
    /// worse than no directory at all. An error thrown by `body` propagates
    /// unchanged for the same reason.
    func streamEntries(_ body: (Int64, String) throws -> Void) throws {
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else {
            throw DirectoryStoreError.unreadable
        }
        defer { try? handle.close() }

        guard let header = Self.decodeHeader(try Self.read(handle, Self.headerSize)) else {
            throw DirectoryStoreError.badHeader
        }

        var buffer: [UInt8] = []
        var cursor = 0
        var atEndOfFile = false
        var previous: Int64 = 0

        /// Pulls chunks until at least `count` unparsed bytes are buffered, or
        /// the file is exhausted. Compacting first keeps the buffer bounded by
        /// one chunk plus one record however long the stream runs.
        func fill(toAtLeast count: Int) throws {
            while buffer.count - cursor < count && !atEndOfFile {
                guard let chunk = try Self.read(handle, Self.readChunkSize), !chunk.isEmpty else {
                    atEndOfFile = true
                    break
                }
                if cursor > 0 {
                    buffer.removeFirst(cursor)
                    cursor = 0
                }
                buffer.append(contentsOf: chunk)
            }
        }

        for _ in 0..<header.entryCount {
            try fill(toAtLeast: Self.recordPrefixSize)
            guard buffer.count - cursor >= Self.recordPrefixSize else {
                // Nothing at all left is a header that over-promised; a
                // partial record is a file that was cut mid-write.
                throw buffer.count == cursor
                    ? DirectoryStoreError.entryCountMismatch
                    : DirectoryStoreError.truncatedRecord
            }
            let number = Self.littleEndian(Int64.self, buffer, at: cursor)
            let labelLength = Int(Self.littleEndian(UInt16.self, buffer, at: cursor + 8))
            cursor += Self.recordPrefixSize

            guard number > previous else { throw DirectoryStoreError.notAscending }
            previous = number

            try fill(toAtLeast: labelLength)
            guard buffer.count - cursor >= labelLength else {
                throw DirectoryStoreError.truncatedRecord
            }
            guard let label = String(bytes: buffer[cursor..<(cursor + labelLength)], encoding: .utf8) else {
                throw DirectoryStoreError.invalidLabel
            }
            cursor += labelLength

            try body(number, label)
        }

        try fill(toAtLeast: 1)
        guard buffer.count == cursor else { throw DirectoryStoreError.trailingBytes }
    }

    private static func read(_ handle: FileHandle, _ count: Int) throws -> Data? {
        do {
            return try handle.read(upToCount: count)
        } catch {
            throw DirectoryStoreError.unreadable
        }
    }

    // MARK: - Ordering

    /// `CXCallDirectoryPhoneNumber` is the e164's digits as an integer:
    /// "+16195550100" → 16195550100. Anything with no usable digits is 0,
    /// which `ascending` drops.
    static func phoneNumberValue(_ e164: String) -> Int64 {
        let digits = e164.filter { $0.isASCII && $0.isNumber }
        return Int64(digits) ?? 0
    }

    /// Sorted ascending by NUMERIC value — not by the e164 text, which stops
    /// tracking magnitude as soon as two numbers differ in digit count (as
    /// text "+15550000000" < "+25550000", numerically it is not). Matches the
    /// server's own `sortEntriesByDigits`. Entries with no usable number, and
    /// any second entry sharing a number with an earlier one, are dropped:
    /// CallKit rejects a non-ascending stream outright, so one bad row would
    /// otherwise cost the whole directory.
    static func ascending(_ entries: [DirectoryEntry]) -> [DirectoryEntry] {
        let usable: [RankedEntry] = entries.enumerated().compactMap { offset, entry in
            let value = phoneNumberValue(entry.e164)
            guard value > 0 else { return nil }
            return RankedEntry(index: offset, value: value, entry: entry)
        }
        // Swift's sort is not stable, so input order is the explicit
        // tiebreaker: of two rows sharing a number, the first one given wins,
        // deterministically.
        let sorted = usable.sorted { $0.value == $1.value ? $0.index < $1.index : $0.value < $1.value }

        var seen = Set<Int64>()
        return sorted.filter { seen.insert($0.value).inserted }.map(\.entry)
    }

    /// Trims an ascending directory to `ceiling` by keeping its lowest-numbered
    /// prefix. Truncating a sorted list from the end keeps it sorted, so
    /// CallKit's strictly-ascending requirement still holds.
    ///
    /// This is a safety valve, not a memory bound — streaming removed the
    /// memory bound. The server caps at the same number when it publishes
    /// (MAX_DIRECTORY_ENTRIES), so in practice it never fires; it is here so a
    /// server that ever forgets its own cap cannot hand the phone a directory
    /// whose CallKit reload takes longer than a reload has any business taking.
    static func capped(_ entries: [DirectoryEntry], ceiling: Int = AppConfig.maxDirectoryEntries) -> [DirectoryEntry] {
        guard entries.count > ceiling else { return entries }
        log.error(
            "directory of \(entries.count) entries exceeds the publish ceiling of \(ceiling); keeping the lowest-numbered ones"
        )
        return Array(entries.prefix(ceiling))
    }

    private struct RankedEntry {
        let index: Int
        let value: Int64
        let entry: DirectoryEntry
    }

    static func isStrictlyAscending(_ entries: [DirectoryEntry]) -> Bool {
        var previous: Int64 = 0
        for entry in entries {
            let value = phoneNumberValue(entry.e164)
            if value <= previous { return false }
            previous = value
        }
        return true
    }
}
