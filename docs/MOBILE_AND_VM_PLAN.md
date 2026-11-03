# OpenBots on your phone, and OpenBots on a VM

A design for two additions to OpenBots, in the style of [TECHNICAL_PLAN.md](TECHNICAL_PLAN.md):

- **An iOS app** that reaches the owner's OpenBots server from anywhere, chats with their Bots, starts work, approves and answers, and gets pushed when a Bot needs them. It connects to the stack the Mac app runs on This Mac, to a self-hosted server, or to an OpenBots account, through a **private relay** when the server has no public address, in the way [Paseo](https://github.com/getpaseo/paseo) pairs a phone with its daemon.
- **Server mode on a VM**: one image that runs the whole of OpenBots on a Fly Machine, a Sprite, an EC2 instance or any box that runs one container, so Bots and Routines work 24/7 while the Mac sleeps, paired to the phone from the VM's terminal in the way `opencode serve` and `opencode pair` work.

Both stand on one shared piece: **devices and pairing**, which is also what the Mac app and the web app use to show the QR code. PRD requirement IDs are extended below (M for mobile, V for the VM); existing IDs (K4, N1, D2, D4, U4) are referenced as in the plan.

Sections 1 to 9 are the design. Sections 10 to 12 are the plan and the open decisions.

---

## 1. Scope

| Deliverable         | What ships                                                                                                                                                                                                        | What it reuses                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Devices and pairing | A `devices` table, `POST /devices/pairings` and `POST /devices/pair`, Settings > Devices in the web app, "Pair your phone…" in the Mac app, `openbots pair` in the server image                                   | better-auth API keys (U4, `routes/api-keys.ts`), the audit log, the local token mode untouched                                          |
| Private relay       | `apps/relay` (a small service, hosted by the project and self-hostable), a relay link in the server (`apps/server/src/relay`), `packages/tunnel` (the end-to-end encrypted stream and its framing)                | The REST API and `/ws` as they are: tunneled requests land on the server's own port                                                     |
| Push                | A notice worker in the server, the relay as the APNs gateway, encrypted payloads a Notification Service Extension opens on the phone                                                                              | `createNoticeWatcher` in `packages/shared/src/notices.ts` (its third consumer after the Mac app and the web app)                        |
| iOS app             | `apps/mobile`, Expo (React Native), iOS first                                                                                                                                                                     | `@openbots/api-client` (REST and WS clients with injectable `fetch` and `createSocket`), `@openbots/shared`, widget schemas, deep links |
| Server mode         | `docker/standalone.Dockerfile`: server, Postgres, Redis and the computer agent in one image on one volume; `deploy/` templates for Fly, Sprites and EC2; `install.sh --pair` for the compose stack on a Docker VM | The `remote` computer provider (plan 9.2), the entrypoint's subcommands, backup and restore scripts                                     |

Out of scope here: Android (the Expo code builds it; shipping it is a later decision), multi-human groups, a web app that connects over the relay (sketched in 8.6), Windows and Linux desktop.

---

## 2. Requirements

### 2.1 Mobile (extends D4, N1, N2)

| ID  | Requirement                                                                                                                                                                                                                                                                                                                             | Priority             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| M1  | The iOS app connects to a server three ways, as the Mac app does (D2): pair with a QR code (a self-hosted server or the Mac app's This Mac, over the relay or directly), sign in to a self-hosted server by address, or sign in to an OpenBots account. Several servers can be saved; one is active.                                    | Must                 |
| M2  | Pairing is one scan. The QR code (or a pairing link sent to oneself) carries everything the phone needs, is good for 5 minutes and works once. The server shows it in Settings > Devices, the Mac app in its menu, and the server image prints it in the terminal (`openbots pair`).                                                    | Must                 |
| M3  | The phone reaches a server with no public address through the relay. The relay cannot read the traffic: every byte between phone and server is end-to-end encrypted with keys the relay never holds. When the server is reachable directly (a public URL or the same network), the app uses that path and the relay only as a fallback. | Must                 |
| M4  | The app shows the roster with live Bot state, each Bot's transcript and the groups, streams replies as they are written, and sends messages with photos and files. Approvals, questions and sign-in requests are answered in place, and an Inbox lists every pending one across Bots (N2's tray, on the phone).                         | Must                 |
| M5  | Push notifications for the same events as N1 (approvals, questions, sign-in requests, mentions, Routine exceptions, finished long tasks), opening the exact message. Their content is encrypted for the phone; the push gateway sees only that a notification exists.                                                                   | Must                 |
| M6  | Work continues when the phone is closed (K4 holds). A reconnecting app catches up through `resync`, never losing a message.                                                                                                                                                                                                             | Must                 |
| M7  | A device is listed in Settings > Devices with its name, platform and last use, and can be revoked there: its key stops working, its relay streams close and its push token is forgotten.                                                                                                                                                | Must                 |
| M8  | Screen preview (view only), the activity log, Artifacts, and Routines (enable, run now) on the phone.                                                                                                                                                                                                                                   | Should               |
| M9  | Share sheet ("Send to a Bot"), Siri Shortcuts, a Home Screen widget with Bots at work, a Live Activity for a long task.                                                                                                                                                                                                                 | Later                |
| M10 | Setting up providers, connectors, the computer's terminal and files stay on the desktop and the web. The phone shows them read-only at most.                                                                                                                                                                                            | Must (as a non-goal) |

### 2.2 Server mode (extends D1, D3)

| ID  | Requirement                                                                                                                                                                                                                                                                        | Priority |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| V1  | One image runs the whole of OpenBots in one container with one persistent volume: server, Postgres, Redis and the Bots' computer. It starts on a platform that runs one container and no Docker inside it (Fly Machines, Sprites, Modal, Railway, Render), and on any Docker host. | Must     |
| V2  | A fresh server pairs headlessly: `openbots pair` in the container's terminal prints the QR code before any owner exists, and the phone's onboarding creates the owner. No browser, public URL, DNS or TLS is needed to get going.                                                  | Must     |
| V3  | The server stays reachable with no open port: it dials the relay out. A public URL remains optional (webhooks and connector OAuth need one, as today).                                                                                                                             | Must     |
| V4  | `deploy/` carries a template per platform (Fly, Sprites, EC2 with the compose stack) and the README has a "Run OpenBots 24/7 on a VM" section with the cost and isolation trade-offs stated.                                                                                       | Must     |
| V5  | Upgrades, backups and restore work for the standalone image with the existing scripts and `docker pull`.                                                                                                                                                                           | Must     |
| V6  | The standalone image is single tenant: `OPENBOTS_DEPLOYMENT=self_hosted` only. It refuses `managed`.                                                                                                                                                                               | Must     |

---

## 3. Architecture

```
┌─────────────┐            ┌──────────────────────┐            ┌──────────────────────────────┐
│  iPhone     │  direct    │                      │            │  OpenBots server             │
│  Expo app   │───https────┼──────────────────────┼───────────▶│  (compose stack on a Mac or  │
│             │            │                      │            │   VM, or the standalone      │
│  tunnel     │   wss      │   openbots-relay     │   wss      │   image on a Fly Machine)    │
│  (Noise IK) │═══════════▶│  pipes bytes, holds  │◀═══════════│                              │
│             │ /connect/  │  no keys             │  /host     │  relay link ──▶ loopback     │
│             │  {hostId}  │                      │ (outbound) │  adapter  ──▶ :3000 REST+/ws │
│  NSE opens  │            │  APNs gateway        │            │  notice worker ──▶ push      │
│  push       │◀─APNs──────│  (project's key)     │◀───────────│  frames over the link        │
└─────────────┘            └──────────────────────┘            └──────────────────────────────┘
                 ═══ end-to-end encrypted; the relay sees ciphertext and sizes
```

Three ideas carry the design:

1. **The API does not change.** A tunneled request is an ordinary `GET /api/v1/...` with `Authorization: Bearer obk_...`, delivered to the server's own port on loopback. A tunneled socket is an ordinary `/ws`. The phone uses `@openbots/api-client` as the Mac app's main process does (`apps/desktop/src/main/connection.ts`), with a `fetch` and a `createSocket` that go through the tunnel. Routes, ownership checks, rate limits, the audit log and organization scoping (plan 21) all apply unchanged.
2. **The relay is untrusted.** It authenticates hosts so nobody can squat a host id, pairs a phone's connection with the host's link, and forwards bytes. Encryption is end to end (Noise IK, section 5.3), keys live in the server's database (sealed with the master key) and the phone's Keychain.
3. **Pairing is the trust anchor.** The QR code carries the server's public key and a one-time code. Scanning it is the whole setup, like Paseo's pairing and `opencode pair`. The code is in the link's fragment, so a link that is opened on the web never sends it to a server.

---

## 4. Devices and pairing

### 4.1 Data model

| Table             | Key columns                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices`         | id, workspace_id, owner_id, name, platform (`ios`, `android`, `desktop`), public_key bytea (unique), api_key_id, push_token bytea (sealed, nullable), push_key bytea (sealed), last_seen_at, created_at, revoked_at | A paired client. `public_key` is its Noise static key; `api_key_id` the better-auth API key it authenticates with (U4); `push_key` the 32 byte key its push payloads are encrypted with (section 6). RLS and `workspace_id` as every other table (plan 21.9)                                                                      |
| `device_pairings` | id, workspace_id, owner_id (nullable until the owner exists, V2), code_hash, direct_urls text[], creates_owner bool, expires_at, used_at, created_by (`user`, `cli`)                                                | A pairing offer. The code is 32 random bytes, stored as a SHA-256, compared in constant time (plan 17 control 7), good for 5 minutes, used once                                                                                                                                                                                   |
| `instance_keys`   | id, signing_key bytea (sealed), public_key bytea, created_at                                                                                                                                                        | One row per install: the server's relay identity, an Ed25519 key pair made at first start and sealed with the master key (plan 4.9; rotated with it). The X25519 key for Noise is derived from it. `host_id` is `base32(sha256(public_key))[0..26]`. No `workspace_id`: the relay identity is the server's, not an organization's |

### 4.2 Routes

| Route                    | Who                                                                         | What                                                                                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /devices/pairings` | `requireUser`                                                               | Makes a pairing, answers `{id, expiresAt, link, qr}`. `qr` is the link's payload (4.3). Body: `name?`, `direct?: string[]` (defaults to `OPENBOTS_PUBLIC_URL` when it is https)                                                                                                                               |
| `POST /devices/pair`     | nobody (rate-limited like sign-in: 10 an hour per client, 5 tries per code) | The phone's side. Body: `code`, `name`, `platform`, `publicKey`, `pushKey`. Answers the device, the API key (once, as `POST /api-keys` does), the owner, and `setupNeeded` (V2). Marks the pairing used in the same transaction; a used, expired or unknown code answers 401 `PAIRING_INVALID` with no detail |
| `GET /devices`           | `requireUser`                                                               | The caller's devices: name, platform, last seen, paired at                                                                                                                                                                                                                                                    |
| `DELETE /devices/{id}`   | `requireUser`                                                               | Revoke (M7): sets `revoked_at`, deletes the API key, forgets the push token, publishes `device.revoked` on the bus so every API instance's relay adapter closes that device's streams                                                                                                                         |
| `PUT /devices/{id}/push` | the device itself                                                           | Registers or refreshes the APNs token (sealed)                                                                                                                                                                                                                                                                |
| `GET /relay`             | `requireUser`                                                               | `{hostId, status: 'off' \| 'connecting' \| 'linked', relayUrl, since}` for Settings > Devices and the CLI                                                                                                                                                                                                     |

Events: `device.paired`, `device.revoked`, `relay.status` (user scoped, carry `workspace_id` like `computer.status`). Audit: `device.paired`, `device.revoked`, `device.pairing_created`.

A device's key is an ordinary API key with the device's name, so it reaches the same routes with the same permissions as the session (`middleware/auth.ts`); `GET /api-keys` lists it as a device key rather than a user-made one, and only `DELETE /devices/{id}` removes it. In the Mac app's local mode (`OPENBOTS_LOCAL_TOKEN`) nothing changes: API keys already work there, and pairing makes no user and no session, so `LOCAL_ONLY` is not involved.

### 4.3 The pairing link and QR code

```
https://openbots.dev/pair#v=1&host=<hostId>&key=<X25519 public key, base64url>
     &code=<32 bytes, base64url>&relay=wss://relay.openbots.dev&direct=https://openbots.example.com
     &name=Daniel%27s%20Mac&setup=1
```

- The whole payload is in the fragment. A browser never sends a fragment, so the page at `/pair` (a static page that says "Open this on your phone" with an App Store link) learns nothing. The iOS Camera opens the app through a universal link; the app also registers `openbots://pair`.
- `key` is the trust anchor: the phone pins it. A relay or a network that swaps the host fails the handshake.
- `direct` lists addresses the phone tries first (5.6). The Mac app's This Mac stack binds to loopback (`OPENBOTS_HTTP_BIND=127.0.0.1:`), so it lists none and is reached over the relay only.
- `setup=1` says the server has no owner yet (V2, 8.3).

Where it shows: Settings > Devices > "Pair a phone" (web app, every deployment); the Mac app's tray and app menu, "Pair your phone…", which opens that page on the active connection (This Mac included); and `openbots pair` in the server image (4.4). Each shows the QR code and a "Copy link" for sending the link to oneself by AirDrop or Messages, with the 5 minute countdown.

### 4.4 The CLI

The server image's entrypoint already dispatches `start`, `migrate`, `keygen`, `rotate-key` and `docker-guard` (`docker/entrypoint.sh`). It gains:

| Command                                                          | Does                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openbots pair [--name <device name>] [--direct <url>] [--link]` | Makes a pairing straight in the database (no HTTP, no sign-in), prints the QR code in the terminal (`qrcode-terminal`) and, with `--link`, the link. On an install with no owner it marks the pairing `creates_owner` (V2) |
| `openbots devices [list \| revoke <id>]`                         | Lists and revokes, for a VM with no browser at hand                                                                                                                                                                        |
| `openbots relay`                                                 | The link's status and host id, and the relay URL in use                                                                                                                                                                    |

From the compose stack: `docker compose run --rm openbots pair`. From a Fly Machine: `fly ssh console -C "openbots pair"`. `install.sh --pair` runs it after `docker compose up -d` so a VPS install ends with the QR code on screen.

### 4.5 The pairing exchange

1. The phone opens a tunnel stream to the server (over the relay, or directly over https when `direct` answers) and runs the Noise IK handshake with its fresh static key and the pinned server key (5.3). Over https the handshake is skipped: TLS and the server's certificate stand in, and the phone pins nothing but the URL. (A direct address that is not https is refused, as the Mac app refuses one, except on a private network with a warning.)
2. The server sees a device key it does not know. Such a stream may carry one request only: `POST /devices/pair`.
3. The phone sends the code, its name, platform, Noise public key and a fresh push key. The server checks the code (constant time, unused, unexpired), creates the device and its API key, and answers the key once. From now on the stream, and every later one from that device key, carries any request with that bearer key.
4. The phone keeps the API key, its Noise key and the push key in the Keychain (an access group shared with the Notification Service Extension, section 6). It then registers for push and calls `PUT /devices/{id}/push`.

A used code is dead; a pairing that is not used in 5 minutes is dropped by the workers' upkeep. Pairings are capped at 5 open per owner.

---

## 5. The private relay

### 5.1 When it is used

| Server                                           | Public address                                                 | Path the phone takes                                      |
| ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------- |
| The Mac app's This Mac stack                     | None; the port is on loopback only                             | Relay                                                     |
| A self-hosted compose stack on a home Mac or NAS | None, or an ngrok or Cloudflare tunnel (`OPENBOTS_PUBLIC_URL`) | Direct when the tunnel is up, relay otherwise             |
| A VM (compose stack or standalone image)         | Optional                                                       | Relay by default; direct when the owner sets a public URL |
| An OpenBots account (managed)                    | Yes                                                            | Direct, always; the relay carries push only (section 6)   |

The relay removes port forwarding, DNS, TLS certificates and tunnel accounts from the path to "chat with my Bots from the train". It is not a tunnel for webhooks: external systems still need `OPENBOTS_PUBLIC_URL` (D3).

### 5.2 Components

| Component               | Where                                                                                                                                                                | Role                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/relay`            | A small Node service, image `ghcr.io/danielpang/openbots/relay`, hosted by the project at `relay.openbots.dev` (placeholder) and self-hostable with one `docker run` | Accepts host links and client connections, pairs them by host id, forwards frames, forwards push to APNs. Stateless apart from the live links; several instances share host presence through Redis                                                                                                          |
| `packages/tunnel`       | TypeScript, no Node-only dependencies                                                                                                                                | The Noise IK handshake and transport (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`, pure TypeScript so the same code runs in the server, the app and later the Mac app), the stream multiplexer, and the HTTP and WebSocket framing of 5.4. Tested against itself and against a Noise test vector set |
| `apps/server/src/relay` | In the server, role `api` (every API instance holds a link, so a client's stream lands on an instance that can serve it)                                             | `link.ts` dials the relay, proves the host identity, reconnects with backoff like `createWsClient`, publishes `relay.status`. `adapter.ts` terminates streams: handshake, device lookup, then loopback requests (5.5)                                                                                       |
| `OPENBOTS_RELAY_URL`    | `.env`                                                                                                                                                               | The relay to dial. Default: the project's hosted relay. Empty turns the relay off; a self-hosted relay's URL points at it. The Mac app's stack keeps the default                                                                                                                                            |

The server dials the relay only while it has at least one unrevoked device or an open pairing, so a fresh install makes no outbound connection until the owner pairs something.

### 5.3 Identity and trust

- **The host identity** is the `instance_keys` Ed25519 pair. The relay challenges a connecting host with a nonce and verifies the signature against the public key whose hash is the host id. Nobody can register as somebody else's host id, so a phone looking for `host` finds its own server or nothing.
- **The Noise handshake** is `Noise_IK_25519_ChaChaPoly_SHA256`: X25519, ChaCha20-Poly1305 and SHA-256 are all in Apple's CryptoKit, so a Swift client speaks it with no third-party crypto ([IOS_APP_PLAN.md](IOS_APP_PLAN.md), decision 2). The phone knows the server's X25519 static key from the QR code (derived from the Ed25519 key, the standard libsodium conversion) and sends its own static key in the first message, encrypted to the server's. The server knows every paired device's static key, so after the first message it already knows which device is calling, or that it is a pairing attempt (4.5). The relay, and anyone on the network, sees two handshake messages and ciphertext.
- **Forward secrecy** per stream from the ephemeral keys; a stolen server key does not open past traffic.
- **Keys at rest**: the server's in the database sealed with the master key (rotated with it, plan 4.9: a rotation re-seals, it does not change the key, so devices stay paired); the phone's in the Keychain, never backed up to iCloud (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
- **Revocation** removes the device's static key: its next handshake fails before any request is read.

### 5.4 Wire protocol

Relay side (what the relay sees):

| Endpoint                          | Frames                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wss://relay/v1/host`             | Host link. `challenge {nonce}` from the relay, `hello {hostId, publicKey, sig}` from the host, `linked`. Then binary frames `[stream id: u32][payload]`; control frames `open {stream}`, `close {stream, reason}`; `push {...}` from the host (section 6); `ping`/`pong` every 25 seconds |
| `wss://relay/v1/connect/{hostId}` | One client stream. The relay answers `open` when the host is linked, else closes with 4404 `host offline`. Binary frames are the stream's payload, both ways                                                                                                                              |

Inside a stream (what the relay cannot see), after the handshake, one framing for everything: a fixed binary header (type, id, flags, header length) followed by a JSON header and the body bytes, exactly as [RELAY_PROTOCOL.md](RELAY_PROTOCOL.md) section 5.2 lays it out:

| Frame       | Fields                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.req`  | `id`, `method`, `path` (with the query), `headers`, `body: boolean`                                                                                   |
| `http.body` | `id`, `chunk`, `end` (both directions; a request body streams, a response body streams)                                                               |
| `http.res`  | `id`, `status`, `headers`                                                                                                                             |
| `ws.open`   | `id`, `path`, `headers`; answered by `ws.opened` or `http.res` with the refusal                                                                       |
| `ws.msg`    | `id`, `text` or `binary`                                                                                                                              |
| `ws.close`  | `id`, `code`, `reason`                                                                                                                                |
| `credit`    | `id`, `bytes`: flow control, a 1 MiB window per request and per socket, so a 16 MiB upload and the screen's VNC frames do not starve the event socket |

Limits: 64 concurrent requests per stream, 4 streams per device (the app, the screen view, a download, a spare), frames of 64 KiB, a request body of 16 MiB (the files limit), a stream idle for 60 seconds without a ping is closed. The relay enforces its own: 8 streams per host, 50 MB per minute per host, 1,000 new streams an hour per host, and closes a link whose peer is 8 MiB behind, as the gateway does.

### 5.5 The server side adapter

A tunneled `http.req` becomes `fetch('http://127.0.0.1:<port>' + path, ...)` on the server's own port with the frame's headers, less a short denylist: `cookie`, `origin`, `sec-fetch-*`, `x-forwarded-*` and `host` never pass, so a tunneled request is never a browser request (plan 17 control 8 is unaffected) and never a trusted-proxy request. The adapter adds `x-openbots-device: <device id>`, which `client-ip.ts` turns into the rate-limit key for connections from loopback that carry it; `POST /devices/pair` on an unknown device keys on the stream's relay-assigned id. A tunneled `ws.open` becomes a `ws` connection to the same loopback port, so the gateway's upgrade path (`ws/gateway.ts`), the computer's `/computer/pty` and `/bots/{id}/screen/vnc` sockets work untouched.

Nothing about a device is special beyond its key: a tunneled request that forgets its bearer key gets 401 like any other.

### 5.6 Choosing the path

The app keeps, per server, the `direct` addresses from the QR code and the relay. On every connect it races: direct addresses first (each must answer `GET /healthz` and `GET /api/v1/me` with the device key within 3 seconds), then the relay. A direct answer wins and is remembered for the session; a failure falls back to the relay without the user noticing. The settings screen shows which path is in use ("Direct" or "Through the relay"), as the Mac app's sidebar icon names its connection. Over a direct https path there is no Noise layer: the device's bearer key authenticates it as any API caller.

### 5.7 What the relay knows, and self-hosting it

The hosted relay sees: host ids, when a host is linked, from which address, how many streams and bytes, push counts and APNs tokens in transit. It never sees request paths, message text, keys or the pairing code, and it stores none of what it sees beyond rate-limit counters. `docs/SECURITY.md` gains a section saying exactly this.

Self-hosting: `docker run -p 3200:3200 ghcr.io/danielpang/openbots/relay` behind any TLS terminator, `OPENBOTS_RELAY_URL` pointing at it on the server, and the relay URL in the QR code follows. A self-hosted relay cannot send push (the APNs key belongs to the App Store build, section 6); it carries the tunnel only. The relay's code is in the core under the same license as the server, so anyone may run one.

---

## 6. Push notifications

| Step                     | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which events             | `createNoticeWatcher` (`packages/shared/src/notices.ts`), unchanged: approvals, questions and `login_request` widgets, mentions of the owner, Routine exceptions, long tasks that finished (N1)                                                                                                                                                                                                                                                               |
| Where it runs            | `apps/server/src/workers/push.ts`, role `worker` (or `all`). It subscribes to the bus like the other workers, keeps a watcher per owner who has a device with a push token (refreshed on `device.*` events), and dedupes across instances with a Redis `SET NX` on `push:<device>:<tag>` for a day, since a notice has one `tag` per request                                                                                                                  |
| Payload                  | `{v: 1, kind, tag, title, body, target: {botId, chatId, seq, threadRootId}, host}` encrypted with ChaCha20-Poly1305 (IETF, 12 byte random nonce) under the device's `push_key`. Apple's CryptoKit opens it natively in the extension                                                                                                                                                                                                                          |
| Transport                | A `push` frame over the host link: `{token, ciphertext, collapseId: tag, priority: 10 for approvals and questions else 5, expiry: 1 day}`. The relay forwards it to APNs with the project's `.p8` key as `{"aps": {"alert": {"title": "OpenBots", "body": "You have a notification"}, "mutable-content": 1, "thread-id": <botId>}, "enc": "<base64>"}`. An APNs `410 Unregistered` comes back as `push.unregistered {token}` and the server forgets the token |
| On the phone             | A Notification Service Extension decrypts with the key from the shared Keychain, sets the real title and body, attaches the Bot's avatar from the app's cache, and groups by Bot. If it cannot decrypt (revoked, or a key the phone no longer has), the generic text stays. Tapping opens `openbots://bot/{id}/message/{seq}` (the Mac app's deep links, `apps/desktop/src/main/deep-links.ts`, reused)                                                       |
| Foreground               | The app receives the same event on its socket; the OS notification is suppressed while the app is open on that chat, as the Mac app skips a notice for the focused window                                                                                                                                                                                                                                                                                     |
| Without the hosted relay | No push. The app still gets everything on its socket while open, and a Lock Screen widget (M9) can poll `GET /approvals?status=pending` through Background App Refresh. A self-hosted relay carries the tunnel only (5.7)                                                                                                                                                                                                                                     |

The managed service and a self-hosted server with a public URL both still need the relay link for push, since only the hosted relay holds the APNs key; with a public URL the link carries push frames and nothing else (5.1).

---

## 7. The iOS app

### 7.1 Stack

The technology is chosen in [IOS_APP_PLAN.md](IOS_APP_PLAN.md), which weighs Expo, bare React Native, SwiftUI and a web shell against what the app has to do. Its choice: **Expo (React Native) with a Swift native layer, gated by a two week spike** on the three things React Native could get wrong (the tunnel from the phone, a transcript streaming at 60 fps, the notification extension), with SwiftUI as the named fallback.

What the app reuses whichever way it is built: `@openbots/api-client` (its `fetch` and `createSocket` are injected, so the tunnel plugs in as the Mac app's main process plugs in its cookie header in `apps/desktop/src/main/connection.ts`), `@openbots/shared` for events, parts, notices and policy, `packages/tunnel`, the Mac app's deep links, and the server's OpenAPI document. The extension that opens push payloads is Swift with CryptoKit in either case, which is why the Noise suite is one CryptoKit speaks (5.3). Releases ride the same `v*` tag as the images and the Mac app; the app checks `GET /api/v1/capabilities` at connect, and an older server shows "Update your server".

### 7.2 Servers

The app mirrors the Mac app's three ways to connect (D2, M1), saved as hosts:

| Kind                   | How it connects                                                                                                                                                                                                                                                                   | Credential                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Paired                 | The tunnel over the relay, or direct https from the QR code's `direct` list (5.6)                                                                                                                                                                                                 | Device API key, Noise key, push key |
| Self-hosted by address | Direct https; sign in natively through better-auth (`/api/auth/sign-in/email`, GitHub and Google through an `ASWebAuthenticationSession`), then `POST /devices/pairings` and `POST /devices/pair` on its own behalf so it becomes a device with a key and push like a paired host | Device API key, push key            |
| OpenBots account       | As a self-hosted address, against the hosted server (`OPENBOTS_CLOUD_URL`), with its email verification and organization switcher                                                                                                                                                 | As above                            |

So every host ends up as a device: one key kind, one revocation list, one push path. The session cookie from a sign-in is used once, to pair, and not kept.

### 7.3 Information architecture

Three tabs, in the web app's order where it applies (plan 14.3):

| Tab      | Screens                                                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bots     | The roster: pinned Bots, Bots, Groups, each row an avatar animated by `bot.state` with the name and label (I2). A Bot opens its transcript; a group its transcript with the members' avatars. New (a Bot from a name and an avatar, a group of 2 to 6 Bots) |
| Inbox    | Every pending approval, question and sign-in request across Bots, newest first, answered in place; a badge with the count. The tray of N2                                                                                                                   |
| Settings | Hosts (add, switch, remove; the path in use), This device (name, notifications, what each kind notifies), About                                                                                                                                             |

A transcript: the title bar with the name and a Preview button whose dot follows the computer tool state (K3 level 1), the transcript with threads and reactions, the composer with `@` mentions, the camera roll and files, and dictation from the keyboard. The Bot's menu opens Activity (the run's `run_steps`), Preview (M8), Artifacts, Routines and a read-only Settings summary (model, tools). Takeover, the terminal, files, connectors and providers are not on the phone (M10).

### 7.4 Connection lifecycle

- On launch and on foreground: connect (5.6), `refresh()` as the Mac app's connection does (`/me`, `/bots`, `/chats`, `/approvals?status=pending`), subscribe to every Bot and chat, and resync each open chat from its last `seq` (`GET /chats/{id}/resync?since=`). Deleted streaming messages come back under `deleted` and are dropped (plan 14.2).
- In the background iOS closes the socket within seconds; the app relies on push (section 6) and resyncs on return. No background socket is attempted.
- Transcripts are cached on the phone (SQLite through `expo-sqlite`) by chat and `seq`, so a transcript opens at once and the socket fills in the rest. The cache holds the last 200 messages per chat and is cleared when a host is removed.
- A 401 on the device key (revoked) signs the host out and shows "This phone was removed from <server>. Pair again."

### 7.5 Deep links

`openbots://bot/{id}/message/{seq}` and `openbots://chat/{id}/message/{seq}`, with `?thread=` and `?chat=`, exactly the Mac app's (`deep-links.ts`), plus `openbots://pair#...` and the universal link `https://openbots.dev/pair`. A link names no host, so the app opens it on the host whose data holds that Bot (ids are UUIDs; a miss shows the hosts list).

---

## 8. Server mode: OpenBots on a VM

### 8.1 Two shapes

| Shape                               | Where                                                                                                | Isolation                                                                                                                                                                                                                                                                    | Setup                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Compose stack** (today's install) | Any VM with Docker: EC2, Hetzner, DigitalOcean, a home server                                        | The full plan 9.5 model: computers are sibling containers on the sandbox network behind `docker-guard` and `sandbox-firewall`                                                                                                                                                | `install.sh --pair` (cloud-init on EC2, `deploy/ec2/cloud-init.yaml`) |
| **Standalone image** (new, V1)      | One container, no Docker inside: Fly Machines, Sprites, Modal, Railway, Render, also any Docker host | One kernel, one container: the server (uid 1000), Postgres, Redis and the computer agent (root, dropping every Bot process to the `bot` user as it does in the computer image, S-7) share it. No sandbox network, no firewall between the Bots' shells and the server's port | `docker run` with a volume on `/data`, then `openbots pair`           |

Choose the compose stack where Docker is available; it is the hardened path. The standalone image is for platforms that run one container, and for one person on one VM they own, the way one runs a coding agent on a VPS. The README says so in those words.

### 8.2 The standalone image

`docker/standalone.Dockerfile`, image `ghcr.io/danielpang/openbots/standalone`, built and released with the others on each `v*` tag:

| Part           | Detail                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base           | The computer image's runtime stage (Ubuntu 24.04 with Xvfb, Chromium, Playwright, x11vnc, websockify, xdotool, `openbots-runas`), plus the server's runtime stage (Node, `dist/`, the MCP catalog) and `postgresql-16` with `pgvector` and `redis-server` from apt                                                                        |
| Supervisor     | `s6-overlay`: `postgres` (unix socket `/run/postgresql`, data `/data/pgdata`), `redis` (`/data/redis`, append-only), `computer-agent` on `127.0.0.1:7070` (token in a root-only file under `/data/agent`, as the image does), `openbots` (role `all`) after the others are healthy. The container's `init` is s6                          |
| Volume         | `/data`: `pgdata`, `redis`, `files` (`OPENBOTS_FILES_DIR`), `home` (the Bots' `/home/bot`, bind-mounted), `agent` (the cookie store and profiles, root only), `.env`                                                                                                                                                                      |
| First boot     | `standalone-init` writes `/data/.env` as `install.sh` does when it is missing: `OPENBOTS_MASTER_KEY`, `OPENBOTS_DB_APP_PASSWORD`, `OPENBOTS_COMPUTER_AGENT_TOKEN`, `OPENBOTS_PUBLIC_URL=http://localhost:3000`, and initialises the database cluster. Secrets reach the server as files (`/run/openbots`), as the compose entrypoint does |
| Fixed settings | `DATABASE_URL` over the socket, `REDIS_URL=redis://127.0.0.1:6379`, `OPENBOTS_COMPUTER_AGENT_URL=http://127.0.0.1:7070`, `OPENBOTS_STDIO_RUNNER=computer` (stdio MCP servers run under the agent, as on the managed service), `DOCKER_HOST` unset. `OPENBOTS_DEPLOYMENT=managed` is refused at start (V6)                                 |
| Port           | 3000, optional: with the relay nothing needs to be published. `OPENBOTS_HTTP_BIND` has no meaning here; set `OPENBOTS_PUBLIC_URL` when a platform gives the container a public hostname and webhooks or connector OAuth are wanted                                                                                                        |
| Size           | About 2 GB of memory for Chromium, Postgres and Node together; 2 shared CPUs; a 10 GB volume to start                                                                                                                                                                                                                                     |
| Health         | `/readyz` from the server, and s6 restarts a service that dies                                                                                                                                                                                                                                                                            |

The `remote` computer provider's "one machine, one `/home/bot`" rule (plan 9.2) fits: a standalone server is one person's. The owner's timezone comes from `OPENBOTS_TIMEZONE` as today.

What a Bot's shell can reach that it could not in the compose stack: the server's port on loopback (every route needs a key the Bot does not have; `POST /devices/pair` is rate-limited and needs a code), the VM's cloud metadata address (block it in the platform's firewall or with the egress proxy allowlist, which the agent honours through `HTTP_PROXY`), and the VM's own network. The README's "Run OpenBots 24/7 on a VM" section states these plainly, and `SECURITY.md` records the shape as a known difference, not a finding.

### 8.3 Headless first run (V2)

1. The container starts; migrations run; no owner exists (`GET /api/v1/setup` is true).
2. `openbots pair` makes a pairing with `creates_owner` set and prints the QR code with `setup=1`.
3. The phone pairs (4.5). `POST /devices/pair` on such a pairing creates the owner the way `createLocalSession` does for the Mac app (`auth.ts`): through the same user hooks as setup, named from the body (the device's owner name, asked on the phone), with the placeholder email `owner@openbots.local` and no password. It then makes the device and its key in the same transaction. This is the local mode's owner without the local token: the server stays a normal self-hosted install, so the web app's sign-in keeps working once the owner sets credentials.
4. The phone's onboarding continues as the web wizard would: a name for the owner, a model provider key (`POST /providers`, with Test), and the first Bot. Each step is the existing route.
5. The phone's Settings > Account offers "Set an email and password for the web app" (better-auth's change-email and set-password endpoints), for a laptop that reaches the server by a public URL or, later, over the relay (8.6).

A server that already has an owner ignores `creates_owner`; a pairing with it that reaches a server which gained an owner meanwhile pairs as a device and nothing else.

### 8.4 Platform templates (`deploy/`)

| Platform                              | Template                                                                                                                                                                                                                                                                           | Notes                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fly.io                                | `deploy/fly/fly.toml`: the standalone image, a `[mounts]` volume `data` at `/data`, `auto_stop_machines = "off"`, `min_machines_running = 1`, `shared-cpu-2x` with 4 GB. `fly launch --copy-config`, `fly volumes create data`, `fly deploy`, `fly ssh console -C "openbots pair"` | A public `[http_service]` is optional; without one `fly ips` can stay empty and the relay is the only way in. Fly's `fly.io` hostname with TLS is one line when webhooks are wanted                                         |
| Sprites                               | `deploy/sprites/README.md`: a Sprite from the standalone image with its persistent disk at `/data`                                                                                                                                                                                 | Checkpoint and restore pause the VM; on restore Postgres resumes and the relay link reconnects within the backoff. Routines missed while paused run at the next tick (the scheduler is `next_run_at` based, plan section 3) |
| EC2, Hetzner, DigitalOcean            | `deploy/ec2/cloud-init.yaml`: installs Docker, runs `install.sh --pair`, prints the QR code to the instance's console log (`cloud-init` output) and leaves it in `/root/openbots-pair.txt` for `ssh`                                                                               | The compose stack, hardened. A security group with no inbound rule is enough with the relay                                                                                                                                 |
| Modal, Railway, Render, a Docker host | The standalone image with a volume at `/data`                                                                                                                                                                                                                                      | Modal Sandboxes are built for shorter work; a 24/7 server is possible with a Volume but the other platforms fit better. Said in the README                                                                                  |

### 8.5 Day two

- Upgrade: `docker pull` and restart (standalone), or `docker compose pull && docker compose up -d` (compose) as today. Migrations run at start. The image's computer agent is the same release, so no computer image pull is involved in standalone.
- Backup and restore: `scripts/backup.sh` and `restore.sh` already work from `DATABASE_URL` and `OPENBOTS_FILES_DIR` without Docker; in the standalone image they run inside the container (`docker exec <ctr> openbots backup /data/backups`) and add `home` and `agent` to the archive. A Fly volume snapshot is the coarse alternative.
- The relay link's health shows in Settings > Devices, `openbots relay`, `/metrics` (`openbots_relay_linked` 0 or 1, `openbots_relay_streams`), and the phone shows "Your server is offline" when the relay reports no host.
- Cost: a Fly Machine of that size runs at tens of dollars a month plus the provider's model usage, which the Bots' usage rows already show. The README says the number from Fly's pricing page at the time of writing.
- The Mac app's This Mac stack remains the free option; it pauses while the Mac sleeps (plan 14.4), which is the reason to move to a VM.

### 8.6 Later: the Mac app and the web app over the relay

The Mac app's main process is Node and can run `packages/tunnel` as the server does. A fourth connection kind, "Connect to a paired server" (scan the QR code with the Mac's camera or paste the link), would terminate the tunnel in the main process and serve the renderer through a loopback proxy, so a laptop reaches a VM with no public URL. The web app in a browser could do the same with the tunnel compiled for the browser and a Service Worker, as Paseo's web app does. Neither is in this plan's phases; both reuse everything above.

---

## 9. Security

Additions to plan section 17's trust boundaries, most to least trusted: the server core; **a paired device** (holds an owner key: a phone is the owner, so a stolen unlocked phone is an owner, mitigated by Face ID on the app, revocation in Settings > Devices, and keys that never leave the device); **the relay** (sees metadata, never content; a compromised relay can refuse service and count, nothing else); MCP servers; the computer sandbox; webhook payloads and model output.

| Threat                                   | Control                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pairing link is seen by someone else   | It is good for 5 minutes and once; the first to use it wins, and the owner sees a device they did not pair in Settings > Devices and revokes it. Pairing is audited with the device name and the path used                                              |
| Guessing a pairing code                  | 32 random bytes, hashed at rest, constant-time compare; 10 attempts an hour per client, 5 per code, then the code is dead (as the managed sign-up's codes, plan 21.6)                                                                                   |
| A relay that lies about which host it is | The phone pins the server's key from the QR code; the handshake fails against any other                                                                                                                                                                 |
| A host id squatter                       | The relay challenges each host link with a nonce signed by the host's key                                                                                                                                                                               |
| Traffic analysis at the relay            | Known and accepted: sizes and timing leak, content does not. Stated in SECURITY.md                                                                                                                                                                      |
| A device key used from elsewhere         | It is a bearer key like any API key (U4). Over the relay it only works inside a Noise session with the matching device static key, so a leaked key alone is not enough there; over a direct https path it is, as any API key is. Revocation covers both |
| Push content at Apple or the relay       | Encrypted for the device; Apple and the relay see "You have a notification" and a Bot id                                                                                                                                                                |
| The standalone image's shared kernel     | Section 8.2: uid separation, root-only cookie store, the agent's token out of every child's environment (S-7), the server's port needing a key. Documented as the shape's trade-off, with the compose stack as the hardened alternative                 |
| Revocation lag                           | `device.revoked` on the bus closes streams on every API instance within a second; the API key is deleted in the same transaction, so a request in flight after it fails                                                                                 |

Checks that join the README's hardening list: a Node test client cannot complete a handshake with a revoked key; a tunneled request with `cookie` or `origin` set arrives at the server without them; the relay refuses a second host link for the same id without a valid signature; `org-isolation.test.ts` walks the device routes as another organization's owner.

---

## 10. Repository layout additions

```
openbots/
  apps/
    mobile/              Expo app: app/ (expo-router screens), src/ (hosts, tunnel transport, transcript views), ios/ (the NSE target)
    relay/               The relay service: host links, client streams, APNs gateway, Redis presence
    server/src/relay/    link.ts (dial, identity, backoff, status), adapter.ts (streams to loopback)
    server/src/routes/devices.ts
    server/src/workers/push.ts
    server/src/cli/      pair.ts, devices.ts, relay.ts (entrypoint subcommands)
  packages/
    tunnel/              Noise IK, stream mux, http and ws framing; shared by server, mobile and later desktop
  docker/
    standalone.Dockerfile
    standalone/          s6 service definitions, standalone-init
    relay.Dockerfile
  deploy/
    fly/fly.toml
    sprites/README.md
    ec2/cloud-init.yaml
```

Release: `.github/workflows/release.yml` adds the `standalone` and `relay` images to the matrix; `release-mobile.yml` runs EAS Build for the tag and uploads to TestFlight when the Apple secrets are set, as `release-mac.yml` does for signing.

---

## 11. Implementation plan

| Phase                                             | Deliverables                                                                                                                                                                                                                                                                                                                                               | Done when                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Devices, relay, pairing** (server side only) | `packages/tunnel` with tests and Noise vectors; `apps/relay` with its image; `instance_keys`, `devices`, `device_pairings` and the migration; `routes/devices.ts`; `relay/link.ts` and `adapter.ts`; `openbots pair`, `devices`, `relay`; Settings > Devices in the web app with the QR code; "Pair your phone…" in the Mac app; the hosted relay deployed | A Node test client (in `apps/relay/test`) pairs through the relay against a server with `OPENBOTS_RELAY_URL` set, lists Bots, streams a reply on `/ws`, uploads a 16 MiB file; revoking closes its stream and its next handshake fails; restarting the relay reconnects the link; the hardening checks of section 9 pass |
| **2. iOS app MVP**                                | `apps/mobile`: hosts and pairing by QR, the roster, transcripts with streaming, the composer with photos and files, approvals, questions and sign-in requests, the Inbox, push with the extension, deep links, resync on foreground, the SQLite cache; TestFlight                                                                                          | The chat controls in `docs/UI_REVIEW.md` walked on the phone; a notification tapped opens the message; a day on a phone with the app closed misses no notice                                                                                                                                                             |
| **3. Server mode**                                | `docker/standalone.Dockerfile` and `standalone/`, headless pairing with owner creation, `deploy/` templates, `install.sh --pair`, backup and restore inside the image, README section "Run OpenBots 24/7 on a VM", SECURITY.md section on the shape                                                                                                        | A Fly Machine from the image pairs from `fly ssh console`, the phone creates the owner, a provider and a Bot, and a Routine runs at its time with the phone off; `docker pull` of the next version keeps the data; the EC2 template ends with the QR code in the console log                                             |
| **4. Phone, second pass**                         | Screen preview and Artifacts in the WebView bridge, Activity, Routines, groups management, reactions and threads, sign in by address and OpenBots account (7.2), Face ID lock, App Store release                                                                                                                                                           | Every M8 item on the phone; the three host kinds; App Review passed                                                                                                                                                                                                                                                      |
| **5. Later**                                      | Share sheet, Siri Shortcuts, the Home Screen widget, Live Activities, Android from the same code, the Mac app over the relay (8.6)                                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                          |

Phases 1 and 3 need no app and can be built and tested with the Node client; phase 2 starts as soon as phase 1's relay and routes are stable.

---

## 12. Decisions to confirm

1. **The app's stack** (7.1), weighed in [IOS_APP_PLAN.md](IOS_APP_PLAN.md) section 3. Recommended there: Expo with a Swift native layer, gated by a two week spike, with SwiftUI as the fallback. Confirm it, or choose SwiftUI now if Android is ruled out and fidelity outranks shared code.
2. **The hosted relay**: the project runs one at a project domain, free, with the rate limits of 5.4, and it is the only path for push. Confirm the domain, who operates it and the budget. The relay code is in the core and self-hostable, not in `ee/`.
3. **A device key is an owner key** (4.2, section 9). Recommended for 1.0; scoped keys (read-only, approve-only) later with the admin model allowlist (L7).
4. **The standalone image is a supported shape** with its weaker isolation stated (8.1, 8.2), or the compose stack stays the only supported server and the standalone image is marked experimental.
5. **Headless owner creation at pairing** (8.3). Recommended; the alternative is requiring the web wizard first, which needs a public URL or a tunnel on every VM.
6. **A server with no public URL** has no webhooks and no connector OAuth (5.1). Accepted as is, or the relay later also forwards `/hooks/*` for inbound webhooks (it would have to see those requests in the clear, which changes 5.7).
7. **Android**: build from the Expo code once the iOS app is stable, or hold until asked.
8. **The Mac app over the relay** (8.6): schedule it with phase 4 or leave it in Later.

---

## Prior art

- Paseo ([repository](https://github.com/getpaseo/paseo), [site](https://paseo.sh/)): a daemon on the owner's machine, an Expo mobile app, an untrusted end-to-end encrypted relay (its hosted one is Elixir), pairing by QR code with the daemon's key in the URL fragment, and direct connection over the LAN, Tailscale or a tunnel as the alternative. This plan takes the relay's trust model, the pairing anchor and the Expo choice.
- opencode ([CLI commands](https://opencode.ai/v2/docs/cli/commands/)): `opencode serve` for a headless server, `opencode pair` printing one-time links and a QR code that expire in 5 minutes, `--remote` to pair through a tunnel with an explicit consent prompt, and `opencode service` for the background server. This plan takes `openbots pair` and the 5 minute, one-use code.
