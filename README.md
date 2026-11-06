# OpenBots

OpenBots is a source available, self-hosted take on Grok Bot: persistent Bots with a name, an avatar,
memory, tools and their own computer, one transcript per Bot, group chats where several Bots work
together, Skills and Routines that let work start without you, webhooks, and Artifacts. It runs on
your own machine or VPS with Docker Compose, talks to any OpenAI-compatible or Anthropic-compatible
model endpoint, and connects to any MCP server. See [docs/PRD.md](docs/PRD.md) for the product
requirements and [docs/TECHNICAL_PLAN.md](docs/TECHNICAL_PLAN.md) for the design.
See [Images and runtime architecture](docs/ARCHITECTURE.md) for the five Docker images, the Mac
app's local setup, remote connectivity and standalone deployment trade-offs.

## Install

Requirements: Docker with Compose v2.24 or later (Docker Desktop on macOS and Windows, Docker
Engine on Linux), and `git` to install from the repository.

### From a GitHub Release

Each [release](https://github.com/danielpang/OpenBots/releases) carries:

- **The Mac app**, `OpenBots-<version>-universal.dmg` (Apple Silicon and Intel). Open it and drag
  OpenBots to Applications. It connects to an OpenBots account, to your own server, or runs
  everything on the Mac with Docker Desktop or OrbStack. If the release notes say it is an
  unsigned build, right-click OpenBots and choose Open the first time, and download later releases
  yourself: only signed builds update themselves.
- **The compose bundle**, `openbots-compose-<version>.tar.gz`: the compose files, `.env.example`
  set to that release's images, `install.sh` and the backup and restore scripts. No `git` needed:

  ```sh
  curl -fsSLO https://github.com/danielpang/OpenBots/releases/download/v<version>/openbots-compose-<version>.tar.gz
  tar -xzf openbots-compose-<version>.tar.gz
  cd openbots-<version>
  bash install.sh
  ```

- **Image archives**, `openbots-<image>-<version>-linux-<arch>.tar.gz`, for machines that cannot
  pull from `ghcr.io`: `docker load -i <file>` each one before `docker compose up -d`.
- `SHA256SUMS` for all of them: `sha256sum --ignore-missing -c SHA256SUMS` (on macOS,
  `shasum -a 256 --ignore-missing -c SHA256SUMS`).

### From the repository

The install script does every step below: it clones the repository into `OpenBots`, copies
`.env.example` to `.env`, generates `OPENBOTS_MASTER_KEY` and the database password
(`POSTGRES_PASSWORD`, also written into `DATABASE_URL`) and runs `docker compose up -d`. Run
again, it keeps an existing `.env`, key and password.

```sh
curl -fsSL https://raw.githubusercontent.com/danielpang/OpenBots/main/install.sh | bash
# or, from a checkout: bash install.sh [--dir <path>] [--ref <tag>] [--no-start] [--pair]
```

By hand, the same steps:

```sh
git clone https://github.com/danielpang/OpenBots.git OpenBots
cd OpenBots
(umask 077 && cp .env.example .env)
openssl rand -base64 32   # the master key
openssl rand -hex 24      # the database password
openssl rand -hex 24      # the app's database password
```

In `.env`, set `OPENBOTS_MASTER_KEY=` to the key and `POSTGRES_PASSWORD=` to the password, and put
the same password in `DATABASE_URL` in place of `change-me`
(`DATABASE_URL=postgres://openbots:<password>@postgres:5432/openbots`). Postgres does not start
without it. Set `OPENBOTS_DB_APP_PASSWORD=` to the second password: the server works as a database
role with it that is held to row-level security between organizations. Keep a copy of the key somewhere safe: every stored secret is encrypted with it. From
a fork, also set `OPENBOTS_IMAGE_PREFIX=ghcr.io/<owner in lower case>/openbots`. Optionally add a
model provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...); you can also add providers later
in Settings > Models. Then:

```sh
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000). On a new install the first-run wizard
creates your account (the owner), asks for at least one model provider key and tests it, starts
downloading the computer image in the background when Docker is configured, and creates your first
Bot. Database migrations run every time the server starts.

The stack (`compose.yaml` at the root includes `docker/docker-compose.yml` and
`docker/docker-compose.tunnels.yml`):

| Service                              | Image                           | Role                                                                     |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------ |
| `openbots`                           | OpenBots server image (below)   | API, web UI, workers and scheduler on port 3000; files in volume `files` |
| `postgres`                           | `pgvector/pgvector:pg16`        | Database, volume `pgdata`                                                |
| `redis`                              | `redis:7-alpine`                | Queue and pub/sub, volume `redisdata`                                    |
| `docker-guard`                       | OpenBots server image (below)   | Checks every Docker API request the server makes (below)                 |
| `docker-socket-proxy`                | `tecnativa/docker-socket-proxy` | Docker API filtered by URL, reachable only from `docker-guard`           |
| `sandbox-firewall`                   | OpenBots sandbox firewall image | Keeps the computers' network rules applied on the Docker host            |
| `egress-proxy` (profile `egress`)    | `kalaksi/tinyproxy`             | Optional allowlisting proxy for the computers' web traffic (below)       |
| `minio` (profile `s3`)               | `minio/minio`                   | Optional object storage (not used by OpenBots yet)                       |
| `ngrok` (profile `ngrok`)            | `ngrok/ngrok`                   | Optional tunnel, see below                                               |
| `cloudflared` (profile `cloudflare`) | `cloudflare/cloudflared`        | Optional tunnel, see below                                               |

Bots' computers are containers created at runtime from `OPENBOTS_SANDBOX_IMAGE` on the sandbox
network (`openbots-sbx` unless `OPENBOTS_SANDBOX_NETWORK` names another), which has no route to
Postgres or Redis. The server reaches Docker only
through `docker-guard`, which allows the exact requests the computer provider makes: containers
only from the sandbox image, never privileged, with no host paths, no host network and every
capability dropped. Anything else gets a 403, and the server refuses a `DOCKER_HOST` that is not
the guard. Containers on the sandbox network cannot reach each other, the server (other than
answering it), the host, link-local metadata addresses or private and LAN addresses; the
`sandbox-firewall` service applies those rules (`docker/sandbox-firewall.sh`) in the Docker host's
network namespace, so it needs a Docker that manages iptables. Rootless Docker and Docker's
nftables firewall backend are not supported by it: there, apply equivalent rules yourself and drop
`sandbox-firewall` from `openbots`'s `depends_on` in a `compose.override.yaml`. If
`172.30.255.0/24` clashes with a network you use, change `OPENBOTS_SANDBOX_SUBNET` and
`OPENBOTS_SANDBOX_SERVER_IP` in `.env`.

Two stacks on one Docker host (two checkouts, or a checkout beside the Mac app's stack) each need
their own sandbox network: set `OPENBOTS_SANDBOX_NETWORK` to another name, and
`OPENBOTS_SANDBOX_SUBNET` and `OPENBOTS_SANDBOX_SERVER_IP` to another subnet in `172.30.0.0/16`, in
one of them. The network's bridge on the host is named like the network unless
`OPENBOTS_SANDBOX_BRIDGE` names it; a bridge name is lower case and at most 15 characters, so a
longer network name needs one. The docker guard allows computers on that network only, and each
stack's `sandbox-firewall` keeps its own iptables chains for its own bridge and subnet
(`OPENBOTS-SANDBOX` for the default bridge, `OB-<BRIDGE>` otherwise), so the two firewalls leave
each other's rules alone. The Mac app gives its stack a network of its own when it first sets up
(see `apps/desktop/README.md`). Changing the network of a running install: stop the computers
(`docker ps -q --filter label=openbots.computer | xargs -r docker stop`), `docker compose down`,
edit `.env`, `docker compose up -d`; each computer is made again on the new network at its next
start, keeping its files. Without its own network a second stack fails to start with "Address
already in use" and Compose warns that the network "exists but was not created for project".

Set `OPENBOTS_TIMEZONE` in `.env` to your timezone (an IANA name such as `Europe/London`; default
`UTC`). It is the computers' clock: the Bots' shells, their browsers and the wallpaper, which
follows the time of day. Like the egress proxy below, it is fixed when a computer's container is
made, so each computer picks up a change the next time it starts. A `remote` computer
(`OPENBOTS_COMPUTER_AGENT_URL`) keeps its own machine's timezone.

### A remote computer

Instead of Docker, OpenBots can use a control agent already running on another machine
(`OPENBOTS_COMPUTER_AGENT_URL` and `OPENBOTS_COMPUTER_AGENT_TOKEN`). That is one machine with one
`/home/bot` and one browser cookie store, so it suits a single-person install: the first account to
use it keeps it, and every other account is told the computer is unavailable. To let every account
use it, set `OPENBOTS_COMPUTER_AGENT_SHARED=true`. Each Bot still gets a screen of its own, but all
accounts then share the files under `/home/bot` and every browser login, because cookies sync
across every screen on the machine. Turn it on only when the accounts fully trust each other.

### Egress proxy for the computers

By default a computer reaches the whole public internet. To limit it to a list of hosts, run the
`egress` profile, a [tinyproxy](https://tinyproxy.github.io/) on the sandbox network that refuses
every host its allowlist does not match, and point the computers at it in `.env`:

```sh
OPENBOTS_SANDBOX_EGRESS_PROXY=http://172.30.255.3:8888
OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY=true
```

Then `docker compose --profile egress up -d`. The allowlist is
[docker/egress-proxy/allowlist](docker/egress-proxy/allowlist), one regular expression per host
pattern; to keep your own copy outside the checkout, set `OPENBOTS_SANDBOX_EGRESS_ALLOWLIST` to its
path. The proxy's address is `OPENBOTS_SANDBOX_EGRESS_PROXY_IP` (inside `OPENBOTS_SANDBOX_SUBNET`).

The computers get the proxy as `HTTP_PROXY` and `HTTPS_PROXY` (and the lower case spellings), which
the browser and tools such as `curl`, `git` and `pip` follow; `OPENBOTS_SANDBOX_NO_PROXY` lists what
skips it (default `localhost,127.0.0.1`). Those variables are only a request, so a program can
ignore them. `OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY=true` makes the sandbox firewall drop every
connection a computer opens except to the proxy and DNS, which makes the allowlist binding. The
proxy's own traffic still cannot reach private, LAN or link-local addresses.

Any other HTTP proxy works too: set `OPENBOTS_SANDBOX_EGRESS_PROXY` to its URL, with the port. The
sandbox firewall lets the computers reach that address and port even when it is private (on your
LAN or on the Docker host), so give it as an IPv4 address; a proxy given by a host name gets no
exception, and `OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY` needs the address.

A computer's proxy settings are fixed when its container is made. After a change, each computer
picks it up the next time it starts: OpenBots then makes its container again, keeping its home and
browser profiles. Stop a running computer on its Computer page to apply the change at once.

Every setting is in `.env`; [.env.example](.env.example) documents each one. After editing `.env`,
apply it with `docker compose up -d`. Health endpoints: `/healthz` (process up), `/readyz`
(database and Redis reachable, used by the container healthcheck) and `/metrics` (Prometheus,
off unless `OPENBOTS_METRICS_TOKEN` is set).

Each release tag (`v1.2.0`) publishes five images for linux/amd64 and linux/arm64:
`ghcr.io/danielpang/openbots/server`, `ghcr.io/danielpang/openbots/computer`,
`ghcr.io/danielpang/openbots/sandbox-firewall`, `ghcr.io/danielpang/openbots/relay` (the private
relay) and `ghcr.io/danielpang/openbots/standalone` (all of OpenBots in one container, see
[Run OpenBots 24/7 on a VM](#run-openbots-247-on-a-vm)), tagged `1.2.0`, `1.2` and `latest`
(`.github/workflows/release.yml`; `1.2` and `latest` move only once every image is pushed), and
attaches the Mac app, the
compose bundle and the image archives to its GitHub Release
([apps/desktop/RELEASING.md](apps/desktop/RELEASING.md)). `OPENBOTS_IMAGE_PREFIX` in `.env`
says where they come from (a fork publishes to `ghcr.io/<its owner>/openbots`, and
`OPENBOTS_GITHUB_OWNER=<owner> bash install.sh` sets it), and `OPENBOTS_VERSION` picks the release;
computers run the computer image of the same release unless `OPENBOTS_SANDBOX_IMAGE` names another.
If the server or sandbox firewall image cannot be pulled, `docker compose up -d` builds it from
your checkout (`docker/server.Dockerfile`, `docker/sandbox-firewall.Dockerfile`). To build them
yourself: `docker compose build`.

## Upgrade

```sh
docker compose pull && docker compose up -d
```

With `OPENBOTS_VERSION=latest` this moves to the newest release; to stay on a release line, set it
to one such as `1.2` or `1.2.0` first. An install from a compose bundle starts pinned to its
release: set `OPENBOTS_VERSION` in `.env` to the new version (or `latest`) first. Migrations run when the new server starts. If you build
from source instead, run `git pull && docker compose up -d --build`. Back up first (below).

The Bots' computers move to the new computer image too. When the server starts it pulls the
computer image again, and each computer is made again from it the next time it starts, keeping its
files and browser logins; the Computer page and the run's event row say it is updating. A
running computer is never replaced under a task: it moves after it next stops, at its idle timeout
or when you press Stop on its Computer page and start it again.

Upgrading from a version without `docker-guard`: set `DOCKER_HOST=tcp://docker-guard:2375` in
`.env` (the computer refuses the socket proxy directly), and recreate the sandbox network, which
now has fixed options: `docker compose down`, remove any computer containers
(`docker ps -aq --filter label=openbots.computer | xargs -r docker rm -f`; their home volumes stay),
`docker network rm openbots-sbx`, then `docker compose up -d`.

## Backup and restore

```sh
bash scripts/backup.sh                      # writes a new backups/<timestamp>/ each time
bash scripts/restore.sh backups/<timestamp> # replaces the current data, asks first
bash scripts/restore.sh backups/<timestamp> --yes   # the same without asking, for scripts
```

`backup.sh <dir>` writes a new `<dir>/<timestamp>` inside a directory of your choice, so the same
command runs every time; `--out <dir>` writes into exactly `dir`, which must be new or empty.
`restore.sh` without `--yes` and without a terminal to ask on (a script, cron, `docker exec`
without `-it`) stops with a message and changes nothing.

A backup holds a `pg_dump` of the database (`database.dump`), the `files` volume with every upload
and Artifact file (`files.tar.gz`), each Bot computer's home volume (`computers/<volume>.tar.gz`)
and a `MANIFEST` with checksums and the file count. It does not hold `OPENBOTS_MASTER_KEY`: back up
`.env` separately and restore with the same key, or stored secrets cannot be decrypted. Backups
are written readable by your user only. Run the scripts from the checkout that runs the stack; the
stack can be up or down.

`backup.sh` verifies what it wrote before it finishes: `pg_restore` must be able to read the dump
and find the users table, and every archive must pass `gzip -t`. A backup that fails is removed,
so a directory under `backups/` with a `MANIFEST` is a good one.

`restore.sh` checks the backup first (checksums from `MANIFEST`, the dump, the archives, where
each archive goes, and twice the backup's size in free space) and stops before touching anything
if that fails. It then asks (skip with `--yes`), stops `openbots` and the computers, recreates the
database, refills the volumes, starts the stack, and checks that the restored file count matches
the backup.

A backup of the standalone image restores into the compose stack too: its files are given to the
server's uid 1000, its Bots' home (`home.tar.gz`) fills the home volume of the computer its
database names, and the standalone computer's browser sign-ins are left out with a message (the
Bots sign in to sites again). If its database has no computer, the restore stops before changing
anything; `--skip-home` restores without the Bots' home.

**Restoring onto a new install.** A new install generates a master key of its own. Put the old
one in place before you restore: set `OPENBOTS_MASTER_KEY=<the old key>` in `.env` (in
`/data/.env`, or as a secret such as `fly secrets set OPENBOTS_MASTER_KEY=...`, for the standalone
image), restart (`docker compose up -d`, or restart the container), then run the restore with
`--yes`. The standalone image refuses to boot on an existing database whose master key is
missing, rather than generating a new one that could not open its secrets.

**Moving a server: stop the old one first.** A backup carries the server's identity, the key it
links to the relay with. Restored onto a second machine while the first still runs, both dial the
relay as one server and the phone reaches whichever linked last. Stop the old install
(`docker compose down`, `docker stop -t 60 <container>`, `fly machine stop`) before you start the
restored one.

Without Docker (a development install), both scripts use `DATABASE_URL` and `OPENBOTS_FILES_DIR`
and need `pg_dump` / `pg_restore` on `PATH`; computer volumes are skipped.

The files volume holds files of two owners: the server's (uid 1000) and those stdio MCP servers
wrote as `nobody`. So `backup.sh` reads it as root with only the capability to read past file modes
(DAC_READ_SEARCH), and `restore.sh` writes it as root with only the ones tar needs to put owners and
modes back (CHOWN, DAC_OVERRIDE, FOWNER).

## Rotating the master key

`OPENBOTS_MASTER_KEY` encrypts every stored secret (provider keys, connector secrets and tokens,
webhook signing secrets, computer tokens) and signs sign-in sessions. Rotate it when it may have
leaked, or on a schedule:

1. Back up: `bash scripts/backup.sh`. Keep the current key with that backup, since only it opens
   the secrets in it.
2. Make a new key: `docker compose run --rm openbots keygen`.
3. In `.env`, move the current key to `OPENBOTS_MASTER_KEY_PREVIOUS` and put the new one in its
   place:
   ```sh
   OPENBOTS_MASTER_KEY=<the new key>
   OPENBOTS_MASTER_KEY_PREVIOUS=<the old key>
   ```
4. `docker compose up -d`. The server seals new secrets with the new key and still opens old ones
   with the previous key. Its worker re-encrypts every stored secret under the new key in the
   background, and `docker compose logs openbots` says `master key rotation done` when it has.
5. To run the job yourself and watch it, `docker compose run --rm openbots rotate-key`. It prints
   its progress, can be stopped and run again, and can run while the server is up. It exits with
   status 1, naming each one, while any secret opens with neither key.
6. When it reports done, empty `OPENBOTS_MASTER_KEY_PREVIOUS` and run `docker compose up -d` again.

Rotating signs everyone out. The secret that signs sessions is derived from the master key, so
sessions from before stop working when the server restarts with the new key, and so do email links
and sign-ins in progress. Everyone signs in again once. This is on purpose: if the old key leaked,
sessions signed with it should end with it. API keys, invites, webhook URLs and signing secrets,
event subscriptions and computers keep working, since their secrets are re-encrypted, not changed.

`OPENBOTS_MASTER_KEY_PREVIOUS` takes several keys separated by commas, for a rotation started before
the last one finished. A backup made before a rotation needs the key it was made with.

### Secrets in files

Each secret setting (`OPENBOTS_MASTER_KEY`, `OPENBOTS_MASTER_KEY_PREVIOUS`, `DATABASE_URL`,
`REDIS_URL`, the provider API keys, the OAuth client secrets, `OPENBOTS_COMPUTER_AGENT_TOKEN` and
`OPENBOTS_METRICS_TOKEN`) can be given as `NAME_FILE` instead, the path of a file holding the value,
such as a Docker or Kubernetes secret. Set one or the other, not both. The compose stack does this
for you: before the server starts, its entrypoint moves the secrets from `.env` into private files
in memory (`/run/openbots`), so the server's process environment holds only their paths. Anywhere
else, the server logs a warning naming each secret it found in its environment.

## Monitoring

`/metrics` serves Prometheus metrics once `OPENBOTS_METRICS_TOKEN` is set in `.env` (16
characters or more; `openssl rand -hex 32`); until then it answers 404. Scrapers send the token
as a bearer token, from inside the compose network (`openbots:3000`) or on the published port:

```yaml
scrape_configs:
  - job_name: openbots
    authorization:
      credentials: <OPENBOTS_METRICS_TOKEN>
    static_configs:
      - targets: ['openbots:3000']
```

Besides the Node process and HTTP request metrics:

| Metric                                                    | What it measures                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `openbots_runs{status}`                                   | Runs `queued` (the queue depth), `running` and `waiting` right now |
| `openbots_runs_finished_total{status,trigger}`            | Runs that completed, failed or were cancelled                      |
| `openbots_run_duration_seconds{status}`                   | Start to finish of each run, waits included                        |
| `openbots_webhook_deliveries_total{direction,outcome}`    | Inbound webhooks by outcome; outbound event delivery attempts      |
| `openbots_provider_step_duration_seconds{provider,model}` | One model step, request to finished response                       |

`openbots_runs` is read from the database at scrape time, so every server process reports the same
value; aggregate it with `max`, not `sum`. Import
[docs/grafana-dashboard.json](docs/grafana-dashboard.json) into Grafana (Dashboards > New > Import)
and pick your Prometheus data source for a ready-made overview.

## Checking the container hardening

The automated tests check the docker guard's rules, the compose files and the metrics token without
Docker. What only a machine with Docker can show, run from the checkout after
`docker compose up -d` (Linux, and Docker Desktop on a Mac):

1. `docker compose ps`: `docker-guard` and `sandbox-firewall` are healthy and `openbots` started.
   `docker compose logs sandbox-firewall` names the iptables backend it used.
2. Start a Bot's computer from the web UI; it starts and its screen shows.
   `docker compose logs docker-guard` has no `refused` lines.
3. The guard refuses an unsafe container. This must print `403` and a `docker guard:` message:
   ```sh
   docker compose exec openbots node -e "fetch('http://docker-guard:2375/containers/create?name=openbots-computer-x',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({Image:'alpine',HostConfig:{Privileged:true}})}).then(async r=>console.log(r.status,await r.text()))"
   ```
   The same with `http://docker-socket-proxy:2375/_ping` fails: the server cannot reach the socket
   proxy.
4. The guard acts only on computers: the same command with
   `http://docker-guard:2375/containers/openbots-postgres-1/stop` (method `POST`, no body) prints
   `403` and Postgres keeps running.
5. `docker network inspect openbots-sbx` (or your `OPENBOTS_SANDBOX_NETWORK`) shows
   `com.docker.network.bridge.enable_icc: false`,
   the subnet from `.env` and `openbots` at `OPENBOTS_SANDBOX_SERVER_IP`.
6. From inside a computer (its terminal in the web UI), each of these must fail or time out:
   `curl -m 5 http://<OPENBOTS_SANDBOX_SERVER_IP>:3000/healthz` (the server),
   `curl -m 5 http://169.254.169.254/` (metadata), `curl -m 5 http://<your router's LAN IP>/`,
   `curl -m 5 http://172.30.255.1/` (the host), and, with a second account's computer running,
   `curl -m 5 http://<its address>:7070/healthz`. `curl -m 10 https://example.com` and
   `getent hosts example.com` must work.
7. `curl -i http://localhost:3000/metrics` answers 404 without `OPENBOTS_METRICS_TOKEN`, 401 with it
   set and no token sent, and 200 with `-H "Authorization: Bearer <token>"`.
8. Restart Docker (or reboot): the computer still starts afterwards, and the rules are back
   (`sudo iptables -S OPENBOTS-SANDBOX`, or `iptables-legacy` / `iptables-nft`; `OB-<BRIDGE>` for
   another bridge).
9. With a second stack on its own `OPENBOTS_SANDBOX_NETWORK` and subnet running beside this one,
   both start, each `sandbox-firewall` log names its own bridge and chains, both chain pairs are in
   `iptables -S`, and from a computer of either stack the other stack's server address and
   computers time out like step 6.
10. `docker compose pull` resolves `tecnativa/docker-socket-proxy` by its pinned digest on both
    amd64 and arm64.
11. The catalog's stdio MCP servers are in the image and start without downloading anything
    (S-20). `docker buildx build --platform linux/amd64,linux/arm64 -f docker/server.Dockerfile .`
    succeeds. In the running server,
    `docker compose exec openbots ls -l /opt/openbots/mcp/node_modules/.bin` lists
    `mcp-server-filesystem` and `mcp-server-postgres`, owned by root. Add the Filesystem
    connector and a Postgres connector (a public, read-only database) on the Connectors page and press
    Test on each: both list their tools, and `docker compose exec openbots ps -o user,cmd -e` shows
    them running from `/opt/openbots/mcp`, with no `npx` or `npm` process.
12. Stdio MCP servers run as `nobody` with no capabilities and cannot read the server (S-1). With
    the Filesystem connector added (press Test so it runs), list the processes:
    ```sh
    docker compose exec openbots sh -c 'for d in /proc/[0-9]*; do printf "%s " "${d#/proc/}"; grep -E "^(Name|Uid|CapEff)" "$d/status" | tr -s "\t\n" "  "; echo; done'
    ```
    `node` shows Uid `1000` and CapEff `00000000000000c0` (SETUID and SETGID only), and the MCP
    server shows Uid `65534` and CapEff `0000000000000000`. As the stdio servers' user, the
    server's environment is out of reach: `docker compose exec --user 65534 openbots cat
/proc/<node pid>/environ` fails with "Permission denied". `docker compose exec --user 1000
openbots ls -l /run/openbots` lists the secrets, each `-rw-------`. Remove the connector: the MCP
    server's process is gone from the list within a few seconds. Then
    `docker compose run --rm openbots rotate-key` reports every secret under the current key, and
    `bash scripts/backup.sh` followed by `bash scripts/restore.sh` brings the connector's files back
    with their owners.
13. The egress proxy (plan 9.5). With the `.env` lines from
    [Egress proxy for the computers](#egress-proxy-for-the-computers) and
    `docker compose --profile egress up -d`, start a computer and in its terminal:
    `env | grep -i proxy` lists the proxy; `curl -m 10 https://en.wikipedia.org` works;
    `curl -m 10 https://example.com` gets a 403 from tinyproxy;
    `curl -m 10 --noproxy '*' https://example.com` times out (proxy only). The proxy's log
    (`docker compose logs egress-proxy`) shows both requests, and the firewall's names the proxy.

## Exposing your OpenBots server to the internet

By default OpenBots listens on `http://localhost:3000`. To receive webhooks, complete OAuth flows for
connectors, or use the Mac app away from home, put a tunnel in front of it. Whichever tunnel you
use, set `OPENBOTS_PUBLIC_URL` in `.env` to the public URL and restart with `docker compose up -d`.
OpenBots uses it to build webhook URLs and OAuth redirect URIs.

**Before exposing anything:** use a strong password and consider the tunnel provider's own access
controls described below. A self-hosted install (`OPENBOTS_DEPLOYMENT=self_hosted`, the default)
has one account and closes sign-up once it exists. The managed service (`OPENBOTS_DEPLOYMENT=managed`)
runs from the managed build in `ee/`, where every account verifies its email.

### Option A: ngrok

1. Install ngrok (`brew install ngrok` on macOS) and add your token:
   `ngrok config add-authtoken <token>`.
2. Start a tunnel: `ngrok http 3000`. The free plan includes one static domain, which you should
   use so the URL survives restarts: `ngrok http --url=your-name.ngrok.app 3000`.
3. Set `OPENBOTS_PUBLIC_URL=https://your-name.ngrok.app` in `.env` and run `docker compose up -d`.
4. To run ngrok as part of the stack instead of on your machine, set `NGROK_AUTHTOKEN` and
   `NGROK_URL` (the domain alone, e.g. `NGROK_URL=your-name.ngrok.app`) in `.env` and start with
   the profile: `docker compose --profile ngrok up -d`.
5. Optional hardening: protect the UI with ngrok's OAuth or basic auth (`--oauth=google`,
   `--basic-auth=user:pass`). Webhook endpoints live under `/hooks/`, so if you add ngrok auth, use
   ngrok Traffic Policy to exempt that path, or run a second tunnel for it.

### Option B: Cloudflare Tunnel

Quick tunnel (no account, random URL that changes each run):

1. Install cloudflared (`brew install cloudflared`).
2. Run `cloudflared tunnel --url http://localhost:3000` and copy the
   `https://<random>.trycloudflare.com` URL it prints.
3. Set `OPENBOTS_PUBLIC_URL` to that URL and run `docker compose up -d`.

Named tunnel (stable hostname on your own domain, recommended):

1. `cloudflared tunnel login`, then `cloudflared tunnel create openbots`.
2. `cloudflared tunnel route dns openbots openbots.example.com`.
3. Create `~/.cloudflared/config.yml` with an ingress rule that sends `openbots.example.com` to
   `http://localhost:3000` and a final `http_status:404` catch-all, then run
   `cloudflared tunnel run openbots`:

   ```yaml
   tunnel: openbots
   credentials-file: /Users/you/.cloudflared/<tunnel id>.json
   ingress:
     - hostname: openbots.example.com
       service: http://localhost:3000
     - service: http_status:404
   ```

4. Or run it inside the stack: create the tunnel in the Cloudflare Zero Trust dashboard, set its
   public hostname to service `http://openbots:3000`, put the token in `.env` as
   `CLOUDFLARE_TUNNEL_TOKEN`, and start with `docker compose --profile cloudflare up -d`.
5. Set `OPENBOTS_PUBLIC_URL=https://openbots.example.com` and restart.
6. Optional hardening: add a Cloudflare Access policy for the hostname so only you can reach the
   UI. Add a bypass rule for the path `/hooks/*` so external services can still deliver webhooks,
   or publish webhooks on a second hostname without Access.

Both providers pass WebSockets, which the live screen and terminal views need. If the screen view
fails through a tunnel, check that no intermediate proxy is stripping the `Upgrade` header.

When you start the stack with a profile, keep passing it (`docker compose --profile ngrok up -d`,
`docker compose --profile ngrok pull`), or set `COMPOSE_PROFILES=ngrok` in `.env` so plain
`docker compose` commands include the tunnel.

## Reaching your server from your phone

The OpenBots app for iOS is in development ([docs/IOS_APP_PLAN.md](docs/IOS_APP_PLAN.md)). The server side it needs is in place: a phone pairs with a server by scanning a QR code, and reaches it either directly (a public URL from the section above) or through the private relay, which needs no public address, port, DNS or certificate. The wire protocol is in [docs/RELAY_PROTOCOL.md](docs/RELAY_PROTOCOL.md) and the design in [docs/MOBILE_AND_VM_PLAN.md](docs/MOBILE_AND_VM_PLAN.md).

**Pairing.** Settings > Devices in the web app (and "Pair your phone…" in the Mac app) shows a QR code that is good for 5 minutes and works once. On a VM with no browser at hand, print it in the terminal:

```sh
docker compose run --rm openbots pair          # add --link to print the link too
docker compose run --rm openbots devices       # list paired devices, or `devices revoke <id>`
docker compose run --rm openbots relay         # the server's host id and whether the relay sees it
```

On a fresh install with no owner yet, `openbots pair` prints a code that creates the owner when the phone pairs, so a server on a VM needs no browser to get going. A paired device holds a key with the owner's access; revoke a lost phone in Settings > Devices, which stops its key at once.

**The relay.** Set `OPENBOTS_RELAY_URL` in `.env` to a relay's `wss://` address and run `docker compose up -d`. The server dials the relay out, only once a device is paired or a pairing is open, and the phone reaches it through the relay when no direct address answers. Everything between the phone and the server is end-to-end encrypted with keys the relay never holds: the relay sees your server's id, when it is connected, how many streams and bytes, and nothing of what they carry. Leave the setting empty and the phone needs a direct address (`OPENBOTS_PUBLIC_URL` over https, or the same network). The Mac app's This Mac stack uses the OpenBots relay by default. To use a relay of your own, open "Relay…" in the OpenBots menu and enter its `wss://` address: the app sets `OPENBOTS_RELAY_URL` and restarts the stack, and every paired phone is signed out and has to pair again.

To run a relay of your own, start the compose stack's `relay` profile (see [Run OpenBots 24/7 on a VM](#run-openbots-247-on-a-vm)) or run `docker/relay.Dockerfile`'s image on its own, behind a TLS terminator; it listens on port 3200 and needs no state. `apps/relay/README.md` has its settings. Push notifications go through the relay too, and only a relay holding the app's APNs key can send them, so a self-hosted relay carries the tunnel and no push.

## Run OpenBots 24/7 on a VM

The Mac app's This Mac stack is the free way to run OpenBots, but it pauses while the Mac sleeps: Routines wait, and Bots stop mid-task until the lid opens. To have Bots and Routines work around the clock, run OpenBots on a machine that stays on, such as a cloud VM or a home server. Your phone reaches it through the relay, so the VM needs no public address, open port, DNS or certificate. Templates and step-by-step guides are in [deploy/](deploy/README.md).

There are two shapes:

- **The compose stack**, on any VM where you can run Docker (EC2, Hetzner, DigitalOcean, a home server). It is this README's install, with every Bot's computer in its own container behind the Docker guard and the sandbox firewall. **This is the hardened path; use it wherever Docker is available.** On a new Ubuntu VM, [deploy/ec2/cloud-init.yaml](deploy/ec2/cloud-init.yaml) installs Docker and runs the installer for you; elsewhere, run `bash install.sh --pair`.
- **The standalone image**, `ghcr.io/danielpang/openbots/standalone`, for platforms that run one container and no Docker inside it (Fly Machines, Sprites, Railway, Render), or for one person on one VM. The server, Postgres, Redis and the Bots' computer share one container with one volume at `/data`. Give it about 2 GB of memory and 2 CPUs. [deploy/fly](deploy/fly/README.md) and [deploy/sprites](deploy/sprites/README.md) have the steps, and [docker/standalone/README.md](docker/standalone/README.md) the `docker run` line with its flags (`--stop-timeout 60`, `--pids-limit`, `--cap-add NET_ADMIN`, log rotation). Stop it with `docker stop -t 60`, not `docker rm -f`. Everything shares one disk, so a Bot that fills its home fills the disk under the database; the image warns below 10 percent free. Modal can run the image with a Volume at `/data`, but Modal Sandboxes are built for shorter work; the other platforms fit a server that runs around the clock better.

**Set the relay, and pair first.** With the recommended setup (no inbound rule, no public address) the relay is the phone's only way to the server: set `OPENBOTS_RELAY_URL`, or the phone cannot reach it. `install.sh --pair`, the EC2 template and the standalone image warn when it is empty and no https `OPENBOTS_PUBLIC_URL` is set. On a platform that publishes the port as soon as the service runs (Railway, Render), the first visitor to the web app can create the owner while none exists: run `openbots pair` in the service's shell and pair your phone before you give it a public address.

**Pairing from the terminal.** A new server needs no browser. `bash install.sh --pair` starts the stack and prints a QR code once it is ready; with no terminal attached (cloud-init, for instance) it writes the code to `openbots-pair.txt` beside `.env`, readable by you only, and prints nothing a log could keep. Scan it with the OpenBots app. On a server with no owner yet, the phone that pairs becomes the owner. A code works once and for 5 minutes. For a new one, run `docker compose run --rm openbots pair` (compose stack), `docker exec <container> openbots pair` (standalone image) or `fly ssh console -C "openbots pair"` (Fly).

**Your own relay.** On a VM with a public address you can run a relay beside the compose stack, with the `relay` profile: `docker compose --profile relay up -d`. It listens on `OPENBOTS_RELAY_PORT` (3200), on loopback unless `OPENBOTS_RELAY_BIND` says otherwise, and needs TLS in front of it: a Cloudflare Tunnel hostname whose service is `http://relay:3200` (the `cloudflare` profile), or a reverse proxy on the host. Set `OPENBOTS_RELAY_URL` to that `wss://` address. A relay of your own carries the tunnel and no push notifications, since only the project's relay holds the app's APNs key; the phone then gets notices only while the app is open.

**Cost.** You pay the platform for a machine that runs all month, plus your model provider's usage, which each Bot's usage rows show. Prices change, so this README gives no number: check the platform's own pricing page for a machine with 2 CPUs and 4 GB of memory and a 10 to 30 GB disk: [Fly.io](https://fly.io/docs/about/pricing/), [Amazon EC2](https://aws.amazon.com/ec2/pricing/on-demand/), [Railway](https://railway.com/pricing), [Render](https://render.com/pricing). A Sprite costs nothing while paused, but it pauses when idle, and OpenBots pauses with it, so it does not suit Routines around the clock.

**What the standalone image gives up.** In the compose stack a Bot's shell runs in its own container, which cannot reach the server, the database or the server's network. In the standalone image there is one container and one kernel: the Bots' shells run beside the server, as another user. They cannot read the server's secrets: the computer agent's token is kept out of every program it starts, and the server's routes all need a key the Bots do not have. But a Bot's shell can reach the server's port on loopback, the VM's own network (on Fly, the organization's private network and other apps on it) and, on a cloud VM, the metadata address that hands out the machine's credentials. Run the container with `--cap-add NET_ADMIN` and the image drops that address for the Bots' users, or block it in the platform's firewall (on EC2, require IMDSv2 with a hop limit of 1). `OPENBOTS_SANDBOX_EGRESS_PROXY` is advisory in this image: programs that honour `HTTP_PROXY` use it, and nothing stops one that does not. The image is meant for one person's own server; for anything more, use the compose stack.

## Development

Requirements: Linux or macOS with `curl`, `tar` and `xz`. Nothing else needs to be preinstalled.

```sh
bash scripts/dev-setup.sh            # Node 22, pnpm (via corepack), pnpm install
bash scripts/dev-setup.sh --services # also Postgres 16 + pgvector and Redis (Ubuntu, apt)
```

The script is idempotent. It reuses a Node 22 already on `PATH`, otherwise installs one into a
toolchain directory (`/workspace/.openbots-toolchain` when it has room, else
`~/.local/openbots-toolchain`), and prints the exports to add to
your shell (they are also written to `<toolchain dir>/env.sh`). Set `OPENBOTS_TOOLCHAIN_DIR` to
choose the location yourself.

Then:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

Unit tests need no external services. Tests that need Postgres or Redis run only when
`DATABASE_URL` or `REDIS_URL` is set (`--services` prints both).

`pnpm dev` runs the server from source and needs Postgres, Redis and a few variables.
`bash scripts/dev.sh` starts Postgres and Redis (with Docker Compose when Docker is running,
published on `127.0.0.1`, otherwise the services from `dev-setup.sh --services`) and prints the
exports:

```sh
bash scripts/dev.sh
export DATABASE_URL=postgres://openbots:openbots@127.0.0.1:5432/openbots
export REDIS_URL=redis://127.0.0.1:6379
export OPENBOTS_MASTER_KEY=$(pnpm -s --filter @openbots/server keygen)
pnpm dev
```

The catalog's Filesystem and Postgres connectors run servers the image installs from
`docker/mcp-catalog/package-lock.json`. From source, install them once with
`(cd docker/mcp-catalog && npm ci --omit=dev --ignore-scripts)` and
`export OPENBOTS_MCP_DIR=$PWD/docker/mcp-catalog`, or set `OPENBOTS_MCP_NPX_FALLBACK=true` to let
them download through `npx` instead.

Bot computers need Docker, reached through the docker guard: the server refuses a `DOCKER_HOST`
that is the Docker socket or the socket proxy. `pnpm --filter @openbots/computer docker-guard` runs
the guard from source on `127.0.0.1:2375`, in front of `/var/run/docker.sock`
(`OPENBOTS_DOCKER_UPSTREAM`, `OPENBOTS_DOCKER_GUARD_PORT` and `OPENBOTS_SANDBOX_IMAGE` change that).
Leave it running in a second terminal and point the server at it before `pnpm dev`:

```sh
pnpm --filter @openbots/computer docker-guard   # second terminal
export DOCKER_HOST=tcp://127.0.0.1:2375
```

The sandbox firewall is not running in this setup, so computers are not network-isolated from the
host the way they are in the compose stack. The end-to-end tests in `apps/web/e2e` use the same
setup; `computer.spec.ts` is skipped unless the server has a computer provider.

To run the whole stack from your checkout with the server reloading on source changes:

```sh
docker compose --project-directory . -f docker/docker-compose.yml \
  -f docker/docker-compose.dev.yml up -d --build
```

### Docker verification checklist

Some behaviour cannot run in a sandbox without Docker or an X stack, so the unit tests cover it with
fakes. Check these by hand on a Docker host before a release:

- **The computer's screen lock (S-7).** Build the computer image (`docker/computer.Dockerfile`).
  Inside it, run `pnpm --filter @openbots/computer-agent test` with `DISPLAY` set, so
  `display.test.ts` runs against real Xvfb, x11vnc and Chromium. Then, with a Bot's screen
  running:
  - In the Bot's terminal or through `bash`, `env` shows no `OPENBOTS_AGENT_TOKEN`, and neither
    do `tr '\0' '\n' < /proc/1/environ` nor `docker inspect` on the computer's container.
    `/var/lib/openbots/token` does not exist once the agent is up.
  - `curl http://127.0.0.1:9222/json/version` fails: Chromium has no DevTools port.
  - Nothing listens on `127.0.0.1:5910` or `[::1]:5900`: x11vnc is on
    `/tmp/openbots/screens/screen-0/vnc.sock`, and `ls -l` on it as root shows it is
    `screen-0`'s, mode 0755.
  - **Downloads (K1).** Have Bot A download a file in its browser. It shows up in
    `/home/bot/Downloads` in the file browser, `read_file` returns it, and `ls -l` shows it as
    `screen-0`'s, group `bot`, mode 0664; `ls -ld /home/bot/Downloads` shows `drwxrwsrwt`.
    `/home/bot/.config/openbots/chromium` is gone after the first start on an upgraded computer.
  - **Nothing to take first (S-7).** With Bot B's screen stopped, have Bot A run
    `touch /tmp/.X11-unix/X11 /tmp/.X11-lock` and `python3 -m http.server 5911 &`, then start
    Bot B's screen: it comes up, and the preview shows its desktop.
  - `ps -o uid,gid,cmd -C Xvfb,x11vnc,chrome` shows each screen's processes as uid and gid
    2000+n, and the agent (`ps -o ruid,euid -C node`) as real uid 0, effective uid 1000.
  - **Cross-screen access is refused (S-7).** `display.test.ts` "another screen (S-7)" must pass
    as root with `/usr/local/libexec/openbots/runas` installed, so its "as root" case runs too.
    Then, with two Bots' screens running, have Bot A run, through `bash`:
    `xdotool getmouselocation` works; `DISPLAY=:11 xdotool getmouselocation` (Bot B's display)
    fails with "Can't open display"; `cat /tmp/openbots/screens/screen-1/Xauthority` and
    `ls /var/lib/openbots/screens/screen-1` fail with "Permission denied". The terminal can reach
    no display at all.
  - Each Bot keeps its logins across a computer restart, and a new Bot that gets a deleted Bot's
    screen number starts logged out.
  - The web preview still shows the screen, and the browser tools still drive Chromium.
  - Take the screen over and ask the Bot to run a command. It waits, then answers that the owner
    has the screen.

## License

OpenBots is source available under the [Business Source License 1.1](LICENSE).
You can self-host it and change it for your own company or team. You can't
offer it to others as a hosted service, or sell setup or consulting services
for it, without a separate agreement. Each version becomes Apache 2.0 four
years after it is published.

The `ee/` directory holds the managed service's proprietary code, under
[ee/LICENSE](ee/LICENSE).

## Terms

Using OpenBots, including the apps and the shared relay, means you accept the
[Terms and Conditions](docs/TERMS.md). In short: you are responsible for what your Bots do, and
OpenBots is not liable for their actions; the shared relay is free, with no promise of
availability or latency, and may change at any time.

The website serves a copy at `/terms/`. Change [docs/TERMS.md](docs/TERMS.md) here: the
`terms-www` workflow then opens a matching pull request on
[OpenBots-www](https://github.com/danielpang/OpenBots-www) and links it from yours, so merge both
together. It needs the `OPENBOTS_WWW_TOKEN` secret (see the workflow for the token it expects).
