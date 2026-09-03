// App/SessionTokenStore.swift — same shape as DeviceTokenStore, account "session-token".
import Foundation
import Security

enum SessionTokenStore {
    private static let account = "session-token"
    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: AppConfig.keychainService, kSecAttrAccount as String: account]
    }
    static func save(_ token: String) throws {
        SecItemDelete(baseQuery as CFDictionary)
        var q = baseQuery
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }
    static func load() -> String? {
        var q = baseQuery; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let d = item as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func delete() { SecItemDelete(baseQuery as CFDictionary) }
}
