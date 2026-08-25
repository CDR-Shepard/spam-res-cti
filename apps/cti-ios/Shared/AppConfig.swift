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

    /// The most entries that may reach the Call Directory extension.
    ///
    /// The extension decodes the whole snapshot before streaming it, and app
    /// extensions run on a ~12 MB budget. Measured against this snapshot type,
    /// footprint is ~0.5 KB per entry (20,000 entries → 9.5 MB; 100,000 →
    /// 49.7 MB), so the breach point is roughly 15–20k with the extension's own
    /// CallKit/Foundation baseline counted. Past it the extension is jetsammed
    /// mid-stream: no label ever appears and the rep cannot tell that from the
    /// switch being off.
    ///
    /// The server enforces the same number when it publishes
    /// (`MAX_DIRECTORY_ENTRIES` in services/cti-api/src/mobile/directory-build.ts).
    /// This is the phone's own belt-and-braces: a snapshot written by an older
    /// build, or by a server that has not been updated, still cannot take the
    /// extension down. Truncation keeps the ascending-lowest prefix, which
    /// preserves the strictly-ascending order CallKit requires.
    static let maxDirectoryEntries = 15_000
}
