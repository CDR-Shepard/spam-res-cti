// App/SessionTokenStore.swift — same shape as DeviceTokenStore, account "session-token".
import Foundation
import Security

/// What `SyncEngine` needs in order to clear the Salesforce session on
/// `unpair()`, and what `SignInFlow` needs in order to save/delete it —
/// small enough that a test can fake it without touching the Keychain.
protocol SessionTokenStoring {
    func load() -> String?
    func save(_ token: String) throws
    func delete() throws
}

struct SessionTokenStore: SessionTokenStoring {
    private static let account = "session-token"
    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: AppConfig.keychainService, kSecAttrAccount as String: account]
    }

    init() {}

    func save(_ token: String) throws {
        SecItemDelete(Self.baseQuery as CFDictionary)
        var q = Self.baseQuery
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }
    func load() -> String? {
        var q = Self.baseQuery; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let d = item as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    func delete() throws { SecItemDelete(Self.baseQuery as CFDictionary) }
}
