import Foundation
import Security

enum KeychainError: Error {
    case unexpectedStatus(OSStatus)
}

/// The paired device token — the long-lived bearer the phone sends on every
/// feed request — kept in the Keychain rather than UserDefaults.
///
/// `kSecAttrAccessibleAfterFirstUnlock` so a background refresh still works
/// while the phone is locked, but not before the user has unlocked it once
/// since boot. The Call Directory extension never reads this: it only ever
/// reads the App Group snapshot, so the item deliberately has no shared
/// access group.
enum DeviceTokenStore {
    private static let account = "device-token"

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: AppConfig.keychainService,
            kSecAttrAccount as String: account,
        ]
    }

    /// Stores the token, replacing any previous one (re-pairing a phone that
    /// was already paired must not leave the old token behind).
    static func save(_ token: String) throws {
        SecItemDelete(baseQuery as CFDictionary)

        var query = baseQuery
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }

    static func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
