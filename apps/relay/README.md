# @openbots/relay

The OpenBots private relay. A server with no public address keeps an outbound WebSocket to the relay (a _host link_), and a phone reaches that server by opening a _stream_ to the relay by host id. The relay pairs the two and pipes bytes between them. Inside a stream the phone and the server run their own Noise handshake, so the relay carries ciphertext it cannot read. The relay also forwards encrypted push notices to Apple's push service for the App Store build.

The wire contract is [docs/RELAY_PROTOCOL.md](../../docs/RELAY_PROTOCOL.md) (sections 3 and 4 for the relay); the design background is [docs/MOBILE_AND_VM_PLAN.md](../../docs/MOBILE_AND_VM_PLAN.md) section 5.

## Endpoints

| Endpoint                   | What it is                                                                  |
| -------------------------- | --------------------------------------------------------------------------- |
| `GET /v1/host?hostId=...`  | WebSocket. A server's host link: challenge, signed `hello`, then streams    |
| `GET /v1/connect/{hostId}` | WebSocket. One client stream to that host                                   |
| `GET /v1/hosts/{hostId}`   | `{"hostId","linked"}`: whether the host is linked now, on any machine       |
| `GET /healthz`             | 200 while the process is up (liveness)                                      |
| `GET /ready`               | 200 `{"status":"ready"}` while this machine takes new connections, else 503 |
| `GET /metrics`             | Prometheus metrics, with `Authorization: Bearer <RELAY_METRICS_TOKEN>`      |

`/ready` answers 503 `{"status":"unready","reasons":[...]}` with one or more of `draining`, `cluster_too_small` (fewer live machines than `RELAY_MIN_CLUSTER_SIZE`) and `at_capacity` (the socket ceiling is reached). A Redis that does not answer leaves the machine ready (it serves on, degraded) and adds `"degraded":["registry_unreachable"]` to the body. A load balancer should route only to ready machines. `/metrics` answers 404 when no token is set, and 401 without the right one.

## Settings

All settings come from the environment. Push needs all four of the key file, key id, team id and topic; with any of them missing the relay carries streams only and answers every push `unavailable`.

| Variable                 | Default      | Meaning                                                                                                                                       |
| ------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_PORT`             | `3200`       | The port to listen on                                                                                                                         |
| `RELAY_HOST`             | `0.0.0.0`    | The address to listen on                                                                                                                      |
| `RELAY_TRUST_PROXY`      | `false`      | `true` takes the client address from the last `x-forwarded-for` hop (the one your proxy adds). Set it only when a proxy you run sits in front |
| `RELAY_APNS_KEY_FILE`    |              | Path to the APNs `.p8` key (token based authentication). It must be readable by the relay's user (1000 in the image)                          |
| `RELAY_APNS_KEY`         |              | The `.p8` key itself, or its base64, instead of a file. Read once at start, then deleted from the process environment                         |
| `RELAY_APNS_KEY_ID`      |              | The key's id, from the Apple developer account                                                                                                |
| `RELAY_APNS_TEAM_ID`     |              | The Apple developer team id                                                                                                                   |
| `RELAY_APNS_TOPIC`       |              | The app's bundle id                                                                                                                           |
| `RELAY_APNS_ENVIRONMENT` | `production` | The APNs environment of a push frame that names none. Each frame normally names its own (`production` or `sandbox`)                           |
| `RELAY_LOG_LEVEL`        | `info`       | A pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                  |

For several machines, draining and metrics:

| Variable                         | Default                       | Meaning                                                                                                                                                                                        |
| -------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_REDIS_URL`                |                               | The shared registry. Required when more than one machine serves the same hostname. Unset, the relay runs alone in memory                                                                       |
| `RELAY_NODE_ID`                  | `FLY_MACHINE_ID`, else random | This machine's id in the registry. On Fly leave it unset: it must be the Machine id that `fly-replay` names                                                                                    |
| `RELAY_MIN_CLUSTER_SIZE`         | `1`                           | While fewer live machines than this are registered, `/ready` answers 503 and no new lease is taken                                                                                             |
| `RELAY_LEASE_MS`                 | `30000`                       | How long a host's lease lives in the registry without a renewal                                                                                                                                |
| `RELAY_LEASE_RENEW_MS`           | `10000`                       | How often the owner renews each lease. Must be below `RELAY_LEASE_MS`                                                                                                                          |
| `RELAY_NODE_TTL_MS`              | `15000`                       | How long a machine's node key lives. Once it is gone, another machine may take its hosts at once                                                                                               |
| `RELAY_NODE_HEARTBEAT_MS`        | `5000`                        | How often a machine refreshes its node key. Must be below `RELAY_NODE_TTL_MS`                                                                                                                  |
| `RELAY_DRAIN`                    | `false`                       | `true` starts the machine draining: not ready, no new upgrades or leases                                                                                                                       |
| `RELAY_DRAIN_GRACE_MS`           | `20000`                       | How long a draining machine lets links and streams go on before it closes them with 1012                                                                                                       |
| `RELAY_METRICS_TOKEN`            |                               | The bearer token for `GET /metrics`, at least 16 characters. Unset, the route answers 404                                                                                                      |
| `RELAY_PRESENCE_TOKEN`           |                               | A bearer token, at least 16 characters, that `GET /v1/hosts/{id}` then wants. Unset, presence is open to anyone with a host id                                                                 |
| `RELAY_REPLAY`                   | `fly` on Fly, else `off`      | `fly` answers an upgrade for a host another machine owns with `fly-replay`; `off` serves every upgrade where it lands. On by itself where `FLY_MACHINE_ID` is set                              |
| `RELAY_REDIS_COMMAND_TIMEOUT_MS` | `2000`                        | How long one Redis call may take before it fails                                                                                                                                               |
| `RELAY_MAX_SOCKETS`              | `20000`                       | Sockets on this machine (host links and streams). Past it, upgrades for hosts this machine does not own are refused with 503; at 10 percent more, every upgrade is                             |
| `RELAY_BUDGET_BYTES`             | `536870912`                   | Bytes in flight on this machine (512 MiB). A sender that would pass it is closed with 1013                                                                                                     |
| `RELAY_HOST_BUDGET_SHARE`        | `0.125`                       | The share of `RELAY_BUDGET_BYTES` one host's links and streams may hold together, above 0 and at most 1. A stream that would pass it is closed with 1013, so one host cannot starve the others |
| `RELAY_FLOW_HIGH_WATER_BYTES`    | `1048576`                     | A receiver whose send buffer passes this (1 MiB) pauses the sockets that feed it                                                                                                               |
| `RELAY_FLOW_LOW_WATER_BYTES`     | `262144`                      | Paused senders resume once the receiver's buffer is back at or below this (256 KiB)                                                                                                            |
| `RELAY_DELIVERY_TIMEOUT_MS`      | `30000`                       | A receiver that stays behind this long is closed with 1013 (shed)                                                                                                                              |

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

The image runs as an unprivileged user, writes nothing to disk and answers its healthcheck on `/healthz`. On SIGTERM it drains (below): it reports not ready, takes nothing new, and closes what is left with 1012 after the grace period, so servers and phones reconnect to whatever serves next. Give the container a stop timeout longer than `RELAY_DRAIN_GRACE_MS` (`docker stop -t 30`).

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

The full table is in [docs/RELAY_PROTOCOL.md](../../docs/RELAY_PROTOCOL.md) 3.4. Clients are not authenticated at the relay, so nothing a client does closes its host's link, and what a client can spend is limited per client address too. Per host, across all its links: 8 open streams (a ninth client is closed 4429), 1,000 stream opens an hour counted once a stream carries its first payload (4429), 50 MB a minute of host to client data (the stream that passes it is closed 1008, the link stays), and 600 push frames an hour (`push.result` error 429). Per client address: 4 open streams to one host, 60 opens a minute to one host and 300 to all hosts (4429), and 50 MB a minute of client to host data, as is each stream (1008). A stream with no payload 5 seconds after it opens is closed 4400. A socket whose send buffer passes 8 MiB is closed 1008. A host link is pinged every 25 seconds and closed 1001 after 50 seconds without a pong; a phone is pinged too, but never dropped for a missed pong while flow control has paused it. Counters are fixed windows cut by the registry's clock.

Without `RELAY_REDIS_URL` the counters are kept in memory by the one machine; with it they are kept in Redis, so they hold across machines. Host to client bytes are added to the shared total once a second. When Redis cannot be reached, each machine counts every host in memory with the same limits until Redis answers again, so the limits loosen across machines but never lapse; a push past the local count still gets error 429.

## Each machine on its own

These hold with or without Redis:

- **Flow control** (`src/flow.ts`). A receiver whose send buffer passes 1 MiB pauses the sockets that feed it (`ws.pause()`), and they resume once it is back at 256 KiB, so bytes from a fast server never pile up behind a slow phone. Toward a host, each stream also has its own share of the link's buffer: a stream past its share is paused alone, and only a link that is itself past its mark pauses every stream on it. Toward a phone, the shared host link is never paused for one slow phone; the tunnel's own credit window limits what the server sends it.
- **Shedding.** A receiver that stays behind for 30 seconds is closed with 1013 (try again later).
- **One byte budget and a socket ceiling** (`src/budget.ts`). The machine holds at most 512 MiB in flight across all sockets, and one host (its links and streams together) at most an eighth of that (`RELAY_HOST_BUDGET_SHARE`); a sender that would pass either is closed with 1013, and a host's own control frames are never refused. Past 20,000 sockets, upgrades for hosts this machine does not own are refused with 503, so a load balancer picks another machine; links and streams of the hosts it owns are still admitted, up to 22,000. Each socket's share is given back when it closes, however it closes.
- **Drain** (`src/drain.ts`). On SIGTERM, or with `RELAY_DRAIN=true`, the machine reports not ready, takes no new upgrades, pushes or leases, gives up its leases, and right after closes each host link with 1012 once the pushes in flight on it are answered, so servers relink elsewhere at once. After 20 seconds (or once nothing is left) it closes what remains with 1012.
- **Readiness and metrics** (`src/readiness.ts`, `src/metrics.ts`): `/ready` and `/metrics` above. Every metric is named `openbots_relay_*`, and none carries a host id or an address.

## Several machines

The shared relay runs as several machines behind one hostname ([docs/MOBILE_AND_VM_PLAN.md](../../docs/MOBILE_AND_VM_PLAN.md) section 5.8). One machine owns each host id at a time, held as a lease in Redis (`relay:host:<hostId>`, with a fencing epoch from `relay:epoch:<hostId>`) and renewed every 10 seconds, and every link of that server and every phone stream for it end on that machine, so stream bytes never cross machines. A machine that gets a connection for a host another live machine owns answers the upgrade with `307` and `fly-replay: instance=<machine id>`, and Fly's proxy replays it on the owner; a request that already carries `fly-replay-src` is never replayed again. Replays happen only on Fly (or with `RELAY_REPLAY=fly`): a relay of several machines anywhere else needs a load balancer with sticky routing by host id. A replay to a machine that has just gone fails at Fly's proxy, and the client reconnects through normal routing; the machine drops out of the node set (`relay:nodes`) within 15 seconds. A machine is alive while its node key (`relay:node:<machine id>`) is, so the hosts of a machine that dies move within `RELAY_NODE_TTL_MS`. A renewal that cannot reach Redis keeps the host until its lease would have run out, and a machine that cannot refresh its node key for `RELAY_NODE_TTL_MS` gives its leases up itself. While Redis cannot be reached, a new host link is served on the machine it reaches, alone and without a lease, and takes the lease once Redis is back (or closes 1012 if another machine took the host). A machine that loses a lease closes that host's links and streams with 1012, and they reconnect through normal routing. Presence (`GET /v1/hosts/{hostId}`) reads the registry, so any machine answers it. The wire protocol is unchanged: a single machine without Redis behaves as one always has. [deploy/relay-fly](../../deploy/relay-fly/README.md) runs it on Fly.

## What the relay sees, and what it does not

It sees host ids, when a host links and from which address, how many streams each host has open, how many bytes they carry, and push counts. It sees APNs device tokens in transit, only long enough to send each notice. It never sees request paths, message text, keys or pairing codes: those are inside the Noise session between the phone and the server, and push notices arrive already encrypted for the device. It stores none of what it sees beyond the rate limit counters, in memory or, with several machines, in Redis beside which machine owns each host id and whether it serves streams. Its logs carry host ids, addresses and counts, never device tokens or payloads.

A self-hosted relay cannot send push, since the APNs key belongs to the App Store build. It carries the tunnel only.
