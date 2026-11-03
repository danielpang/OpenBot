# OpenBots relay and tunnel protocol, version 1

What a client (the iOS app, the Node test client, later the Mac app) speaks to reach an OpenBots server through the private relay, and what the server speaks to the relay. Design background is in [MOBILE_AND_VM_PLAN.md](MOBILE_AND_VM_PLAN.md) sections 4 to 6; this document is the wire contract that `packages/tunnel`, `apps/relay` and `apps/server/src/relay` implement and test against.

Layers, outermost first:

1. **Relay** (section 3 and 4): two WebSocket endpoints. A server keeps an outbound _host link_; a client opens a _stream_ by host id. The relay pipes bytes and sees nothing inside them.
2. **Tunnel** (section 5): inside a stream, a Noise IK handshake, then encrypted _frames_ that carry HTTP requests, HTTP responses and WebSocket sockets to the server's ordinary API.
3. **Pairing and push** (sections 6 to 8): the link that enrols a device, the route that completes it, and the encrypted push payload.

Everything here is versioned by the `v` field or path segment; a change that breaks a client gets `v2`.

---

## 1. Encodings

| Thing              | Encoding                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary in JSON     | base64url without padding (RFC 4648 section 5), unless a field says hex                                                                                              |
| APNs device tokens | lower case hex                                                                                                                                                       |
| Integers           | JSON numbers; on the wire big-endian unsigned                                                                                                                        |
| Text               | UTF-8                                                                                                                                                                |
| `hostId`           | The first 26 characters of the lower case base32 (RFC 4648 alphabet `a-z2-7`, no padding) of `SHA-256(server Ed25519 public key)`. 130 bits, enough to never collide |
| Close codes        | WebSocket close codes. 1000 to 1015 as the RFC; 4400 to 4499 as in section 9                                                                                         |

## 2. Identities

| Key                | Who holds it                                                                                                                                                                                                                                                     | Used for                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Server signing key | The server, an Ed25519 pair made at first start (`instance_keys`, sealed with the master key)                                                                                                                                                                    | Proving the host identity to the relay (3.1). Its public key hashes to `hostId`                                     |
| Server tunnel key  | Derived from the signing key: the X25519 pair from the Ed25519 pair (libsodium's `crypto_sign_ed25519_pk_to_curve25519` and `_sk_`; `@noble/curves` 2.x `ed25519.utils.toMontgomery` and `toMontgomerySecret`, named `edwardsToMontgomeryPub` and `Priv` in 1.x) | The Noise static key `s` on the server side. Its public key is the `key` in the pairing link, which the client pins |
| Device static key  | The client, an X25519 pair made at pairing and kept in the Keychain                                                                                                                                                                                              | The Noise static key `s` on the client side. The server records its public key in `devices.public_key` at pairing   |
| Device API key     | Made by the server at pairing (`obk_...`), kept by the client                                                                                                                                                                                                    | `Authorization: Bearer` on every request, over the tunnel and over direct https alike                               |
| Push key           | Made by the client at pairing, 32 random bytes, sent in the pairing request, sealed in `devices.push_key`, shared with the notification extension                                                                                                                | ChaCha20-Poly1305 key for push payloads (section 7)                                                                 |

A pairing is the only time a key is created; nothing here rotates one. Revoking a device deletes its API key and forgets its static key and push key; a revoked device's static key may pair again.

---

## 3. Relay: the host link

`GET /v1/host`, a WebSocket upgrade from the server to the relay. Text frames are JSON objects with a `type`; binary frames carry stream data. The relay never sends a binary frame before `linked` and refuses one from an unlinked host (close 4400).

### 3.1 Linking

| Step | Direction    | Frame                                                                                                                                                                                                                                                              |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | relay → host | `{"type":"challenge","v":1,"nonce":"<32 random bytes>"}` at once on open                                                                                                                                                                                           |
| 2    | host → relay | `{"type":"hello","v":1,"hostId":"...","publicKey":"<Ed25519 public key, 32 bytes>","sig":"<Ed25519 signature>","capabilities":["streams","push"]}` within 10 seconds. `sig` signs the UTF-8 bytes of `openbots-relay-host-v1\n` followed by the 32 raw nonce bytes |
| 3    | relay → host | `{"type":"linked","v":1,"hostId":"..."}`; or a close: 4401 when the signature does not verify or `hostId` is not the hash of `publicKey`, 4400 when the frame is malformed or late                                                                                 |

A protocol error on the link is announced with an `error` frame (3.4) before the close: code `unauthorized` before 4401. A `publicKey` that is not 32 bytes or a `sig` that is not 64 bytes is malformed (4400); a well-formed `hostId` that is not the hash of the key is 4401. Unknown capabilities are ignored.

`capabilities` says what this link serves. `streams`: the relay may open client streams on it (an API process). `push`: the host may send `push` frames (any process). A host may keep several links at once (one per API or worker process); the relay opens each new stream on one `streams` link in turn.

### 3.2 Streams

| Direction    | Frame                                                              | Meaning                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| relay → host | `{"type":"open","stream":<u32>,"remote":"<client address>"}`       | A client connected (section 4). Stream ids are unique per link while the link lives                                                                                                                         |
| both         | binary: `[stream id: u32 big-endian][payload]`                     | The stream's bytes. One frame carries one payload, at most 65,536 bytes; the relay forwards it as one binary frame to the client and the client's binary frames as one each to the host                     |
| both         | `{"type":"close","stream":<u32>,"code":<int>,"reason":"<string>"}` | Either end closes the stream. The relay closes the client's socket with that code (1000, or 4000 to 4999) and reason (at most 123 bytes). A client's own close arrives as this frame with the client's code |

Data for an unknown or closed stream is dropped. After `close` nothing more is sent for that id. A host `close` with a code outside 1000 and 4000 to 4999, or a reason over 123 bytes, is a malformed frame (`error`, then 4400). The code a host sees for a client's own close is what the client's socket reported, which may be 1005 or 1006; when the relay closes a client itself (a text frame, 4400; an oversized frame, 1009; a full send buffer, 1008) the host gets `close` with that code.

### 3.3 Push

| Direction    | Frame                                                                                                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| host → relay | `{"type":"push","id":"<string>","platform":"ios","token":"<hex>","ciphertext":"<base64url>","collapseId":"<string, at most 64 bytes>","priority":10 or 5,"expiresAt":<unix seconds>,"threadId":"<string>"}`                                                                                                           |
| relay → host | `{"type":"push.result","id":"<the same id>","ok":true}` or `{"type":"push.result","id":"...","ok":false,"reason":"unregistered" / "unavailable" / "invalid" / "error","status":<APNs HTTP status or null>}`. `unregistered` (APNs 410) means forget the token; `unavailable` means this relay has no APNs credentials |

`collapseId` and `threadId` are optional. Checks run in this order: the frame's shape (a `push` with a string `id` that fails the schema gets `push.result` with `reason: "invalid"` and `status: null`, and the link stays up; one without an `id`, or on a link that did not offer `push`, is a protocol error and closes the link 4400), then the hourly limit (3.4), then the credentials. A relay with no credentials still counts the push against the limit.

The relay sends to APNs with token-based authentication (the project's `.p8` key) the body `{"aps":{"alert":{"title":"OpenBots","body":"You have a notification"},"mutable-content":1,"thread-id":"<threadId>"},"enc":"<ciphertext>"}` and the headers `apns-push-type: alert`, `apns-priority`, `apns-expiration`, `apns-collapse-id`, `apns-topic` (the app's bundle id). The relay keeps no tokens and logs counts only.

### 3.4 Keepalive, errors and limits

- The relay pings every 25 seconds; a link without a pong for 50 seconds is closed 1001. A host may ping too. The relay pings client sockets the same way and terminates one that misses its pong, so a phone that lost its network does not hold a stream slot.
- `{"type":"error","code":"<string>","message":"<string>"}` precedes a close for a protocol error.
- Frames: a binary frame of more than 65,540 bytes closes the link 1009. A text frame of more than 64 KiB closes it 1009.
- Per host, across its links: 8 open streams (a ninth client is closed 4429), 1,000 stream opens an hour (4429), 50 MB (50,000,000 bytes of payload, the prefix not counted) a minute of stream data in either direction (the link that carried the excess is closed 1008), 600 push frames an hour (`push.result` with `reason: "error"` and `status: 429`). The counters are fixed windows kept per host, so relinking does not reset them; an open counts only when it succeeds. A link or a client socket whose send buffer passes 8 MiB is closed 1008 (the host then gets `close` for that stream).
- An unexpected error inside the relay while handling a host frame closes that link 1011. When the relay shuts down it closes every client, then every link, with 1001.

### 3.5 Presence

`GET /v1/hosts/{hostId}` answers `{"hostId":"...","linked":true or false}` with 200 (404 for a malformed id); `linked` is true when at least one `streams` link is up. A client uses it to say "your server is offline" before trying a stream. `GET /healthz` answers 200 when the relay is up. The relay listens on port 3200 by default (`RELAY_PORT`) and is put behind a TLS terminator.

---

## 4. Relay: the client stream

`GET /v1/connect/{hostId}`, a WebSocket upgrade from a client to the relay.

| Case                                  | What happens                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The host has a `streams` link         | The relay sends the text frame `{"type":"open","v":1}`. From then on every binary frame the client sends goes to the host as that stream's payload, and every payload from the host arrives as one binary frame. The client sends no text frames |
| No such link                          | Close 4404, reason `host offline`                                                                                                                                                                                                                |
| Too many streams                      | Close 4429                                                                                                                                                                                                                                       |
| Malformed `hostId`                    | The upgrade is accepted, then closed 4400                                                                                                                                                                                                        |
| A text frame from the client          | Close 4400; a client sends binary frames only                                                                                                                                                                                                    |
| The client's send buffer passes 8 MiB | Close 1008                                                                                                                                                                                                                                       |
| The relay shuts down                  | Close 1001                                                                                                                                                                                                                                       |
| The host closes the stream            | The client's socket closes with the host's code and reason                                                                                                                                                                                       |
| The host link drops                   | Close 4410, reason `host gone`                                                                                                                                                                                                                   |

The client never learns which link served it. Binary frames are at most 65,536 bytes.

---

## 5. Tunnel: inside a stream

### 5.1 Handshake

`Noise_IK_25519_ChaChaPoly_SHA256` (Noise protocol framework revision 34). Prologue: the UTF-8 bytes of `openbots-tunnel-v1`. The client is the initiator; its `rs` is the server tunnel key from the pairing link and its `s` is the device static key.

| Message | Direction       | Frame                                                                                                          |
| ------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| 1       | client → server | One binary frame: the IK first message (`e, es, s, ss`) with the payload `{"v":1}` as UTF-8 JSON               |
| 2       | server → client | One binary frame: the IK second message (`e, ee, se`) with the payload `{"v":1,"device":"known" or "unknown"}` |

Then both sides hold two CipherStates (one per direction, as Noise's `Split` gives them). Each later binary frame is one Noise transport message: the ciphertext of one plaintext frame (5.2) and its 16 byte tag, so a plaintext frame is at most 61,440 bytes. Nonces are Noise's counters; a direction that reaches 2^32 messages closes the stream 4400. No rekey in version 1.

`device: "unknown"` means the server has no device with the client's static key (never paired, or revoked). The stream stays open for pairing only: the server answers every request and `ws.open` but a `POST /api/v1/devices/pair` with `http.res` 403 and the problem `{"code":"DEVICE_UNKNOWN"}`. A pairing that succeeds on that stream promotes it: the server looks the key up again before it sends that `http.res`, so the next request is served, and the client may mark itself known when the 200 arrives.

Either side closes the stream 4400 when the handshake does not complete within 10 seconds, when a handshake payload is not `{"v":1}` (or lacks `device` in message 2), or when the server cannot look the key up. 4400 is used because the relay passes only 1000 and 4000 to 4999 through to the client.

A direct https connection has no handshake and no frames: the client calls the API as any caller, with the device API key.

### 5.2 Frames

One plaintext frame:

```text
u8   type
u32  id        big-endian; the request or socket; 0 for the stream itself
u8   flags     bit 0 END (the last chunk), bit 1 TEXT (a text WebSocket message)
u16  hlen      big-endian; the JSON header's byte length, 0 for none, at most 16,384
hlen JSON header: a UTF-8 object
...  body      the rest of the frame
```

The client picks ids for what it opens: odd numbers from 1, never reused within a stream. Even ids are reserved for the server (unused in version 1). Id 0 carries `ping`, `pong` and stream-level `error`.

| Type   | Name      | Direction       | Header                                                       | Body and flags                                                                                                                                                                                                                                 |
| ------ | --------- | --------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x01` | http.req  | client → server | `{"method":"GET","path":"/api/v1/bots?x=1","headers":{...}}` | May carry the first body chunk. END when the request has no body at all; otherwise the body follows in `http.body` frames, the last one END (an empty END frame is fine). A receiver accepts both shapes                                       |
| `0x02` | http.body | both            | none                                                         | A body chunk. END on the last. Used for request bodies after `http.req` and response bodies after `http.res`                                                                                                                                   |
| `0x03` | http.res  | server → client | `{"status":200,"headers":{...}}`                             | As `http.req`: END when there is no body, else `http.body` frames follow. The reference server never puts body bytes in this frame, so headers are never held back on a streaming response. A 1xx status is a protocol error                   |
| `0x10` | ws.open   | client → server | `{"path":"/ws","headers":{...}}`                             | Empty                                                                                                                                                                                                                                          |
| `0x11` | ws.opened | server → client | `{"headers":{...}}`                                          | Empty. A refused upgrade is answered as an ordinary response instead: `http.res` with the status, then any body in `http.body`, END on the last                                                                                                |
| `0x12` | ws.msg    | both            | none                                                         | One WebSocket message, or a fragment of one: a message larger than a frame's body is split across `ws.msg` frames, END on the last fragment, TEXT on every fragment of a text message. The receiver reassembles up to 16 MiB, else `too_large` |
| `0x13` | ws.close  | both            | `{"code":1000,"reason":""}`                                  | Empty. Each side sends one; the socket is gone after both. A code valid in an RFC 6455 close frame passes through; any other becomes 1000. The receiver echoes the code it got                                                                 |
| `0x20` | credit    | both            | `{"bytes":<int>}`                                            | Flow control (5.3)                                                                                                                                                                                                                             |
| `0x30` | ping      | both            | `{"ts":<ms>}`                                                | Id 0. Answered with pong carrying the same header                                                                                                                                                                                              |
| `0x31` | pong      | both            | `{"ts":<ms>}`                                                | Id 0                                                                                                                                                                                                                                           |
| `0x3F` | error     | both            | `{"code":"<string>","message":"<string>"}`                   | On id 0 the whole stream is failed and then closed. On another id that request or socket is aborted; nothing more is sent for it. A client cancels a request with `code: "cancelled"`                                                          |

A `path` is a path and query on the server and nothing else: one leading `/`, no scheme or host (so never `//`), no backslash, whitespace or control character; anything else is a `protocol` error, so a frame cannot point the server's adapter at another host. Header values are strings; header names are lower case. A frame with an unknown type, an unknown flag bit, a bad header, a never-opened, reused or even id from the client, or a `credit` that would open a window past its size is a stream-level `error` with code `protocol`, then a close. Frames for an id that was open and has since closed (a late chunk after a cancel, a credit after completion) are dropped without error.

An HTTP id is open from `http.req` until END has gone both ways or an error ends it; a socket id from `ws.open` until each side has sent and received `ws.close`. When the server answers before the request body has ended, it keeps the id open, discards the rest of the body and still credits it, so the client's upload finishes and the id is freed.

### 5.3 Flow control and limits

- Each id has a window per direction, 1,048,576 bytes at open, counting the body bytes of `http.req`, `http.body`, `http.res` and `ws.msg`. A sender never exceeds the window; a receiver sends `credit` with the bytes it has consumed to reopen it. Headers do not count.
- At most 64 open ids per stream; a 65th gets `error` with code `too_many_requests` on that id.
- A request body of more than 16 MiB (the files limit) gets `error` with code `too_large`.
- A stream idle for 60 seconds with no frame at all, pings included, may be closed by either side with 1000.
- Any frame on a stream whose Noise counter would overflow closes it (5.1).

### 5.4 What the server does with a frame

A `http.req` becomes a request to the server's own HTTP port on loopback, as any caller: the frame's headers pass through, less `host`, `cookie`, `origin`, `sec-fetch-*`, `x-forwarded-*`, `connection`, `upgrade`, `content-length` and `transfer-encoding`, which the adapter sets itself. The tunnel drops a client-sent `x-openbots-device`; the adapter adds `x-openbots-device: <device id>` for a known device, or `stream:<relay stream id>` for an unknown one, which the server's rate limits key on for loopback requests, and on a `POST /api/v1/devices/pair` also `x-openbots-device-key: <the session's client static key, base64url>`, which the route compares with the body's `publicKey`. Both headers are honoured only from loopback and only beside `x-openbots-adapter`, a secret the adapter makes at each start and adds to every request; the adapter drops a client-sent copy, so neither a tunneled request nor another program on the host can name a device. A `ws.open` becomes a WebSocket connection to the same port and path with the same header rules, so `/ws`, `/computer/pty` and `/bots/{id}/screen/vnc` work as they do for any client. The response's headers pass back less `set-cookie`, `connection`, `transfer-encoding` and `content-length`.

So the API, its authentication (the device's bearer key), its ownership checks, rate limits and audit apply unchanged. A tunneled request without a bearer key gets 401 like any other.

---

## 6. Pairing

### 6.1 The pairing link

```text
openbots://pair#v=1&host=<hostId>&key=<server tunnel key, base64url>&code=<32 random bytes, base64url>
     &relay=<wss url, percent-encoded>&direct=<https url, percent-encoded>&name=<percent-encoded>&setup=1
```

The fragment is `key=value` pairs joined by `&`, each value percent-encoded as `encodeURIComponent` does (a space is `%20`, never `+`). `direct` may repeat and may be absent (the Mac app's This Mac stack lists none). `relay` is absent when the server has no relay configured, in which case `direct` is the only way in. `setup=1` is present only while the server has no owner (V2). `name` is the server's own name for the hosts list (`openbots pair --name` sets it). The same fragment may later ride on a universal link; a fragment never reaches a web server.

The link is good for 5 minutes and works once. It is shown as a QR code by `POST /api/v1/devices/pairings` (the web app's Settings > Devices, the Mac app's "Pair your phone…") and by `openbots pair` in the server image.

### 6.2 The exchange

1. The client makes an X25519 static key and a 32 byte push key.
2. Over the relay: it opens a stream to `host`, runs the handshake (5.1) with `rs` = `key`. The server answers `device: "unknown"`. Over a direct address: it skips this step; https stands in for the handshake, and the address must be https (http only on a private network, with a warning in the client).
3. It sends `POST /api/v1/devices/pair` (6.3). The server answers the device, its API key and the owner.
4. It keeps the API key, the static key and the push key in the Keychain, then calls `PUT /api/v1/devices/{id}/push` once it has an APNs token.

### 6.3 `POST /api/v1/devices/pair`

No authentication. Rate-limited per client address like sign-in (10 an hour) and 5 tries an hour per code, after which the code is dead.

Request body:

```json
{
  "code": "<base64url, from the link>",
  "name": "Daniel's iPhone",
  "platform": "ios",
  "publicKey": "<device X25519 public key, base64url>",
  "pushKey": "<32 bytes, base64url>",
  "ownerName": "Daniel"
}
```

`platform` is `ios`, `android` or `desktop`. Over the tunnel `publicKey` must equal the static key of the handshake; a mismatch is 400 `PAIRING_KEY_MISMATCH`. `ownerName` is used only on a server with no owner (V2; the link said `setup=1`).

Response, 200:

```json
{
  "device": { "id": "<uuid>", "name": "Daniel's iPhone", "platform": "ios", "createdAt": "<iso>" },
  "key": "obk_...",
  "owner": { "id": "<uuid>", "name": "Daniel" },
  "setupNeeded": true
}
```

`key` is shown once. `setupNeeded` is true while the server has no model provider or no Bot, so the client runs the first-run steps with the ordinary routes (`POST /providers`, `POST /bots`). Errors: 401 `PAIRING_INVALID` (unknown, used or expired code, with no detail which), 400 `PAIRING_KEY_MISMATCH`, 409 `DEVICE_ALREADY_PAIRED` (an unrevoked device already holds that `publicKey`; the code is not spent), 429 when a limit is hit.

### 6.4 The device's routes

| Route                           | Caller                     | Answer                                                                                                                                                                                                     |
| ------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/devices/pairings` | A signed-in user           | `{"id","expiresAt","link","qr":{"v":1,"host","key","code","relay","direct":[...],"name","setup"}}`. Body: `{"name"?: string, "direct"?: string[]}`. 409 `TOO_MANY_PAIRINGS` past 5 open pairings per owner |
| `GET /api/v1/devices`           | A signed-in user or device | `{"items":[{"id","name","platform","createdAt","lastSeenAt","pushRegistered"}]}`, revoked devices left out                                                                                                 |
| `DELETE /api/v1/devices/{id}`   | A signed-in user or device | 204. The key stops working at once, its streams close, its push token is forgotten                                                                                                                         |
| `PUT /api/v1/devices/{id}/push` | That device only           | Body `{"token":"<hex>","environment":"production" or "sandbox"}`. 204; 403 `NOT_THIS_DEVICE` from any other caller                                                                                         |
| `GET /api/v1/relay`             | A signed-in user or device | `{"hostId","relayUrl","status":"off" / "connecting" / "linked","since"}`                                                                                                                                   |

Events on `/ws`: `device.paired` and `device.revoked` with `{"device":{...}}`, scoped to the owner. A device's API key is an ordinary API key with the owner's permissions; `GET /api/v1/api-keys` leaves device keys out and `DELETE /api/v1/api-keys/{id}` answers 404 for one, so only `DELETE /devices/{id}` removes a device. `GET /api/v1/capabilities` reports `relay: true` when the server has a relay configured.

---

## 7. Push payload

The server encrypts each notice for the device; the relay and Apple see only the generic alert.

Plaintext, UTF-8 JSON:

```json
{
  "v": 1,
  "kind": "approval",
  "tag": "approval:<id>",
  "title": "Researcher needs approval",
  "body": "bash: rm -rf build",
  "target": { "botId": "<uuid>", "chatId": "<uuid>", "seq": 412, "threadRootId": null },
  "host": "<hostId>"
}
```

`kind` is one of `approval`, `question`, `mention`, `routine`, `long_task` (the notice kinds in `packages/shared/src/notices.ts`). `tag` is the notice's tag and the APNs collapse id. `target` is what the deep link `openbots://bot/{botId}/message/{seq}` needs.

Encryption: ChaCha20-Poly1305 (RFC 8439, 96 bit nonce) under the device's push key, with the associated data the UTF-8 bytes of `openbots-push-v1`. `ciphertext` is `base64url(nonce (12 bytes) || ciphertext || tag (16 bytes))`. Apple's CryptoKit opens it as a `ChaChaPoly.SealedBox` with that AAD.

Priority 10 for `approval` and `question`, 5 for the rest; `expiresAt` one day ahead; `threadId` the Bot id.

---

## 8. Errors

Problems from the API are its usual JSON problems (`{"code","message"}`). Codes added by this protocol:

| Code                     | Where                                           | Meaning                                                                                                          |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PAIRING_INVALID`        | `POST /devices/pair`, 401                       | The code is unknown, used or expired                                                                             |
| `PAIRING_KEY_MISMATCH`   | `POST /devices/pair`, 400                       | `publicKey` is not the handshake's static key                                                                    |
| `DEVICE_UNKNOWN`         | Any tunneled request, 403                       | The stream's device is not paired; only pairing is served                                                        |
| `DEVICE_REVOKED`         | Any request, 401                                | The device was revoked (its key is gone; a plain 401 from the API)                                               |
| `DEVICE_ALREADY_PAIRED`  | `POST /devices/pair`, 409                       | An unrevoked device already holds that static key                                                                |
| `TOO_MANY_PAIRINGS`      | `POST /devices/pairings`, 409                   | Five pairings are already open for this owner                                                                    |
| `DEVICE_KEY_NOT_ALLOWED` | `POST /api-keys`, `POST /devices/pairings`, 403 | A device key cannot make API keys or pairings, so a stolen phone cannot leave a credential behind its revocation |
| `NOT_THIS_DEVICE`        | `PUT /devices/{id}/push`, 403                   | The caller is not that device                                                                                    |

Tunnel `error` frame codes: `protocol`, `too_many_requests`, `too_large`, `cancelled`, `internal`.

## 9. Close codes

| Code       | Where         | Meaning                                                                                  |
| ---------- | ------------- | ---------------------------------------------------------------------------------------- |
| 1000       | anywhere      | Normal close                                                                             |
| 1001       | relay         | Keepalive missed                                                                         |
| 1008       | relay         | A limit was hit (bytes, send buffer)                                                     |
| 1009       | relay         | A frame too large                                                                        |
| 1011       | relay         | An unexpected error inside the relay                                                     |
| 1005, 1006 | relay         | What a host sees when a client's socket went away without a close frame                  |
| 4400       | relay, tunnel | Malformed frame, bad `hostId`, protocol error                                            |
| 4401       | relay         | The host's signature did not verify                                                      |
| 4404       | relay         | The host is offline                                                                      |
| 4410       | relay         | The host link dropped while the stream was open                                          |
| 4403       | tunnel        | The server closed the stream because its device was revoked                              |
| 4429       | relay, tunnel | Too many streams or opens; the server also closes a ninth stream on one instance with it |
