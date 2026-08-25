import Foundation
import os

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
    private static let log = Logger(subsystem: AppConfig.loggingSubsystem, category: "DirectoryStore")

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
        let ordered = Self.capped(Self.ascending(entries))
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
        removeStrayTemporaryFiles(fileManager)

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

    /// Deletes temp files a PREVIOUS write left behind. The cleanup above only
    /// runs when the rename itself fails; a crash, a jetsam kill, or a phone
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

    // MARK: - Reading

    /// The stored snapshot, or `nil` when there is nothing usable to read:
    /// no file yet, an unreadable/undecodable one, or one whose entries are
    /// not strictly ascending. Never throws and never traps — it runs inside
    /// the Call Directory extension, where a crash is a failed reload.
    ///
    /// Capped on the way out as well as on the way in: `save` bounds what THIS
    /// build writes, but the extension reads whatever is in the container,
    /// including a file an older build left there. A bounded array is what the
    /// extension holds for the whole `addIdentificationEntry` stream, which is
    /// the part of the budget it can still do something about.
    func load() -> (version: Int, entries: [DirectoryEntry])? {
        guard let data = try? Data(contentsOf: fileURL),
              let snapshot = try? JSONDecoder().decode(DirectorySnapshot.self, from: data),
              Self.isStrictlyAscending(snapshot.entries) else {
            return nil
        }
        return (snapshot.version, Self.capped(snapshot.entries))
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

    /// Trims an ascending directory to `AppConfig.maxDirectoryEntries` by
    /// keeping its lowest-numbered prefix — the numbers the extension can
    /// actually publish before iOS jetsams it for exceeding the extension
    /// memory budget. Truncating a sorted list from the end keeps it sorted,
    /// so CallKit's strictly-ascending requirement still holds.
    ///
    /// The server caps the same way (MAX_DIRECTORY_ENTRIES), so in practice
    /// this never fires; it is here so a snapshot from an older build or an
    /// un-updated server cannot take the extension down silently.
    static func capped(_ entries: [DirectoryEntry]) -> [DirectoryEntry] {
        guard entries.count > AppConfig.maxDirectoryEntries else { return entries }
        log.error(
            "directory of \(entries.count) entries exceeds the Call Directory ceiling of \(AppConfig.maxDirectoryEntries); keeping the lowest-numbered ones"
        )
        return Array(entries.prefix(AppConfig.maxDirectoryEntries))
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
