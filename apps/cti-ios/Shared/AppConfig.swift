import Foundation

/// The handful of identifiers the app and the Call Directory extension must
/// agree on. Kept in one place because a typo in any of them fails silently:
/// a wrong App Group id makes the extension read an empty container, and a
/// wrong extension id makes `reloadExtension` reload nothing.
enum AppConfig {
    /// The CTI API. Fixed — the phone is not a place to type a server URL.
    static let baseURL = URL(string: "https://ctiapi-production.up.railway.app")!

    /// Shared container for the directory snapshot the extension reads.
    static let appGroupIdentifier = "group.com.gghomes.cti"

    /// The Call Directory extension's bundle id, for
    /// `CXCallDirectoryManager.reloadExtension(withIdentifier:)`.
    static let extensionBundleIdentifier = "com.gghomes.cti.callerid.directory"

    /// Must match `BGTaskSchedulerPermittedIdentifiers` in the app's Info.plist.
    static let backgroundRefreshTaskIdentifier = "com.gghomes.cti.callerid.refresh"

    /// Keychain service for the paired device token.
    static let keychainService = "com.gghomes.cti.callerid"

    /// `os.Logger` subsystem for code shared by the app and the extension.
    static let loggingSubsystem = "com.gghomes.cti.callerid"

    /// How long the background scheduler should wait before the next refresh.
    static let backgroundRefreshInterval: TimeInterval = 4 * 60 * 60

    /// The most entries the phone will write into the snapshot: a safety valve
    /// matching the server's publish cap (`MAX_DIRECTORY_ENTRIES` in
    /// services/cti-api/src/mobile/directory-build.ts), so a server that ever
    /// forgets its own cap cannot hand this phone an unbounded directory.
    ///
    /// This is NOT an extension-memory bound any more. `DirectoryStore` writes
    /// a binary snapshot the Call Directory extension STREAMS in fixed chunks,
    /// so the extension's footprint is O(chunk) regardless of entry count
    /// (measured: streaming 250,000 entries costs single-digit MB). What still
    /// bounds the number is reload-time practicality — CallKit has to ingest
    /// every entry on each reload — plus this valve. The live org publishes
    /// 149,800, comfortably inside it.
    ///
    /// Truncation keeps the ascending-lowest prefix, which preserves the
    /// strictly-ascending order CallKit requires.
    static let maxDirectoryEntries = 250_000
}
