# The standalone image

`ghcr.io/danielpang/openbots/standalone` runs the whole of OpenBots in one container with one
volume: the server, PostgreSQL, Redis and the Bots' computer. It is for platforms that run one
container and no Docker inside it (Fly Machines, Sprites, Railway, Render) and for a plain
`docker run` on a machine you own. Where Docker is available, the compose stack (`install.sh`) is
the hardened path; see [Isolation](#isolation) below.

```sh
docker run -d --name openbots --restart unless-stopped \
  -v openbots-data:/data -p 127.0.0.1:3000:3000 \
  ghcr.io/danielpang/openbots/standalone:latest
docker exec -it openbots openbots pair
```

The first boot generates the settings, creates the database and runs the migrations, which takes
a minute or so. `openbots pair` then prints a QR code before any owner exists: scan it with the
OpenBots app and the phone's onboarding creates the owner. Or open `http://localhost:3000` and
let the web wizard do it. Publishing the port is optional: with the relay (`OPENBOTS_RELAY_URL`)
the phone reaches the server through an outbound connection only.

Build it from the repository root with
`docker build -f docker/standalone.Dockerfile -t openbots-standalone .`.

## What runs inside

s6-overlay is the container's init. It starts these services in order, restarts any that dies,
and stops them in reverse order when the container stops:

| Service           | What it is                                                                                                                                                                                                                  | Runs as                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `standalone-init` | A oneshot. On first boot it writes `/data/.env` and initialises the database cluster. On every boot it adds any missing setting, fixes owners and modes under `/data`, and checks the database role, database and pgvector. | root                                             |
| `postgres`        | PostgreSQL 16 with pgvector, data in `/data/pgdata`, socket in `/run/postgresql`, listening on 127.0.0.1:5432 only, a password for every TCP client.                                                                        | `postgres` (991)                                 |
| `redis`           | Redis, data in `/data/redis`, append-only, bound to 127.0.0.1:6379, with a password.                                                                                                                                        | `redis` (992)                                    |
| `computer-agent`  | The computer image's control agent on 127.0.0.1:7070: the desktop, Chromium and the terminal. Its token is in a root-only file it deletes once read.                                                                        | root, dropping every Bot program to `bot` (1000) |
| `openbots`        | The server, role `all` (API, web app, workers and scheduler) on port 3000, once the other three are ready. Its secrets reach it as files under `/run/openbots`.                                                             | `openbots` (990), no capabilities                |

Logs from every service go to the container's output (`docker logs openbots`).

## The volume

Everything that lasts is under `/data`:

| Path            | Holds                                                                  | Owner and mode   |
| --------------- | ---------------------------------------------------------------------- | ---------------- |
| `/data/.env`    | The settings written on first boot, the master key among them          | root, 0600       |
| `/data/pgdata`  | The database cluster                                                   | `postgres`, 0700 |
| `/data/redis`   | Redis's append-only file                                               | `redis`, 0700    |
| `/data/files`   | Uploads and Artifact files (`OPENBOTS_FILES_DIR`)                      | `openbots`, 0711 |
| `/data/home`    | The Bots' home, which `/home/bot` links to                             | `bot`, 0750      |
| `/data/agent`   | The computer agent's state: the cookie store and the Chromium profiles | root, 0711       |
| `/data/backups` | Where `openbots backup` writes                                         | root, 0700       |

`/data` itself is root's with mode 0711, so the `bot` user reaches its home and nothing else.

## Settings

`/data/.env` takes every setting in the repository's `.env.example`. The container's own
environment overrides it, so a platform's secrets work without editing the file:
`fly secrets set OPENBOTS_RELAY_URL=wss://...` and a restart is enough. Edit the file with
`docker exec -it openbots nano /data/.env` and restart the container to apply a change.

On first boot `standalone-init` generates the values `install.sh` generates for the compose
stack, unless the container's environment already gives one:

| Setting                         | First value                                     |
| ------------------------------- | ----------------------------------------------- |
| `OPENBOTS_MASTER_KEY`           | 32 random bytes, base64                         |
| `POSTGRES_PASSWORD`             | random hex, the password of the `openbots` role |
| `OPENBOTS_DB_APP_PASSWORD`      | random hex, the password of `openbots_app`      |
| `OPENBOTS_REDIS_PASSWORD`       | random hex, Redis's password                    |
| `OPENBOTS_COMPUTER_AGENT_TOKEN` | random hex, the computer agent's token          |
| `OPENBOTS_PUBLIC_URL`           | `http://localhost:3000`                         |
| `OPENBOTS_TIMEZONE`             | `TZ` from the environment, else `UTC`           |

Changing `POSTGRES_PASSWORD` or `OPENBOTS_REDIS_PASSWORD` takes effect at the next start: the
database role gets the new password on each boot.

The image fixes these, whatever the environment or `/data/.env` say:

| Setting                       | Value                                                             |
| ----------------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`                | `postgres://openbots:<POSTGRES_PASSWORD>@127.0.0.1:5432/openbots` |
| `REDIS_URL`                   | `redis://:<OPENBOTS_REDIS_PASSWORD>@127.0.0.1:6379`               |
| `OPENBOTS_COMPUTER_AGENT_URL` | `http://127.0.0.1:7070`                                           |
| `OPENBOTS_STDIO_RUNNER`       | `computer`: stdio connectors run under the computer agent         |
| `OPENBOTS_FILES_DIR`          | `/data/files`                                                     |
| `OPENBOTS_ROLE`               | `all`                                                             |
| `OPENBOTS_STANDALONE`         | `1`                                                               |
| `DOCKER_HOST`                 | unset                                                             |

The standalone image is a single person's install: `OPENBOTS_DEPLOYMENT=managed` stops the
container at boot with a message saying so. `OPENBOTS_HTTP_BIND` has no meaning here; choose
what to publish with `docker run -p` or the platform's settings. Set `OPENBOTS_PUBLIC_URL` when
the platform gives the container a public hostname and you want webhooks or connector sign-in.

Plan for about 2 GB of memory (Chromium, PostgreSQL and Node together), 2 CPUs and a 10 GB
volume to start.

## Commands

Run these with `docker exec <container> openbots <command>` (`fly ssh console -C "openbots
pair"` on Fly). Each runs with the settings the server has.

| Command                      | What it does                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pair [--name <n>] [--link]` | Prints a QR code for pairing a phone; `--link` prints the link instead. Use `docker exec -it` for the QR code |
| `devices [revoke <id>]`      | Lists paired devices, or revokes one                                                                          |
| `relay`                      | Shows this server's relay host id and whether the relay sees it linked                                        |
| `keygen`                     | Prints a fresh `OPENBOTS_MASTER_KEY`                                                                          |
| `rotate-key`                 | Re-encrypts every stored secret under `OPENBOTS_MASTER_KEY`                                                   |
| `migrate`                    | Applies the database migrations (the server does this at every start)                                         |
| `backup [dir]`               | Backs up into `dir`, by default `/data/backups/<UTC timestamp>`                                               |
| `restore <dir> [--yes]`      | Restores a backup, stopping the server while it runs                                                          |

To rotate the master key, follow the README's "Rotating the master key" with `/data/.env` in
place of `.env`, `docker exec openbots openbots keygen` for the new key, and a container restart
in place of `docker compose up -d`.

## Backup and restore

```sh
docker exec openbots openbots backup
docker cp openbots:/data/backups/<timestamp> ./openbots-backup
```

A backup holds the database dump, `files.tar.gz`, the Bots' home as `home.tar.gz`, the computer
agent's state as `agent.tar.gz` and a `MANIFEST` with checksums. It is checked before the command
finishes, as the compose stack's is. It does not hold `/data/.env`: keep a copy of it, or at least
of `OPENBOTS_MASTER_KEY`, apart from the backup. A backup on the volume is lost with the volume,
so copy it off.

```sh
docker cp ./openbots-backup openbots:/data/backups/restore
docker exec openbots openbots restore /data/backups/restore --yes
```

`restore` verifies the backup, stops the `openbots` and `computer-agent` services, recreates the
database, puts back `/data/files`, `/data/home` and `/data/agent`, and starts the services again.
Without `--yes` it asks first, which needs `docker exec -it`. A backup of the compose stack restores
too, as long as it holds one computer volume: that volume becomes the Bots' home. Restore with the
master key the backup was made under. A volume snapshot from the platform (`fly volumes snapshots`)
is the coarser alternative.

## Upgrade

Pull the new image and recreate the container on the same volume:

```sh
docker pull ghcr.io/danielpang/openbots/standalone:latest
docker rm -f openbots
docker run -d --name openbots --restart unless-stopped \
  -v openbots-data:/data -p 127.0.0.1:3000:3000 \
  ghcr.io/danielpang/openbots/standalone:latest
```

On Fly, `fly deploy` does the same. Migrations run at start, and the computer agent comes from the
same release, so there is nothing else to pull. PostgreSQL stays on major version 16; a later
major version would come with upgrade steps in the release notes.

## Isolation

The compose stack gives each computer its own container on a sandbox network, behind a firewall
that keeps it from the server, the database and your network. The standalone image cannot: it
is one kernel and one container. The Bots' shells and browsers run as the `bot` user beside the
server, and what follows is what that means.

- The Bots' programs share the container's loopback with the server's port, PostgreSQL, Redis and
  the computer agent. Each of those asks for a key, a password or a token the `bot` user cannot
  read, and every server route needs a key the Bots do not hold.
- They run as other users than the server, the database and the agent, so they cannot read those
  processes' memory or files, the settings in `/data/.env` among them.
- They can reach whatever the container can reach: the internet, the machine's own network, and a
  cloud VM's metadata address (169.254.169.254), which on some platforms hands out credentials.
  Block that address in the platform's firewall, or route the Bots through an allowlisting proxy
  with `OPENBOTS_SANDBOX_EGRESS_PROXY`.
- A flaw in the Linux kernel, or in the agent's user switching, reaches everything in the
  container at once.

That suits one person on a machine they own, the way one runs a coding agent on a VPS. Where
Docker is available, on any VM you control, the compose stack is the hardened path.
