# The OpenBots relay on Fly.io

This runs the shared relay (`ghcr.io/danielpang/openbots/relay`) as several Fly Machines behind one hostname, so it scales out and survives a Machine going away. It is how the project runs the relay that every install without its own uses. You only need it to run a relay for many servers; one server or a small group is served well by a single relay container (see [apps/relay/README.md](../../apps/relay/README.md)).

The design is [docs/MOBILE_AND_VM_PLAN.md](../../docs/MOBILE_AND_VM_PLAN.md) section 5.8. In short: one Machine owns each host id at a time, recorded in Redis with a lease. Every link of that server and every phone stream for it end on that Machine, so stream bytes never cross Machines. A Machine that gets a connection for a host another Machine owns answers with `fly-replay`, and Fly's proxy replays the request on the owner.

You need [flyctl](https://fly.io/docs/flyctl/install/) and a Fly.io account.

## Create the app

From a checkout of this repository:

```sh
cd deploy/relay-fly
fly launch --copy-config --no-deploy --name <your app>
```

`fly launch` keeps this file's settings and writes your app name and region into it. Pin a release in `[build] image` (for example `ghcr.io/danielpang/openbots/relay:1.2`) before the first deploy, so a deploy never upgrades by surprise.

## Create the Redis

The Machines share one Redis for the registry (who owns which host), node liveness, and the per host limits. Either use Upstash through Fly:

```sh
fly redis create            # pick the app's primary region; note the redis:// URL it prints
```

or run a Redis Machine of your own on the organization's private network (another Fly app with a volume, reachable at `<that app>.internal:6379`, with a password set). Either way, the relay only needs its URL. Put it close to the primary region: every lease renewal and every new connection asks it.

## Set the secrets

Fly secrets reach the Machines as environment variables. Setting them restarts the Machines.

```sh
fly secrets set RELAY_REDIS_URL='redis://default:<password>@<host>:6379'
fly secrets set RELAY_METRICS_TOKEN="$(openssl rand -hex 32)"
```

`RELAY_REDIS_URL` is required as soon as more than one Machine runs: without it each Machine believes it is the only one, and a phone that lands on a Machine other than its server's gets 4404. `RELAY_METRICS_TOKEN` turns on `GET /metrics`; without it the route answers 404.

Push needs the project's APNs key, and only the project's own relay has one (it belongs to the App Store build). The key reaches the Machine as a file, through the `[[files]]` section of `fly.toml`, from a secret that holds the `.p8` file in base64:

```sh
fly secrets set RELAY_APNS_KEY="$(base64 < AuthKey_XXXXXXXXXX.p8 | tr -d '\n')" \
  RELAY_APNS_KEY_ID=XXXXXXXXXX \
  RELAY_APNS_TEAM_ID=YYYYYYYYYY \
  RELAY_APNS_TOPIC=dev.openbots.app
```

A relay without push (it carries the tunnel only, and answers every push `unavailable`): remove the `[[files]]` section and the `RELAY_APNS_KEY_FILE` line from `fly.toml`, and set none of these.

Leave `RELAY_NODE_ID` unset. On Fly the relay uses the Machine's own `FLY_MACHINE_ID`, which is the id `fly-replay: instance=` needs.

## Deploy and scale

```sh
fly deploy
fly scale count 2                                # the minimum: one Machine can go while the other serves
fly scale count 4 --region iad,fra,sin           # spread across regions
fly status
fly checks list
```

Keep at least two Machines (`min_machines_running = 2`). Spread them over the regions your users are in: a phone and its server both connect to the hostname, Fly's proxy takes each to a nearby Machine, and the one that does not own the host replays to the one that does. The replay is one hop inside Fly's network, and only on connect.

Each Machine takes up to 20,000 sockets (host links and phone streams together, `RELAY_MAX_SOCKETS`). `[http_service.concurrency]` matches it: past the soft limit of 16,000 the proxy prefers other Machines, and at 20,000 it sends no more. A Machine that is full answers `/ready` with 503 and refuses new upgrades with 503, so the proxy picks another. Scale out before Machines stay near the soft limit. Each also holds at most 512 MiB of bytes in flight (`RELAY_BUDGET_BYTES`), which is why the Machine has 2 GB of memory; raise both together.

## A custom hostname

The app answers at `https://<your app>.fly.dev` at once. For your own name:

```sh
fly ips list                                  # add an A record for the IPv4 and an AAAA record for the IPv6
fly certs add relay.example.com
fly certs show relay.example.com              # wait until the certificate is issued
```

Fly terminates TLS and passes WebSocket upgrades through. Point servers at it with `OPENBOTS_RELAY_URL=wss://relay.example.com`.

## Deploying without dropping connections

`fly deploy` replaces one Machine at a time (`strategy = "rolling"`, `max_unavailable = 1`). Each old Machine gets SIGTERM and drains:

1. `/ready` answers 503 with `"draining"`, so the proxy sends it nothing new.
2. It refuses new upgrades and takes no new leases.
3. It gives up the leases it holds, so another Machine can take each host at once.
4. After 20 seconds (`RELAY_DRAIN_GRACE_MS`), or sooner once nothing is left, it closes the remaining host links and streams with 1012 (service restart).

Servers and phones reconnect through the hostname and land on a Machine that owns, or now takes, their host. A phone sees a reconnect; it does not lose its place, since the app resyncs from its last sequence number. `kill_timeout = 30` gives the drain its 20 seconds and room to close; keep it above the grace period if you change either.

To take one Machine out of service by hand without a deploy, set `RELAY_DRAIN=true` on it (`fly machine update <id> --env RELAY_DRAIN=true`). It restarts draining and stays not ready until you set it back to `false`.

## Metrics

`GET /metrics` serves Prometheus text with `Authorization: Bearer <RELAY_METRICS_TOKEN>`. From your machine:

```sh
curl -H "Authorization: Bearer $RELAY_METRICS_TOKEN" https://relay.example.com/metrics
```

That reaches whichever Machine the proxy picks. To scrape each Machine, use Fly's private network from a Prometheus inside the organization (`<machine id>.vm.<your app>.internal:3200`), or Fly's managed Prometheus with a `[metrics]` section if you prefer. The series, all prefixed `openbots_relay_`:

| Metric                               | What it counts                                                     |
| ------------------------------------ | ------------------------------------------------------------------ |
| `sockets{kind}`                      | Open host links (`host`) and phone streams (`client`)              |
| `hosts_owned`                        | Host ids this Machine holds the lease for                          |
| `streams`                            | Open phone streams                                                 |
| `replays_total{kind}`                | Connections replayed to the owning Machine                         |
| `rejections_total{reason}`           | Connections turned away: `sockets`, `bytes`, `draining`, and so on |
| `bytes_forwarded_total{direction}`   | Stream bytes `to_host` and `to_client`                             |
| `paused_sources`                     | Senders paused because the other end is behind                     |
| `blocked_destinations`               | Receivers above their high-water mark                              |
| `shed_peers_total{kind}`             | Receivers closed 1013 after staying blocked for 30 seconds         |
| `lease_renewals_total{result}`       | Lease renewals, `ok` or `failed`                                   |
| `lease_losses_total{reason}`         | Leases lost or given up                                            |
| `budget_bytes`, `budget_bytes_limit` | Bytes in flight, and the budget                                    |
| `budget_sockets_limit`, `draining`   | The socket ceiling, and 1 while draining                           |
| `cluster_size`                       | Live Machines this one sees                                        |

Plus Node's process metrics (CPU, memory, event loop lag) under the same prefix. Watch `shed_peers_total` and `rejections_total{reason="bytes"}`: a steady rise means Machines are short of memory or phones are on poor networks. Watch `lease_losses_total`: outside deploys it should stay flat.

## What the relay sees and stores

It sees host ids, when a host links and from which address, how many streams each host has open, how many bytes they carry, and push counts. It sees APNs device tokens in transit, only long enough to send each notice. It never sees request paths, message text, keys or pairing codes: those are inside the Noise session between the phone and the server, and push notices arrive already encrypted for the device.

Redis holds, per host id, which Machine owns it and a fencing counter, each Machine's liveness key, and the per host rate counters (stream opens an hour, bytes a minute, pushes an hour). The lease, liveness and rate keys expire on their own (a lease within 30 seconds of its owner going), and nothing in Redis names a person, an address or a device. The Machines write nothing to disk. Logs carry host ids, addresses and counts, never device tokens or payloads. Metrics carry no host ids or addresses at all.
