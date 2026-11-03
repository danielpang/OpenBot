# @openbots/relay

The OpenBots private relay. A server with no public address keeps an outbound WebSocket to the relay (a _host link_), and a phone reaches that server by opening a _stream_ to the relay by host id. The relay pairs the two and pipes bytes between them. Inside a stream the phone and the server run their own Noise handshake, so the relay carries ciphertext it cannot read. The relay also forwards encrypted push notices to Apple's push service for the App Store build.

The wire contract is [docs/RELAY_PROTOCOL.md](../../docs/RELAY_PROTOCOL.md) (sections 3 and 4 for the relay); the design background is [docs/MOBILE_AND_VM_PLAN.md](../../docs/MOBILE_AND_VM_PLAN.md) section 5.

## Endpoints

| Endpoint                   | What it is                                                                     |
| -------------------------- | ------------------------------------------------------------------------------ |
| `GET /v1/host`             | WebSocket. A server's host link: challenge, signed `hello`, then streams       |
| `GET /v1/connect/{hostId}` | WebSocket. One client stream to that host                                      |
| `GET /v1/hosts/{hostId}`   | `{"hostId","linked"}`: whether the host is linked right now (404 for a bad id) |
| `GET /healthz`             | 200 while the relay is up                                                      |

## Settings

All settings come from the environment. Push needs all four of the key file, key id, team id and topic; with any of them missing the relay carries streams only and answers every push `unavailable`.

| Variable                 | Default      | Meaning                                                                                                                                       |
| ------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_PORT`             | `3200`       | The port to listen on                                                                                                                         |
| `RELAY_HOST`             | `0.0.0.0`    | The address to listen on                                                                                                                      |
| `RELAY_TRUST_PROXY`      | `false`      | `true` takes the client address from the last `x-forwarded-for` hop (the one your proxy adds). Set it only when a proxy you run sits in front |
| `RELAY_APNS_KEY_FILE`    |              | Path to the APNs `.p8` key (token based authentication)                                                                                       |
| `RELAY_APNS_KEY_ID`      |              | The key's id, from the Apple developer account                                                                                                |
| `RELAY_APNS_TEAM_ID`     |              | The Apple developer team id                                                                                                                   |
| `RELAY_APNS_TOPIC`       |              | The app's bundle id                                                                                                                           |
| `RELAY_APNS_ENVIRONMENT` | `production` | `production` or `sandbox` (development builds of the app)                                                                                     |
| `RELAY_LOG_LEVEL`        | `info`       | A pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                  |

## Running it

The relay speaks plain HTTP and WebSocket. Run it behind any TLS terminator (Caddy, nginx, a cloud load balancer) that passes WebSocket upgrades, and point servers at its `wss://` URL with `OPENBOTS_RELAY_URL`.

```sh
docker build -f docker/relay.Dockerfile -t ghcr.io/danielpang/openbots/relay .
docker run -d --name openbots-relay -p 3200:3200 \
  -e RELAY_TRUST_PROXY=true \
  ghcr.io/danielpang/openbots/relay
```

With push (only the project's own relay has the App Store key):

```sh
docker run -d --name openbots-relay -p 3200:3200 \
  -e RELAY_TRUST_PROXY=true \
  -v /srv/openbots/apns.p8:/run/secrets/apns.p8:ro \
  -e RELAY_APNS_KEY_FILE=/run/secrets/apns.p8 \
  -e RELAY_APNS_KEY_ID=... -e RELAY_APNS_TEAM_ID=... -e RELAY_APNS_TOPIC=... \
  ghcr.io/danielpang/openbots/relay
```

The image runs as an unprivileged user, writes nothing to disk and answers its healthcheck on `/healthz`. It stops cleanly on SIGTERM: every client and host link is closed with 1001, and servers reconnect to whatever comes up next.

For development, from the repository root:

```sh
pnpm --filter @openbots/relay dev
```

In another package's tests, run one in process:

```ts
import { createRelay } from '@openbots/relay';

const relay = await createRelay({ port: 0, host: '127.0.0.1' });
// relay.url is http://127.0.0.1:<port>; WebSocket clients use ws:// on the same origin.
await relay.close();
```

## Limits

Per host, across all its links: 8 open streams (a ninth client is closed 4429), 1,000 stream opens an hour (4429), 50 MB a minute of stream data in either direction (the link is closed 1008), and 600 push frames an hour (`push.result` error 429). A socket whose send buffer passes 8 MiB is closed 1008. A host link is pinged every 25 seconds and closed 1001 after 50 seconds without a pong. Counters are fixed windows kept in memory.

This version is a single instance with in-memory state. Presence and counters sit behind the registry in `src/hosts.ts`, so a shared store (Redis) can replace them when several instances run.

## What the relay sees, and what it does not

It sees host ids, when a host links and from which address, how many streams each host has open, how many bytes they carry, and push counts. It sees APNs device tokens in transit, only long enough to send each notice. It never sees request paths, message text, keys or pairing codes: those are inside the Noise session between the phone and the server, and push notices arrive already encrypted for the device. It stores none of what it sees beyond the rate limit counters, and those live in memory. Its logs carry host ids, addresses and counts, never device tokens or payloads.

A self-hosted relay cannot send push, since the APNs key belongs to the App Store build. It carries the tunnel only.
