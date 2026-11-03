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

A pairing is the only time a key is created; nothing here rotates one. Revoking a device marks it revoked and forgets its static key, push key and push token, then deletes its API key (6.4); a revoked device's static key may pair again.

---

## 3. Relay: the host link

`GET /v1/host?hostId=<hostId>`, a WebSocket upgrade from the server to the relay. The `hostId` query parameter is required: an upgrade without it, or with a malformed one, is refused with HTTP 400 before any frame. It names the host the link will prove in its `hello`, so a relay of several machines can send the upgrade to the machine that owns the host before it is accepted (section 4). Text frames are JSON objects with a `type`; binary frames carry stream data. The relay never sends a binary frame before `linked` and refuses one from an unlinked host (close 4400).

### 3.1 Linking

| Step | Direction    | Frame                                                                                                                                                                                                                                                                                  |
| ---- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | relay → host | `{"type":"challenge","v":1,"nonce":"<32 random bytes>"}` at once on open                                                                                                                                                                                                               |
| 2    | host → relay | `{"type":"hello","v":1,"hostId":"...","publicKey":"<Ed25519 public key, 32 bytes>","sig":"<Ed25519 signature>","capabilities":["streams","push"]}` within 10 seconds. `sig` signs the UTF-8 bytes of `openbots-relay-host-v1\n` followed by the 32 raw nonce bytes                     |
| 3    | relay → host | `{"type":"linked","v":1,"hostId":"..."}`; or a close: 4401 when the signature does not verify, `hostId` is not the hash of `publicKey`, or `hostId` is not the one in the URL; 4400 when the frame is malformed or late; 1012 when this relay machine cannot take the host (section 4) |

A protocol error on the link is announced with an `error` frame (3.4) before the close: code `unauthorized` before 4401. Between `hello` and `linked` the relay machine takes the host's lease (section 4), so the host sends nothing else until `linked`; a frame in that time is a protocol error (4400). A `publicKey` that is not 32 bytes, a `sig` that is not 64 bytes, or a `hostId` that is not a host id (1) is malformed (4400); a well-formed `hostId` that is not the hash of the key is 4401. A link whose lease the relay machine has not taken within 10 seconds of its `hello` (its registry is slow) is closed 1012, and the host reconnects. Unknown capabilities are ignored.

`capabilities` says what this link serves. `streams`: the relay may open client streams on it (an API process). `push`: the host may send `push` frames (any process). A host may keep several links at once (one per API or worker process); the relay opens each new stream on one `streams` link in turn.

### 3.2 Streams

| Direction    | Frame                                                              | Meaning                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| relay → host | `{"type":"open","stream":<u32>,"remote":"<client address>"}`       | A client connected (section 4). Stream ids are unique per link while the link lives                                                                                                                         |
| both         | binary: `[stream id: u32 big-endian][payload]`                     | The stream's bytes. One frame carries one payload, at most 65,536 bytes; the relay forwards it as one binary frame to the client and the client's binary frames as one each to the host                     |
| both         | `{"type":"close","stream":<u32>,"code":<int>,"reason":"<string>"}` | Either end closes the stream. The relay closes the client's socket with that code (1000, or 4000 to 4999) and reason (at most 123 bytes). A client's own close arrives as this frame with the client's code |

Data for an unknown or closed stream is dropped. After `close` nothing more is sent for that id. A host `close` with a code outside 1000 and 4000 to 4999, or a reason over 123 bytes, is a malformed frame (`error`, then 4400). The code a host sees for a client's own close is what the client's socket reported, which may be 1005 or 1006; when the relay closes a client itself (a text frame, 4400; an oversized frame, 1009; a full send buffer or a byte limit, 1008; no payload within 5 seconds of `open`, 4400; past the host's opens of the hour, 4429) the host gets `close` with that code.

### 3.3 Push

| Direction    | Frame                                                                                                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| host → relay | `{"type":"push","id":"<string>","platform":"ios","token":"<hex>","environment":"production" or "sandbox","ciphertext":"<base64url>","collapseId":"<string, at most 64 bytes>","priority":10 or 5,"expiresAt":<unix seconds>,"threadId":"<string>"}`                                                                   |
| relay → host | `{"type":"push.result","id":"<the same id>","ok":true}` or `{"type":"push.result","id":"...","ok":false,"reason":"unregistered" / "unavailable" / "invalid" / "error","status":<APNs HTTP status or null>}`. `unregistered` (APNs 410) means forget the token; `unavailable` means this relay has no APNs credentials |

`collapseId`, `threadId` and `environment` are optional. `environment` is the APNs environment the device registered its token in (the `environment` of `PUT /devices/{id}/push`, 6.4): `production` for App Store and TestFlight builds, `sandbox` for development builds. It defaults to `production`, so a server that does not send it keeps working for App Store devices. The relay sends each push to that environment's gateway and keeps one connection and one provider token per environment.

The reasons, and what the host does with each:

| `reason`       | `status`            | Meaning                                                                                                                                          | The host                         |
| -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `unregistered` | 410                 | APNs no longer knows the token                                                                                                                   | Forgets the token                |
| `invalid`      | 400                 | APNs refused the token itself (`BadDeviceToken`, `DeviceTokenNotForTopic`): a token from another app or environment                              | Forgets the token                |
| `invalid`      | null                | The `push` frame did not parse; the token is not at fault                                                                                        | Keeps the token, logs the push   |
| `unavailable`  | null                | This relay has no APNs credentials                                                                                                               | Keeps the token                  |
| `error`        | 429                 | Past the host's pushes of the hour                                                                                                               | Keeps the token; may retry later |
| `error`        | 503                 | The relay machine is draining and takes no new push; the host sends it again on its next link                                                    | Keeps the token; retries         |
| `error`        | another APNs status | APNs refused the push for a reason that is not the token (a bad collapse id, its own trouble)                                                    | Keeps the token                  |
| `error`        | null                | The push failed inside the relay or on the way to APNs (a timeout, a lost connection, a key that cannot sign). The relay stays up and answers it | Keeps the token; may retry later |

So `invalid` with `status` 400 means forget the token, as `unregistered` does, and `invalid` with `status: null` is a malformed frame, a bug on the host's side. A server retries `error` (503 included), `unavailable` and timeouts, three tries over about five minutes, and does not retry `invalid` or `unregistered`. The reference server also retries a push it could not send because its link was down, and retries `error` with status 429 the same way.

Checks run in this order: the frame's shape (a `push` with a string `id` that fails the schema gets `push.result` with `reason: "invalid"` and `status: null`, and the link stays up; one without an `id`, or on a link that did not offer `push`, is a protocol error and closes the link 4400), then the hourly limit (3.4), then the credentials. A relay with no credentials still counts the push against the limit.

The relay sends to APNs with token-based authentication (the project's `.p8` key) the body `{"aps":{"alert":{"title":"OpenBots","body":"You have a notification"},"mutable-content":1,"thread-id":"<threadId>"},"enc":"<ciphertext>"}` and the headers `apns-push-type: alert`, `apns-priority`, `apns-expiration`, `apns-collapse-id`, `apns-topic` (the app's bundle id). The relay keeps no tokens and logs counts only.

### 3.4 Keepalive, errors and limits

- The relay pings every 25 seconds; a link without a pong for 50 seconds is closed 1001. A host may ping too. The relay pings client sockets the same way and terminates one that misses its pong, so a phone that lost its network does not hold a stream slot. A client socket that flow control has paused (below) reads no pongs, so it is not terminated for a missed one while paused; the delivery deadline sheds it instead if it stays stuck.
- `{"type":"error","code":"<string>","message":"<string>"}` precedes a close for a protocol error.
- Frames: a binary frame of more than 65,540 bytes closes the link 1009. A text frame of more than 64 KiB closes it 1009.
- Nobody is authenticated at the relay: a client stream is a socket from an address that knows a host id. So nothing a client does can cost the host its link, and what a client can spend is limited per client address as well as per host. The limits (the payload counted without its 4 byte prefix):

  | Limit                                             | Value                       | Past it                                                                                        |
  | ------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
  | Open streams per host, across its links           | 8                           | The client is closed 4429 (`too many streams`)                                                 |
  | Open streams per host from one client address     | 4                           | 4429 (`too many streams from this address`)                                                    |
  | Stream opens per host from one client address     | 60 a minute                 | 4429 (`too many stream opens from this address`)                                               |
  | Stream opens from one client address, to any host | 300 a minute                | 4429 (`too many stream opens from this address`)                                               |
  | A first client payload                            | within 5 seconds of `open`  | The stream is closed 4400 (`no data in time`)                                                  |
  | Stream opens per host that carried a payload      | 1,000 an hour               | That stream is closed 4429 (`too many stream opens`) before its first payload reaches the host |
  | Client to host bytes per stream                   | 50 MB a minute              | That stream is closed 1008 (`byte rate exceeded`)                                              |
  | Client to host bytes per client address           | 50 MB a minute, per machine | The stream that passes it is closed 1008                                                       |
  | Host to client bytes per host                     | 50 MB a minute              | The stream that would carry the excess is closed 1008; the link stays                          |
  | Push frames per host                              | 600 an hour                 | `push.result` with `reason: "error"` and `status: 429`                                         |

  A stream counts against its host's hour only once its first client payload has arrived, so a socket that opens and sends nothing spends none of it and gives its slot back after 5 seconds. The host gets `open` when the stream opens, and the stream's first payload once the hour has counted it. An open refused by a limit counts nothing more.

  The counters are fixed windows kept in the relay's shared registry (per host, and per host and address; addresses are hashed there), so relinking does not reset them, on the same machine or another. The windows are cut by the registry's clock (Redis `TIME`, read once a minute), so machines whose clocks disagree still share each window. Host to client bytes are added to the shared total about once a second, so a host moving between machines may pass the minute's limit by what it sent in the last second; client to host bytes are counted on the machine that owns the host. When the registry cannot be reached, or does not answer within 2 seconds, each machine falls back to counting in memory with the same limits and windows until the registry answers again: across machines that is looser than the shared limit, but never unlimited, and a push past the local count still gets `push.result` with `status: 429`. A link or a client socket whose send buffer passes 8 MiB is closed 1008 (the host then gets `close` for that stream).

- Each relay machine also guards itself. A destination socket that stays behind past the delivery deadline (30 seconds) is shed with 1013, and a client stream whose bytes would pass the machine's budget for bytes in flight, or its host's share of that budget (one eighth by default, every link and stream of the host counted together), is closed 1013, so one host cannot starve the others on the machine; a link's own frames are never refused, so the host's other streams go on. Toward a host, a phone that sends faster than the link drains is paused, not closed. An upgrade that reaches a machine that is draining is refused with HTTP 503 before it is accepted, so the proxy tries another machine. At its socket ceiling (20,000 by default) a machine refuses upgrades for hosts it does not serve with 503, but still admits links and streams of the hosts it owns, which no other machine can serve; at a hard ceiling 10 percent above that it refuses every upgrade with 503.
- An unexpected error inside the relay while handling a host frame closes that link 1011. When the relay shuts down at once it closes every client, then every link, with 1001. When it drains (a deploy or a restart), it takes no new upgrades or pushes (a `push` then gets `push.result` with `reason: "error"` and `status: 503`), gives up its leases, and right after closes each host link with 1012 once the pushes in flight on it have their `push.result`, so the server relinks to another machine at once rather than leaving its host looking offline. A client stream goes on until its link closes (then 1012) or the grace period (20 seconds) ends, whichever is first; at the end of the grace period the machine waits, within it, for pushes still in flight, then closes every client, then every link, with 1012.

### 3.5 Presence

`GET /v1/hosts/{hostId}` answers `{"hostId":"...","linked":true or false}` with 200 (404 for a malformed id, 503 when the relay cannot reach its registry); `linked` is true when at least one `streams` link is up. Any machine of the relay answers it: the answer comes from the shared registry, where the machine that owns the host keeps a lease that says whether it holds a `streams` link. A client may use it to say "your server is offline" before trying a stream.

Presence, and the 4404 a stream gets when no link is up, tell anyone who has a host id whether that host is online, and when it comes and goes. A host id is not a secret in the way a key is (it is in every pairing link, and a relay operator sees it), so a relay that wants to keep this to itself sets `RELAY_PRESENCE_TOKEN`: `GET /v1/hosts/{hostId}` then wants `Authorization: Bearer <that token>` and answers 401 without it. The 4404 of a stream stays, since a client must learn why its stream closed. The iOS app does not depend on presence: it opens a stream and reads the close code, so it works the same against a relay that guards presence.

`GET /healthz` answers 200 when the relay is up. `GET /ready` answers 200 `{"status":"ready"}` while the machine should get new connections, and 503 `{"status":"unready","reasons":[...]}` while it is draining, below its minimum cluster size, or at its socket ceiling. A registry that cannot be reached does not make a machine unready (every machine would lose it at once): the machine serves on, degraded, and says so with `"degraded":["registry_unreachable"]` in the body. The relay listens on port 3200 by default (`RELAY_PORT`) and is put behind a TLS terminator.

---

## 4. Relay: the client stream

`GET /v1/connect/{hostId}`, a WebSocket upgrade from a client to the relay.

| Case                                                   | What happens                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The host has a `streams` link                          | The relay sends the text frame `{"type":"open","v":1}`. From then on every binary frame the client sends goes to the host as that stream's payload, and every payload from the host arrives as one binary frame. The client sends no text frames |
| No such link                                           | Close 4404, reason `host offline`                                                                                                                                                                                                                |
| Too many streams, or past the host's opens of the hour | Close 4429 (the second once the first payload arrives)                                                                                                                                                                                           |
| Malformed `hostId`                                     | The upgrade is accepted, then closed 4400                                                                                                                                                                                                        |
| A text frame from the client                           | Close 4400; a client sends binary frames only                                                                                                                                                                                                    |
| The client's send buffer passes 8 MiB                  | Close 1008                                                                                                                                                                                                                                       |
| A byte limit (3.4) is passed                           | Close 1008, reason `byte rate exceeded`; the host's link stays                                                                                                                                                                                   |
| No payload within 5 seconds of `open`                  | Close 4400, reason `no data in time`                                                                                                                                                                                                             |
| Too many streams or opens from the client's address    | Close 4429                                                                                                                                                                                                                                       |
| The relay shuts down                                   | Close 1001                                                                                                                                                                                                                                       |
| The host closes the stream                             | The client's socket closes with the host's code and reason                                                                                                                                                                                       |
| The host link drops                                    | Close 4410, reason `host gone`                                                                                                                                                                                                                   |

The client never learns which link served it. Binary frames are at most 65,536 bytes.

**Several relay machines.** The hosted relay runs as several machines behind one hostname (MOBILE_AND_VM_PLAN.md 5.8). One machine owns each host id at a time, through a lease in a shared registry, and every link and stream of that host terminates on it. A machine that gets an upgrade, a host link (`/v1/host?hostId=`) or a client stream, for a host that another live machine owns does not accept it: it answers the HTTP upgrade request with `307` and the header `fly-replay: instance=<machine id>`, and Fly's proxy replays the same request on the owner, where it is upgraded as usual. A request the proxy has already replayed (it carries `fly-replay-src`) is never replayed again. This is transparent to clients and hosts: they dial the one hostname and follow no redirect themselves, because the proxy does. A relay replays only on Fly (`FLY_MACHINE_ID` is set) or with `RELAY_REPLAY=fly`; anywhere else it serves every upgrade on the machine where it lands, since no other proxy acts on the header. A self-hosted relay of several machines therefore needs a proxy that routes by host id (the `hostId` query parameter of `/v1/host`, the path segment of `/v1/connect/{hostId}`), so that every socket of a host reaches the same machine.

A replay names a machine that was alive when the registry was last asked. If that machine has gone since (it crashed, or a deploy took it), Fly's proxy cannot deliver the replay and the client sees the proxy's error instead of an upgrade (an HTTP 502 or a failed handshake, as for any network failure). It then reconnects through normal routing with its usual backoff. The window is short: the gone machine's entry in the registry's node set expires within 15 seconds, after which no machine names it, and the next link of the host takes the lease elsewhere.

| Case                                                     | What happens                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This machine owns the host, or no live machine does      | Served here. A host link takes the lease once its `hello` verifies                                                                                                                                                                                                                                                    |
| Another live machine owns the host                       | Replayed to it, as above                                                                                                                                                                                                                                                                                              |
| Replayed here, and another machine owns the host by now  | Upgraded, then closed 1012; the client or host connects again and is routed afresh                                                                                                                                                                                                                                    |
| Two machines take the same host at once                  | One gets the lease; the other's host link closes 1012 before `linked` and reconnects to the owner                                                                                                                                                                                                                     |
| The relay has fewer live machines than its minimum       | A host link closes 1012 before `linked`; no new lease is taken                                                                                                                                                                                                                                                        |
| The owner loses its lease (another machine took it over) | Its links and streams for that host close 1012 within one renewal (10 seconds); both ends reconnect through the proxy                                                                                                                                                                                                 |
| The owner dies                                           | Its sockets drop; once its node key expires (15 seconds) the next host link is served and takes the lease on another machine                                                                                                                                                                                          |
| The owner has not refreshed its node key for 15 seconds  | Its node key may have expired, so another machine may take its hosts: it closes their links and streams 1012 itself                                                                                                                                                                                                   |
| The registry cannot be reached                           | Links and streams already open go on until their leases would run out. A new host link is served on the machine where it lands, without a lease (single-machine mode, logged and counted); once the registry answers, the machine takes the lease, or closes the link 1012 if another machine took the host meanwhile |
| The owner drains                                         | Its links close 1012 at once (3.4); their servers relink and the next stream finds the new owner                                                                                                                                                                                                                      |

A host or client that sees 1012 reconnects as it does after any other drop, with its usual backoff and its own random jitter. A 1012 close and a 503 refusal carry no retry delay (no `Retry-After`, no number in the reason), so the servers and phones of a machine that went do not all come back at the same moment.

---

## 5. Tunnel: inside a stream

### 5.1 Handshake

`Noise_IK_25519_ChaChaPoly_SHA256` (Noise protocol framework revision 34). Prologue: the UTF-8 bytes of `openbots-tunnel-v1`. The client is the initiator; its `rs` is the server tunnel key from the pairing link and its `s` is the device static key.

| Message | Direction       | Frame                                                                                                          |
| ------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| 1       | client → server | One binary frame: the IK first message (`e, es, s, ss`) with the payload `{"v":1}` as UTF-8 JSON               |
| 2       | server → client | One binary frame: the IK second message (`e, ee, se`) with the payload `{"v":1,"device":"known" or "unknown"}` |

Then both sides hold two CipherStates (one per direction, as Noise's `Split` gives them). Each later binary frame is one Noise transport message: the ciphertext of one plaintext frame (5.2) and its 16 byte tag, so a plaintext frame is at most 61,440 bytes. Nonces are Noise's counters; a direction that reaches 2^32 messages closes the stream 4400. No rekey in version 1.

`device: "unknown"` means the server has no device with the client's static key (never paired, or revoked). The stream stays open for pairing only: the server answers every request and `ws.open` but a `POST /api/v1/devices/pair` with `http.res` 403 and the problem `{"code":"DEVICE_UNKNOWN"}`.

A stream that answered `unknown` lives a short time, since anyone who has the server's key can open one. The server closes it 4400 (reason `pairing only`) once its first `POST /api/v1/devices/pair` has been answered, whatever the answer, or 30 seconds after the handshake, whichever is first. The close waits for the pairing's answer to be sent in full, so the client always reads its 200 (or its error) first. After a successful pairing the phone opens a new stream, which the handshake now answers `device: "known"`; a client that must try pairing again opens a new stream too.

In `packages/tunnel` alone, a pairing that answers 200 promotes the stream: `createTunnelServer` looks the key up again before it sends that `http.res`, and the stream then serves any request and is not closed for its pairing; it closes 4400 after a pairing only when the device is still unknown, or after `unknownDeviceLifetimeMs` (30 seconds by default, 0 for none). The server's relay adapter (5.4) does not keep such a stream: it closes every unknown session after its pairing, promoted or not, so a client must not count on promotion.

Either side closes the stream 4400 when the handshake does not complete within 10 seconds (on the server, the device lookup counts within that time), when a handshake payload is not `{"v":1}` (or lacks `device` in message 2), or when the server cannot look the key up. 4400 is used because the relay passes only 1000 and 4000 to 4999 through to the client.

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

A `path` is a path and query on the server and nothing else: one leading `/`, no scheme or host (so never `//`), no backslash, whitespace or control character; anything else is a `protocol` error, so a frame cannot point the server's adapter at another host. Header values are strings; header names are lower case. A frame with an unknown type, an unknown flag bit, a bad header, a never-opened, reused or even id from the client, a `credit` for an id that was never opened, or a `credit` that would open a window past its size is a stream-level `error` with code `protocol`, then a close. Frames for an id that was open and has since closed (a late chunk after a cancel, a credit after completion) are dropped without error.

An HTTP id is open from `http.req` until END has gone both ways or an error ends it; a socket id from `ws.open` until each side has sent and received `ws.close`. When the server answers before the request body has ended, it keeps the id open, discards the rest of the body and still credits it, so the client's upload finishes and the id is freed.

### 5.3 Flow control and limits

- Each id has a window per direction, 1,048,576 bytes at open, counting the body bytes of `http.req`, `http.body`, `http.res` and `ws.msg`. A sender never exceeds the window; a receiver sends `credit` with the bytes it has consumed to reopen it. Headers do not count. A `ws.msg` fragment counts as consumed once the receiver has taken it into the message it is joining (the 16 MiB message limit bounds that memory), so a message larger than the window completes.
- At most 64 open ids per stream; a 65th gets `error` with code `too_many_requests` on that id.
- A request body of more than 16 MiB (the files limit) gets `error` with code `too_large`.
- Keepalive: each side sends `ping` on id 0 once it has sent no frame for 25 seconds, and closes the stream 1000 with reason `idle` once it has received no frame at all (pings and pongs included) for 60 seconds. So a quiet stream stays open as long as both ends are there. The reference implementation takes both numbers as options (`keepalive: { pingIntervalMs, idleTimeoutMs }`).
- On the server, client bytes for a WebSocket are credited only once the handler's socket has taken them: while that socket holds more than one window it has not written out, the credit waits, so the client's window shuts and the server holds a bounded amount for it. A socket that still holds more than 8 MiB when the next message is handed to it is closed 1008 (`receive queue full`), and so is the tunnel socket.
- A WebSocket may queue at most 8 MiB of messages behind a shut window, beyond the message being sent. On the server, when the handler's socket keeps talking to a client that credits nothing, the server sends `ws.close` with 1008 (`send queue full`) ahead of what is queued, drops the rest and closes the handler's socket with 1008. On the client, a `send` that would pass the bound does the same toward the server (`send buffer full`), and the socket's close event carries 1008 once the server echoes it.
- Any frame on a stream whose Noise counter would overflow closes it (5.1).

### 5.4 What the server does with a frame

A `http.req` becomes a request to the server's own HTTP port on loopback, as any caller: the frame's headers pass through, less `host`, `cookie`, `origin`, `sec-fetch-*`, `x-forwarded-*`, `connection`, `upgrade`, `content-length` and `transfer-encoding`, which the adapter sets itself. The tunnel drops a client-sent `x-openbots-device`; the adapter adds `x-openbots-device: <device id>` for a known device, or `remote:<address>` for an unknown one, the client's address as the relay's `open` frame reported it (stream ids restart at 1 on every link, so they cannot key a limit), which the server's rate limits key on for loopback requests, and on a `POST /api/v1/devices/pair` also `x-openbots-device-key: <the session's client static key, base64url>`, which the route compares with the body's `publicKey`. Both headers are honoured only from loopback and only beside `x-openbots-adapter`, a secret the adapter makes at each start and adds to every request; the adapter drops a client-sent copy, so neither a tunneled request nor another program on the host can name a device. A `ws.open` becomes a WebSocket connection to the same port and path with the same header rules, so `/ws`, `/computer/pty` and `/bots/{id}/screen/vnc` work as they do for any client. The response's headers pass back less `set-cookie`, `connection`, `transfer-encoding` and `content-length`.

So the API, its authentication (the device's bearer key), its ownership checks, rate limits and audit apply unchanged. A tunneled request without a bearer key gets 401 like any other.

The adapter adds these rules of its own:

- On a known device's stream, a request (or `ws.open`) whose bearer or `x-api-key` key is not the API key of a device with the session's static key is refused with 401 `DEVICE_KEY_MISMATCH` before it reaches the server. So a paired session cannot carry a key lifted from another phone.
- One static key may be paired with several organizations (one device, and one API key, in each); a request is served as the device whose key it carries.
- Per server instance at most 8 sessions of known devices and 2 of unknown devices are open, counted apart (the next is closed 4429), so strangers cannot take a paired phone's place.
- An unknown session serves one `POST /devices/pair` and closes 4400 `pairing only` once its answer is sent, or 30 seconds after the handshake (5.1).

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
3. It sends `POST /api/v1/devices/pair` (6.3). The server answers the device, its API key and the owner. Over the relay, once that 200 is sent the stream closes 4400 `pairing only` (5.1).
4. It keeps the API key, the static key and the push key in the Keychain. Over the relay it opens a new stream, which the handshake now answers `device: "known"`, and sends every later request there with the API key. It calls `PUT /api/v1/devices/{id}/push` once it has an APNs token.

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

`key` is shown once. `setupNeeded` is true while the server has no model provider or no Bot, so the client runs the first-run steps with the ordinary routes (`POST /providers`, `POST /bots`). Over the relay the stream closes 4400 once this answer is sent; the phone opens a new stream as the device (6.2).

Errors:

- 401 `PAIRING_INVALID`: an unknown, used or expired code, with no detail which; also when the pairing's owner is no longer an active member of its organization. Expiry is judged by the database's clock.
- 400 `PAIRING_KEY_MISMATCH`.
- 409 `DEVICE_ALREADY_PAIRED`: an unrevoked device of the same organization holds that `publicKey`. The code is not spent (also when a racing pairing wins, or a later step fails: the code is given back).
- 429 when a limit is hit.

### 6.4 The device's routes

| Route                                  | Caller                     | Answer                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/devices/pairings`        | A signed-in user           | `{"id","expiresAt","link","qr":{"v":1,"host","key","code","relay","direct":[...],"name","setup"}}`. Body: `{"name"?: string, "direct"?: string[]}`. 409 `TOO_MANY_PAIRINGS` past 5 open pairings per owner                                                                                                                                                                                         |
| `DELETE /api/v1/devices/pairings/{id}` | A signed-in user or device | 204. Cancels an open pairing of the caller's: its code stops working at once. 404 otherwise (used, expired and swept, or another owner's). Audited `device.pairing_cancelled`                                                                                                                                                                                                                      |
| `GET /api/v1/devices`                  | A signed-in user or device | `{"items":[{"id","name","platform","createdAt","lastSeenAt","pushRegistered"}]}`, revoked devices left out                                                                                                                                                                                                                                                                                         |
| `DELETE /api/v1/devices/{id}`          | A signed-in user or device | 204. The device is marked revoked and forgets its static key, push key and push token first; then its API key is deleted. The key stops working at once, its streams close (4403, once the responses in flight are sent: section 9), and the `/ws`, `/computer/pty` and screen sockets opened with the key close 1008. A revocation whose key delete failed is finished by calling it again        |
| `POST /api/v1/me/credentials`          | A signed-in user or device | Body `{"email","password"}`. 204. Only for an owner with the placeholder email (`owner@openbots.local`) and no password, as pairing makes one (MOBILE_AND_VM_PLAN.md 8.3); else 409 `CREDENTIALS_SET`. 409 `EMAIL_TAKEN` when another account has the email; 400 for a bad email or password; 403 `LOCAL_ONLY` on the Mac app's local stack. 5 an hour per account. Audited `auth.credentials_set` |
| `PUT /api/v1/devices/{id}/push`        | That device only           | Body `{"token":"<hex>","environment":"production" or "sandbox"}`. 204; 403 `NOT_THIS_DEVICE` from any other caller                                                                                                                                                                                                                                                                                 |
| `GET /api/v1/relay`                    | A signed-in user or device | `{"hostId","relayUrl","status":"off" / "connecting" / "linked","since"}`                                                                                                                                                                                                                                                                                                                           |

Events on `/ws`, each scoped to one owner (`user_id`, in the organization `workspace_id`):

| Event            | Payload                                                                  | When                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.paired`  | `{"device":{"id","name","platform","createdAt","revokedAt"}}`            | A device paired with the owner's account                                                                                                                                                                          |
| `device.revoked` | The same                                                                 | A device was revoked; every API process's relay adapter closes its streams                                                                                                                                        |
| `device.updated` | The same, the device also carrying `pushRegistered`                      | The device registered or refreshed its push token (`PUT /devices/{id}/push`); the push worker reads the organization's devices again, as it does on every `device.*` event                                        |
| `relay.status`   | The `GET /api/v1/relay` answer: `{"hostId","relayUrl","status","since"}` | The relay link of an API process changed status. Sent to every owner with an unrevoked device or an open pairing, and to those the previous `relay.status` went to, so an owner whose last device went sees `off` |

A client that shows the relay's status listens for `relay.status` and reads `GET /api/v1/relay` again each time its socket reconnects, since an event sent while it was away is lost. A push only link (a worker process) sends no `relay.status`.

A device's API key is an ordinary API key with the owner's permissions; `GET /api/v1/api-keys` leaves device keys out and `DELETE /api/v1/api-keys/{id}` answers 404 for one, so only `DELETE /devices/{id}` removes a device.

`GET /api/v1/capabilities` (no authentication) reports, besides the sign-in options:

| Field              | Meaning                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay`            | `true` when the server has a relay configured                                                                                                                                                                                                       |
| `version`          | The server's release version, such as `1.2.0` (the root `package.json`, which the release stamps and checks against its tag); `0.0.0` on a development build                                                                                        |
| `protocol`         | `{"relay":1}`: the version of this protocol the server speaks. A client that needs a later one, or a later `version`, tells the owner to update the server. Absent on a server older than this field                                                |
| `setupPairingOnly` | `true` when the first owner is made by pairing a phone only (`OPENBOTS_SETUP_PAIRING_ONLY`, which the standalone image sets): the web wizard's account step and sign-up answer 403 `SETUP_PAIRING_ONLY`, and a client shows `openbots pair` instead |

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

| Code                       | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Meaning                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAIRING_INVALID`          | `POST /devices/pair`, 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The code is unknown, used or expired                                                                                                                                                                                                                                                                                                         |
| `PAIRING_KEY_MISMATCH`     | `POST /devices/pair`, 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `publicKey` is not the handshake's static key                                                                                                                                                                                                                                                                                                |
| `DEVICE_UNKNOWN`           | Any tunneled request, 403                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The stream's device is not paired; only pairing is served                                                                                                                                                                                                                                                                                    |
| `DEVICE_REVOKED`           | Any request, 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The device was revoked: a plain 401 from the API (its key is gone), or this code from the adapter for a request on a revoked device's stream before it closes 4403                                                                                                                                                                           |
| `DEVICE_ALREADY_PAIRED`    | `POST /devices/pair`, 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | An unrevoked device already holds that static key                                                                                                                                                                                                                                                                                            |
| `TOO_MANY_PAIRINGS`        | `POST /devices/pairings`, 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Five pairings are already open for this owner                                                                                                                                                                                                                                                                                                |
| `DEVICE_KEY_NOT_ALLOWED`   | 403, on `POST /api-keys`, `POST /devices/pairings`; `POST /bots/{id}/endpoints`, `POST /endpoints/{id}/rotate`, `PATCH /endpoints/{id}` setting `signature`; `POST /event-subscriptions`, `PATCH /event-subscriptions/{id}` setting `url` or `local` or `rotateSecret`; `POST /connectors`, `POST /connectors/import`, `PATCH /connectors/{id}` setting `command`, `args`, `url`, `auth` or `oauthClient`, `GET /connectors/{id}/oauth/start`; `POST /providers`, `PATCH /providers/{id}` setting `baseUrl`; `POST /organization/invitations` on the managed service (the first `POST /providers` of an owner with none is allowed, for headless setup) | A device key cannot make a long-lived credential (an API key, a pairing, a webhook token or signing secret, an event subscription's secret, an invitation) or a new path out of the server (an event subscription's URL, a connector, an OAuth grant, a provider's endpoint), so a stolen phone cannot leave something behind its revocation |
| `DEVICE_KEY_MISMATCH`      | Any tunneled request, 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The request's API key is not the key of a device with the stream's static key (5.4)                                                                                                                                                                                                                                                          |
| `NOT_THIS_DEVICE`          | `PUT /devices/{id}/push`, 403                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The caller is not that device                                                                                                                                                                                                                                                                                                                |
| `INSTANCE_KEY_UNAVAILABLE` | `POST /devices/pairings`, `GET /relay`, 503                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The master key does not open the relay identity (`OPENBOTS_MASTER_KEY` changed without `OPENBOTS_MASTER_KEY_PREVIOUS`); the relay is off until it does                                                                                                                                                                                       |
| `CREDENTIALS_SET`          | `POST /me/credentials`, 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The account has an email or a password of its own already                                                                                                                                                                                                                                                                                    |
| `EMAIL_TAKEN`              | `POST /me/credentials`, 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Another account has that email                                                                                                                                                                                                                                                                                                               |
| `SETUP_PAIRING_ONLY`       | `POST /setup/admin` and sign-up, 403                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The server makes its first owner by pairing a phone only (`setupPairingOnly`, 6.4)                                                                                                                                                                                                                                                           |

Tunnel `error` frame codes: `protocol`, `too_many_requests`, `too_large`, `cancelled`, `internal`.

## 9. Close codes

| Code       | Where         | Meaning                                                                                                                                                                                   |
| ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1000       | anywhere      | Normal close                                                                                                                                                                              |
| 1001       | relay         | Keepalive missed                                                                                                                                                                          |
| 1008       | relay, tunnel | A limit was hit: a byte rate (only the stream that passed it), a send buffer, or a socket's receive queue                                                                                 |
| 1008       | server        | `/ws`, `/computer/pty` and screen sockets close 1008 `api key revoked` when their API key is deleted (a device's revocation included), at once over the bus or within a minute's re-check |
| 1009       | relay         | A frame too large                                                                                                                                                                         |
| 1011       | relay         | An unexpected error inside the relay                                                                                                                                                      |
| 1012       | relay         | The relay machine lost the host's lease, cannot take it in time (section 4), or is draining. Reconnect, with your own backoff and jitter                                                  |
| 1013       | relay         | The relay machine is busy: a peer stayed behind past the deadline (shed), or a stream would pass the byte budget (3.4). Try again later                                                   |
| 1005, 1006 | relay         | What a host sees when a client's socket went away without a close frame                                                                                                                   |
| 4400       | relay, tunnel | Malformed frame, bad `hostId`, protocol error, or no payload in time. Tunnel: a pairing only stream after its pairing or 30 seconds (5.1)                                                 |
| 4401       | relay         | The host's signature did not verify                                                                                                                                                       |
| 4404       | relay         | The host is offline                                                                                                                                                                       |
| 4410       | relay         | The host link dropped while the stream was open                                                                                                                                           |
| 4403       | tunnel        | The server closed the stream because its device was revoked. See below                                                                                                                    |
| 4429       | relay, tunnel | Too many streams or opens, per host or per client address; the server also closes a ninth known device, or a third unknown device, on one instance with it                                |

On 4403: the moment the server learns a device is revoked, its streams answer every new `http.req` and `ws.open` with `http.res` 401 `{"code":"DEVICE_REVOKED"}`, and each stream closes 4403 once the HTTP responses already in flight have been sent, or after 5 seconds, whichever is first. Open WebSockets are not waited for; they end with the stream. So a device that revokes itself over its own stream gets its 204 before the close. The server learns of a revocation from the `device.revoked` event, and also by looking each open stream's device up again every 15 seconds, and before serving a request on a stream whose last look is older than that; without a shared event bus (no Redis), a revocation made by `openbots devices revoke` in another process is found that way.
