import CryptoKit
import ExpoModulesCore
import Foundation
import Security

public final class OpenBotsNativeModule: Module {
  private let service = "org.openbots.push.v1"

  public func definition() -> ModuleDefinition {
    Name("OpenBotsNative")

    AsyncFunction("setPushKey") { (host: String, encoded: String) in
      guard !host.isEmpty, host.utf8.count <= 256,
        let bytes = self.decodeBase64URL(encoded), bytes.count == 32 else {
        throw NativeError.invalidKey
      }
      let query = try self.keyQuery(host)
      let status = SecItemUpdate(query as CFDictionary, [kSecValueData: bytes] as CFDictionary)
      if status == errSecItemNotFound {
        var item = query
        item[kSecValueData] = bytes
        // The extension must read this key while the phone is locked. All other
        // app credentials use WhenUnlockedThisDeviceOnly in SecureStore.
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
          throw NativeError.keychainWrite
        }
      } else if status != errSecSuccess {
        throw NativeError.keychainWrite
      }
    }

    AsyncFunction("removePushKey") { (host: String) in
      let status = SecItemDelete(try self.keyQuery(host) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw NativeError.keychainWrite
      }
      if let root = self.avatarRoot(host) { try? FileManager.default.removeItem(at: root) }
    }

    AsyncFunction("cacheNotificationAvatar") { (host: String, bot: String, base64: String) in
      guard let data = Data(base64Encoded: base64), data.count <= 1_048_576,
        (data.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || data.starts(with: [0xff, 0xd8, 0xff])),
        let root = self.avatarRoot(host) else { throw NativeError.invalidAvatar }
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let suffix = data.starts(with: [0xff, 0xd8, 0xff]) ? ".jpg" : ".png"
      let otherSuffix = suffix == ".jpg" ? ".png" : ".jpg"
      try? FileManager.default.removeItem(at: root.appendingPathComponent(self.digest(bot) + otherSuffix))
      let path = root.appendingPathComponent(self.digest(bot) + suffix)
      try data.write(to: path, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  private func keyQuery(_ host: String) throws -> [CFString: Any] {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "OpenBotsKeychainAccessGroup") as? String,
      !group.isEmpty, !group.contains("$(") else { throw NativeError.missingConfiguration }
    return [kSecClass: kSecClassGenericPassword, kSecAttrService: service,
      kSecAttrAccount: host, kSecAttrAccessGroup: group, kSecAttrSynchronizable: false]
  }

  private func decodeBase64URL(_ encoded: String) -> Data? {
    var text = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    text += String(repeating: "=", count: (4 - text.count % 4) % 4)
    return Data(base64Encoded: text)
  }

  private func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func avatarRoot(_ host: String) -> URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "OpenBotsAppGroup") as? String,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
    return container.appendingPathComponent("NotificationAvatars").appendingPathComponent(digest(host))
  }

  private enum NativeError: Error {
    case invalidKey, keychainWrite, missingConfiguration, invalidAvatar
  }
}
