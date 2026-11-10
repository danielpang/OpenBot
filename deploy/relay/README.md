# The OpenBots relay on Fly.io

This runs the shared relay as several Fly Machines behind one hostname, so it scales out and survives a Machine going away. It is how the project runs the relay that every install without its own uses. You only need it to run a relay for many servers; one server or a small group is served well by a single relay container (see [apps/relay/README.md](../../apps/relay/README.md)).

How the Machines share the work (ownership, leases, replays, failover) is in [Several machines](../../apps/relay/README.md#several-machines). This page covers what you run and set.

You need [flyctl](https://fly.io/docs/flyctl/install/) and a Fly.io account.

## Create the app

From a checkout of this repository:

```sh
cd deploy/relay
fly launch --copy-config --no-deploy --name <your app>
```

`fly launch` keeps this file's settings and writes your app name and region into it. The file has no `[build]`: every deploy names its image with `--image`, and after the first one the workflow below deploys for you.

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

`RELAY_REDIS_URL` is required as soon as more than one Machine runs. Without it each Machine believes it is the only one, and a phone that lands on a Machine other than its server's gets 4404. `RELAY_METRICS_TOKEN` turns on `GET /metrics`; without it the route answers 404.

Push needs the project's APNs key, and only the project's own relay has one (it belongs to the App Store build). Set it as a secret that holds the `.p8` file in base64. The relay reads it once at start and deletes it from its environment, so no key file is needed:

```sh
fly secrets set RELAY_APNS_KEY="$(base64 < AuthKey_XXXXXXXXXX.p8 | tr -d '\n')" \
  RELAY_APNS_KEY_ID=XXXXXXXXXX \
  RELAY_APNS_TEAM_ID=YYYYYYYYYY \
  RELAY_APNS_TOPIC=dev.openbots.app
```

For a relay without push (tunnel only, every push answered `unavailable`), set none of these. Each push names its APNs environment (`production` or `sandbox`), so one relay serves App Store, TestFlight and development builds alike.

Presence (`GET /v1/hosts/{id}`) tells anyone who has a host id whether that server is online. To keep that to yourself, set `RELAY_PRESENCE_TOKEN` (at least 16 characters). The iOS app does not use presence, so nothing breaks.

```sh
fly secrets set RELAY_PRESENCE_TOKEN="$(openssl rand -hex 32)"
```

Leave `RELAY_NODE_ID` unset. On Fly the relay uses the Machine's own `FLY_MACHINE_ID`, which is the id `fly-replay: instance=` needs.

## Deploy and scale

`.github/workflows/deploy-relay.yml` deploys the relay (see below). For the first deploy, run it by hand from the Actions tab (Deploy relay, Run workflow) once the secrets are set, or deploy a release from GHCR yourself with `fly deploy --image ghcr.io/danielpang/openbots/relay:<version>`. Then:

```sh
fly scale count 2                                # the most Machines the proxy may start
fly scale count 4 --region iad,fra,sin           # spread across regions
fly status
fly checks list
```

The workflow deploys on every push to `main` that changes the relay (`apps/relay`, its Dockerfile, the lockfile, or this `fly.toml`). No tag or release is needed. It runs the relay's typecheck and tests, builds `docker/relay.Dockerfile` for linux/amd64, pushes it to GHCR as `ghcr.io/<owner>/openbots/relay:sha-<commit sha>` and runs `fly deploy --image` with it, so Fly pulls it from GHCR. The `openbots/relay` package must be public (its package settings on GitHub), since Fly pulls without credentials. Only the `sha-` tag is pushed: the version tags and `latest` still move only with a release. It needs one repository secret, `FLY_API_TOKEN`:

```sh
fly tokens create deploy -a <your app>    # then: gh secret set FLY_API_TOKEN
```

Run it by hand to redeploy `main`. Do not also connect the repository in Fly's dashboard, or every push deploys twice. Self-hosted relays are unaffected: they run the GHCR image each release publishes.

Fly's proxy keeps at least one Machine running (`min_machines_running = 1`) and starts the others as load needs them (`auto_stop_machines = "stop"`, `auto_start_machines = true`). It starts a stopped Machine when the running ones pass the soft limit below, and stops one, which drains first, when the rest have room. It never creates Machines, so `fly scale count` sets the most there can be. Spread them over the regions your users are in. A replay between regions is one hop inside Fly's network, and only on connect.

Each Machine takes up to 20,000 sockets (host links and phone streams together, `RELAY_MAX_SOCKETS`). `[http_service.concurrency]` matches it: past the soft limit of 16,000 the proxy prefers other Machines, and at 20,000 it sends no more. A full Machine still admits the hosts it owns, which a replay can bring past the proxy's limit, up to a hard ceiling 10 percent above ([Each machine on its own](../../apps/relay/README.md#each-machine-on-its-own)). Scale out before Machines stay near the soft limit. Each also holds at most 512 MiB of bytes in flight (`RELAY_BUDGET_BYTES`), which is why the Machine has 2 GB of memory; raise both together.

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
2. It refuses new upgrades and pushes, and takes no new leases.
3. It gives up the leases it holds, so another Machine can take each host at once.
4. Right after, it closes each host link with 1012 (service restart) as soon as the pushes in flight on it are answered. The server relinks through the hostname to another Machine, which takes the lease, so its phones' next streams find it there instead of hearing 4404.
5. After 20 seconds (`RELAY_DRAIN_GRACE_MS`), or sooner once nothing is left, it waits for any push still in flight (within those 20 seconds) and closes whatever remains with 1012.

Servers and phones reconnect through the hostname and land on a Machine that owns, or now takes, their host. A phone sees a reconnect; it does not lose its place, since the app resyncs from its last sequence number. `kill_timeout = 30` gives the drain its 20 seconds and room to close; keep it above the grace period if you change either.

To take one Machine out of service by hand without a deploy, set `RELAY_DRAIN=true` on it (`fly machine update <id> --env RELAY_DRAIN=true`). It restarts draining and stays not ready until you set it back to `false`.

## When Redis goes away

The relay keeps serving, and links and streams already open go on. How each Machine copes is in [Several machines](../../apps/relay/README.md#several-machines). What you see:

- A server served without a lease is logged as `serving this host on this machine alone`.
- A Machine that cannot refresh its liveness key for 15 seconds gives up its leases (1012).
- Every Redis call gives up after 2 seconds (`RELAY_REDIS_COMMAND_TIMEOUT_MS`).
- `/ready` stays 200, with `"degraded":["registry_unreachable"]` in its body, so Fly does not take every Machine out at once. `registry_degraded` and `hosts_alone` show it in the metrics.
- A phone that lands on a Machine other than its server's gets 4404 until Redis is back, and the per host limits are counted per Machine.

## When a replay finds its Machine gone

If the Machine a replay names has just gone (it crashed, or a deploy replaced it), the server or phone sees the proxy's error (a 502, or a failed handshake) and reconnects. It clears within 15 seconds; see [Several machines](../../apps/relay/README.md#several-machines).

## Running several Machines anywhere else

Replays work only on Fly. Behind any other proxy, a relay of several machines needs sticky routing by host id in your load balancer, as [Several machines](../../apps/relay/README.md#several-machines) describes.

## Metrics

`GET /metrics` wants `Authorization: Bearer <RELAY_METRICS_TOKEN>`:

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
| `registry_degraded`                  | 1 while this Machine cannot reach Redis and serves on without it   |
| `hosts_alone`, `served_alone_total`  | Hosts served on this Machine alone while Redis is away             |
| `push_failures_total`                | Pushes answered `error` because sending them failed                |

Plus Node's process metrics (CPU, memory, event loop lag) under the same prefix. Watch `shed_peers_total` and `rejections_total{reason="bytes"}`: a steady rise means Machines are short of memory or phones are on poor networks. Watch `lease_losses_total`: outside deploys it should stay flat.

## What the relay sees and stores

What the relay sees, what it keeps in Redis, and what its logs and metrics carry is in [What the relay sees, and what it does not](../../apps/relay/README.md#what-the-relay-sees-and-what-it-does-not). The Machines write nothing to disk, and every Redis key expires on its own.
