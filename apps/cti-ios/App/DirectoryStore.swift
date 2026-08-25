import Foundation

/// The directory snapshot as it sits on disk.
struct DirectorySnapshot: Codable, Equatable {
    let version: Int
    let entries: [DirectoryEntry]
}

/// The one file the app writes and the Call Directory extension reads: the
/// whole published directory, in the App Group container, replaced atomically.
///
/// The container is injected rather than looked up, so the same code the
/// extension runs is what the tests exercise — against a temp directory,
/// with no provisioned shared container needed on the simulator.
struct DirectoryStore {
    /// Where the snapshot lives. Exposed so tests can corrupt it on purpose.
    let fileURL: URL

    private let containerURL: URL
    private static let fileName = "caller-directory.json"

    init(containerURL: URL) {
        self.containerURL = containerURL
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

    /// Replaces the snapshot atomically: encode, write a temp file alongside
    /// it, then rename over the old one. A reader (the extension can run at
    /// any moment) therefore only ever opens a whole snapshot — never a
    /// half-written one.
    func save(version: Int, entries: [DirectoryEntry]) throws {
        let ordered = Self.ascending(entries)
        // The server already publishes ascending; the sort above is defensive,
        // and this pins the invariant the whole design rests on — every
        // reader, including CallKit, requires strictly ascending numbers.
        // Debug only: it checks `ascending`'s own postcondition, so tripping
        // it is a bug here, never bad data, and shipping builds must not die
        // over data they can simply refuse to load.
        #if DEBUG
        precondition(Self.isStrictlyAscending(ordered), "entries must be persisted strictly ascending")
        #endif

        let data = try JSONEncoder().encode(DirectorySnapshot(version: version, entries: ordered))
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: containerURL, withIntermediateDirectories: true)

        let temporaryURL = containerURL.appendingPathComponent("\(Self.fileName).\(UUID().uuidString).tmp")
        try data.write(to: temporaryURL)
        do {
            if fileManager.fileExists(atPath: fileURL.path) {
                _ = try fileManager.replaceItemAt(fileURL, withItemAt: temporaryURL)
            } else {
                try fileManager.moveItem(at: temporaryURL, to: fileURL)
            }
        } catch {
            // Never leave a stray temp file in the shared container behind a
            // failed rename.
            try? fileManager.removeItem(at: temporaryURL)
            throw error
        }
    }

    // MARK: - Reading

    /// The stored snapshot, or `nil` when there is nothing usable to read:
    /// no file yet, an unreadable/undecodable one, or one whose entries are
    /// not strictly ascending. Never throws and never traps — it runs inside
    /// the Call Directory extension, where a crash is a failed reload.
    func load() -> (version: Int, entries: [DirectoryEntry])? {
        guard let data = try? Data(contentsOf: fileURL),
              let snapshot = try? JSONDecoder().decode(DirectorySnapshot.self, from: data),
              Self.isStrictlyAscending(snapshot.entries) else {
            return nil
        }
        return (snapshot.version, snapshot.entries)
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
