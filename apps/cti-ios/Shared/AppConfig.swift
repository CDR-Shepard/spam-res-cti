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

    /// How long the background scheduler should wait before the next refresh.
    static let backgroundRefreshInterval: TimeInterval = 4 * 60 * 60
}
