import CryptoKit
import Foundation
import Security
import UserNotifications

/// Matches apps/server/src/workers/push.ts and docs/RELAY_PROTOCOL.md §7.
final class NotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    guard let best = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      handler = nil
      return
    }
    content = best
    defer { finish() }
    guard let encoded = best.userInfo["enc"] as? String,
      let sealed = decodeBase64URL(encoded), sealed.count >= 28,
      let payload = decrypt(sealed) else { return }
    best.title = payload.title
    best.body = payload.body
    best.threadIdentifier = payload.target.botId
    best.categoryIdentifier = payload.kind == "approval" ? "openbots.approval" : "openbots.notice"
    // Only authenticated plaintext is forwarded to JS for navigation and actions.
    if let data = try? JSONEncoder().encode(payload),
      let object = try? JSONSerialization.jsonObject(with: data) {
      best.userInfo["openbots"] = object
    }
    if let avatar = avatarURL(payload),
      let attachment = try? UNNotificationAttachment(identifier: "bot-avatar", url: avatar) {
      best.attachments = [attachment]
    }
  }

  override func serviceExtensionTimeWillExpire() { finish() }

  private func finish() {
    guard let callback = handler, let best = content else { return }
    handler = nil
    callback(best)
  }

  private func decrypt(_ sealed: Data) -> PushPayload? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "OpenBotsKeychainAccessGroup") as? String else { return nil }
    let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
      kSecAttrService: "org.openbots.push.v1", kSecAttrAccessGroup: group,
      kSecAttrSynchronizable: false, kSecMatchLimit: kSecMatchLimitAll,
      kSecReturnAttributes: true, kSecReturnData: true]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let keys = result as? [[CFString: Any]],
      let box = try? ChaChaPoly.SealedBox(combined: sealed) else { return nil }
    // APNs intentionally has no unencrypted host identifier. Authenticate first,
    // then verify the payload belongs to the host whose key opened it.
    for item in keys.prefix(128) {
      guard let key = item[kSecValueData] as? Data, key.count == 32,
        let host = item[kSecAttrAccount] as? String,
        let plain = try? ChaChaPoly.open(box, using: SymmetricKey(data: key),
          authenticating: Data("openbots-push-v1".utf8)),
        let payload = try? JSONDecoder().decode(PushPayload.self, from: plain),
        payload.v == 1, payload.host == host, !payload.target.botId.isEmpty,
        ["approval", "question", "mention", "routine", "long_task"].contains(payload.kind),
        payload.title.utf8.count <= 4096, payload.body.utf8.count <= 16384 else { continue }
      return payload
    }
    return nil
  }

  private func decodeBase64URL(_ encoded: String) -> Data? {
    var value = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    value += String(repeating: "=", count: (4 - value.count % 4) % 4)
    return Data(base64Encoded: value)
  }

  private func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func avatarURL(_ payload: PushPayload) -> URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "OpenBotsAppGroup") as? String,
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
    let directory = root.appendingPathComponent("NotificationAvatars").appendingPathComponent(digest(payload.host))
    // UNNotificationAttachment takes ownership: copy, preserving the shared cache.
    for suffix in [".png", ".jpg"] {
      let cached = directory.appendingPathComponent(digest(payload.target.botId) + suffix)
      let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + suffix)
      if (try? FileManager.default.copyItem(at: cached, to: copy)) != nil { return copy }
    }
    return nil
  }
}

private struct PushPayload: Codable {
  let v: Int
  let kind: String
  let tag: String
  let title: String
  let body: String
  let target: Target
  let host: String
  struct Target: Codable {
    let botId: String
    let chatId: String?
    let seq: Int?
    let threadRootId: String?
  }
}
