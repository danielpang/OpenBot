# @openbots/tunnel

The tunnel of [RELAY_PROTOCOL.md](../../docs/RELAY_PROTOCOL.md): a Noise IK handshake
(`Noise_IK_25519_ChaChaPoly_SHA256`, prologue `openbots-tunnel-v1`), then encrypted frames that
carry HTTP requests and WebSockets between a device and an OpenBots server, through the relay or any
other ordered byte pipe. Pure TypeScript on `@noble/curves`, `@noble/ciphers` and `@noble/hashes`:
the same code runs in Node 22, a browser and React Native. The library code uses only `Uint8Array`,
`TextEncoder`, web streams and `fetch` types; nothing from `node:*` and no `Buffer`.

## Exports

### Keys (`keys.ts`)

| Export                                                                   | What                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `base64urlEncode(bytes)`, `base64urlDecode(text)`                        | Base64url without padding, the encoding of binary in the protocol's JSON        |
| `base32Encode(bytes)`                                                    | Lower case RFC 4648 base32 without padding                                      |
| `generateSigningKey(): KeyPair`                                          | The server's Ed25519 pair (`privateKey` is the 32 byte seed)                    |
| `hostIdFromPublicKey(ed25519Pub): string`, `isHostId(id)`                | The 26 character host id of spec section 1                                      |
| `tunnelKeyFromSigningKey(ed25519Priv): KeyPair`                          | The server tunnel key: the X25519 pair converted from the Ed25519 pair          |
| `tunnelPublicKeyFromSigningPublicKey(ed25519Pub)`                        | The same public key from the Ed25519 public key alone                           |
| `generateDeviceKey(): KeyPair`, `x25519PublicKey(priv)`                  | A device's X25519 static key                                                    |
| `signHostChallenge(priv, nonce)`, `verifyHostChallenge(pub, nonce, sig)` | The relay link proof of spec 3.1, over `openbots-relay-host-v1\n` and the nonce |

### Noise (`noise.ts`)

`CipherState`, `SymmetricState` and `HandshakeState` as the Noise specification (revision 34)
names them, for the IK pattern. `HandshakeState({ initiator, staticKey, remoteStaticKey?, prologue?,
ephemeralKey?, maxMessages? })` has `writeMessage(payload)`, `readMessage(message)`, `split()` (the
`{ send, receive }` CipherStates for this side), `handshakeHash` and `remoteStaticKey`. A CipherState
refuses past `maxMessages` (2^32) with `NoiseNonceExhaustedError`; a bad tag throws `NoiseError`.
Tested against the cacophony known-answer vector.

### Frames (`frames.ts`)

`encodeFrame({ type, id, flags?, header?, body? }): Uint8Array` and `decodeFrame(bytes): Frame` for
the plaintext frame of spec 5.2, with `FrameType`, `FLAG_END`, `FLAG_TEXT`, `MAX_HEADER_BYTES`
(16,384), `MAX_PLAINTEXT_BYTES` (61,440) and `MAX_BODY_BYTES`. Bytes that are not a frame throw
`FrameError` (`code: 'protocol'`).

### Transports (`transport.ts`)

```ts
interface ByteTransport {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  close(code?: number, reason?: string): void;
}
```

`fromWebSocket(socket)` wraps a browser, React Native or `ws` socket (binary frames both ways, sends
queued while connecting). `memoryTransportPair()` joins two ends in memory for tests.

### Relay client (`relay-client.ts`)

- `connectThroughRelay({ relayUrl, hostId, createSocket?, timeoutMs?, signal? }): Promise<ByteTransport>`
  opens `${relayUrl}/v1/connect/${hostId}` and resolves on `{"type":"open","v":1}`. When the relay
  closes first it rejects with `RelayConnectError` carrying `code` and `reason` (4404 host offline,
  4429 too many streams, 4400 malformed id).
- `hostPresence({ relayUrl, hostId, fetch? }): Promise<boolean>` asks `GET /v1/hosts/{hostId}`
  (a `wss` relay URL is read as `https`). Throws `RelayPresenceError` on an error status.

### Client (`client.ts`)

`createTunnelClient({ transport, serverKey, staticKey, limits?, handshakeTimeoutMs?, keepalive? }): Promise<TunnelClient>`
runs the handshake as the initiator. `serverKey` is the server's X25519 public key from the pairing
link; `staticKey` is the device's X25519 private key.

| `TunnelClient`                                                         | What                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `device`                                                               | `'known'` or `'unknown'` from the handshake; becomes `'known'` once `POST /api/v1/devices/pair` answers 200 on this stream                             |
| `fetch`                                                                | `typeof fetch`. Takes a path or a URL and sends only the path and query. Streams both bodies under the credit window; an AbortSignal sends `cancelled` |
| `createSocket(url, { headers? })`                                      | A `TunnelWebSocket`, which fits `WebSocketLike` from `@openbots/api-client`, so `createWsClient({ createSocket })` runs over the tunnel as it is       |
| `ping()`                                                               | Round trip time in milliseconds                                                                                                                        |
| `close(code?, reason?)`, `onClose(handler)`, `closed`, `handshakeHash` |                                                                                                                                                        |

A refused upgrade fires `onerror` with `{ response }` and then `onclose` with 1006; the Response is
also on `socket.upgradeResponse`. The client enforces the 64 open ids (`too_many_requests`) and the
16 MiB request body (`too_large`) itself; both reject with a `TunnelError`. A closed stream rejects
with `TunnelClosedError` (`closeCode`, `reason`).

### Server (`server.ts`)

`createTunnelServer({ transport, staticKey, lookupDevice, handler, limits?, handshakeTimeoutMs?, keepalive? }): Promise<TunnelServer>`
runs the handshake as the responder. `staticKey` is the server tunnel key's X25519 private key.

- `lookupDevice(publicKey) => Promise<{ known: true, id } | { known: false }>` decides `device` in
  handshake message 2, and is asked again when a pairing on the stream answers 200.
- `handler.fetch(request, { deviceId })` gets a web `Request` with a streaming body, whose URL is
  `http://openbots.tunnel` plus the path and query. Answer a `Response`.
- `handler.openSocket(path, headers, { deviceId })` answers a `ServerSocket` (`send`, `close`,
  `onMessage`, `onClose`, optional `headers` for `ws.opened`) or a `Response` to refuse the upgrade.

An unknown device reaches the handler only with `POST /api/v1/devices/pair`; everything else gets 403
`{"code":"DEVICE_UNKNOWN","message":"..."}`. Request headers arrive less those spec 5.4 lists (and
less `x-openbots-device`, which the adapter sets itself from `deviceId`); response headers go back
less `set-cookie`, `connection`, `transfer-encoding` and `content-length`.

`TunnelServer` has `deviceId`, `device`, `clientKey`, `closed`, `draining`, `handshakeHash`,
`ping()`, `close(code?, reason?)`, `drain(code, reason, { timeoutMs?, refuse? })` and
`onClose(handler)`. `drain` answers every later request and `ws.open` with `refuse()` (503
`STREAM_CLOSING` by default) and closes the stream with `code` once the HTTP responses in flight are
sent, or after `timeoutMs` (5 seconds); the relay adapter drains a revoked device's streams with
4403 so a device that revokes itself still gets its 204.

### Limits and errors

`DEFAULT_LIMITS` holds the protocol's numbers (`windowBytes` 1,048,576, `maxOpenIds` 64,
`maxRequestBodyBytes` and `maxMessageBytes` 16 MiB, `maxMessages` 2^32, `maxQueuedBytes` 8 MiB);
`limits` overrides them, for tests. A WebSocket on either end that would queue more than
`maxQueuedBytes` behind a shut window (beyond the message being sent) is closed 1008.
`keepalive: { pingIntervalMs, idleTimeoutMs }` (25 and 60 seconds; 0 turns either off) has each end
ping a stream it has sent nothing on for `pingIntervalMs`, and close 1000 (`idle`) one it has
received nothing on for `idleTimeoutMs`. `TunnelError.code` is one of `protocol`, `too_many_requests`, `too_large`, `cancelled`,
`internal`. `TunnelHandshakeError` means the handshake failed or timed out; the transport is then
closed with 4400.

## Usage

The device:

```ts
import { connectThroughRelay, createTunnelClient, base64urlDecode } from '@openbots/tunnel';
import { createWsClient } from '@openbots/api-client';

const transport = await connectThroughRelay({ relayUrl: link.relay, hostId: link.host });
const tunnel = await createTunnelClient({
  transport,
  serverKey: base64urlDecode(link.key),
  staticKey: keychain.devicePrivateKey,
});
const bots = await tunnel.fetch('/api/v1/bots', { headers: { authorization: `Bearer ${apiKey}` } });
const realtime = createWsClient({
  url: '/ws',
  createSocket: (url) =>
    tunnel.createSocket(url, { headers: { authorization: `Bearer ${apiKey}` } }),
});
```

The server, for each stream the relay opens:

```ts
import { createTunnelServer, tunnelKeyFromSigningKey } from '@openbots/tunnel';

const { privateKey } = tunnelKeyFromSigningKey(instanceSigningKey);
const tunnel = await createTunnelServer({
  transport: streamTransport,
  staticKey: privateKey,
  lookupDevice: async (publicKey) => {
    const device = await devices.findByPublicKey(publicKey);
    return device ? { known: true, id: device.id } : { known: false };
  },
  handler: {
    fetch: (request, { deviceId }) => forwardToLoopback(request, deviceId),
    openSocket: (path, headers, { deviceId }) => openLoopbackSocket(path, headers, deviceId),
  },
});
tunnel.onClose((code, reason) => log.info({ code, reason }, 'tunnel stream closed'));
```
