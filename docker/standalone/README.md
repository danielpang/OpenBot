# The standalone image

`ghcr.io/danielpang/openbots/standalone` runs the whole of OpenBots in one container with one
volume: the server, PostgreSQL, Redis and the Bots' computer. It is for platforms that run one
container and no Docker inside it (Fly Machines, Sprites, Railway, Render) and for a plain
`docker run` on a machine you own. Where Docker is available, the compose stack (`install.sh`) is
the hardened path; see [Isolation](#isolation) below.

```sh
docker run -d --name openbots --restart unless-stopped \
  --stop-timeout 60 --pids-limit 4096 --cap-add NET_ADMIN \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v openbots-data:/data -p 127.0.0.1:3000:3000 \
  -e OPENBOTS_RELAY_URL=wss://<the relay> \
  ghcr.io/danielpang/openbots/standalone:latest
docker exec -it openbots openbots pair
```

What each flag is for:

| Flag                                          | Why                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--stop-timeout 60`                           | Docker's default is 10 seconds, then it kills everything. PostgreSQL and Redis need longer to shut down cleanly; the image gives its services 45 seconds in all                       |
| `--pids-limit 4096`                           | A Bot's runaway shell (a fork bomb, a build gone wrong) runs out of processes before the server, PostgreSQL and Redis do                                                              |
| `--cap-add NET_ADMIN`                         | Optional. Lets the image block the cloud metadata address (169.254.169.254) for the Bots' users at boot. See [Isolation](#isolation)                                                  |
| `--log-opt max-size=10m --log-opt max-file=3` | Keeps the container's log from growing until the disk is full. Skip it if your Docker daemon already rotates logs                                                                     |
| `-p 127.0.0.1:3000:3000`                      | Optional: with the relay (`OPENBOTS_RELAY_URL`) the phone reaches the server through an outbound connection only                                                                      |
| `-e OPENBOTS_RELAY_URL=...`                   | The relay the phone goes through. Without it, and without an https `OPENBOTS_PUBLIC_URL`, a phone outside this machine's network cannot reach the server, and the log says so at boot |

`--shm-size` is not needed: Chromium runs with `--disable-dev-shm-usage`, so Docker's default
64 MB `/dev/shm` is enough.

The first boot generates the settings, creates the database and runs the migrations, which takes
a minute or so. `openbots pair` then prints a QR code before any owner exists: scan it with the
OpenBots app and the phone's onboarding creates the owner. Or open `http://localhost:3000` and
let the web wizard do it.

**Pair before the port is public.** Until an owner exists, whoever opens the web app first can
create the owner. On a platform that publishes the port at once (Railway, Render, a VM with port
3000 open), run `openbots pair` in the container's shell and pair your phone before you give the
service a public address.

Build it from the repository root with
`docker build -f docker/standalone.Dockerfile -t openbots-standalone .`.

## What runs inside

s6-overlay is the container's init. It starts these services in order, restarts any that dies,
and stops them in reverse order when the container stops:

| Service           | What it is                                                                                                                                                                                                                                                                | Runs as                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `volume-lock`     | Holds an exclusive lock on `/data/.lock` while the container runs. A second container on the same volume stops at once with a message, before PostgreSQL or Redis start. See [One volume, one container](#one-volume-one-container)                                       | root                                             |
| `standalone-init` | A oneshot. On first boot it writes `/data/.env` and initialises the database cluster. On every boot it adds any missing setting, fixes owners and modes under `/data`, checks the database role, database and pgvector, and refuses to start on the problems listed below | root                                             |
| `postgres`        | PostgreSQL 16 with pgvector, data in `/data/pgdata`, socket in `/run/postgresql`, listening on 127.0.0.1:5432 only, a password for every TCP client                                                                                                                       | `postgres` (991)                                 |
| `redis`           | Redis, data in `/data/redis`, append-only, bound to 127.0.0.1:6379, with a password                                                                                                                                                                                       | `redis` (992)                                    |
| `computer-agent`  | The computer image's control agent on 127.0.0.1:7070: the desktop, Chromium and the terminal. Its token is in a root-only file it deletes once read                                                                                                                       | root, dropping every Bot program to `bot` (1000) |
| `openbots`        | The server, role `all` (API, web app, workers and scheduler) on port 3000, once the other three are ready. Its secrets, `DATABASE_URL` and `REDIS_URL` among them, reach it as files under `/run/openbots`; the database and Redis passwords are not in its environment   | `openbots` (990), no capabilities                |
| `disk-watch`      | Checks the free space on `/data` every 5 minutes and logs a warning while it is under 10 percent                                                                                                                                                                          | root                                             |

Logs from every service go to the container's output (`docker logs openbots`).

`standalone-init` stops the container, with a message saying what to do, when:

- a database exists in `/data/pgdata` and `OPENBOTS_MASTER_KEY`, `POSTGRES_PASSWORD`,
  `OPENBOTS_DB_APP_PASSWORD` or `OPENBOTS_REDIS_PASSWORD` is missing from both `/data/.env` and the
  environment. Generating a new master key there would make every stored secret unreadable, so it
  refuses instead: put the values back in `/data/.env` or the environment, then start again;
- `/data/pgdata` holds files but no `PG_VERSION`, so it is not a complete cluster. The first
  `initdb` runs in `/data/pgdata.initdb` and moves into place only when it finishes, so a first boot
  cut short leaves nothing half made in `/data/pgdata`;
- the cluster is of another PostgreSQL major version than the image's (see [Upgrade](#upgrade));
- `OPENBOTS_DEPLOYMENT=managed` is set.

## The volume

Everything that lasts is under `/data`:

| Path            | Holds                                                                  | Owner and mode   |
| --------------- | ---------------------------------------------------------------------- | ---------------- |
| `/data/.env`    | The settings written on first boot, the master key among them          | root, 0600       |
| `/data/.lock`   | The lock `volume-lock` holds                                           | root, 0600       |
| `/data/pgdata`  | The database cluster                                                   | `postgres`, 0700 |
| `/data/redis`   | Redis's append-only file                                               | `redis`, 0700    |
| `/data/files`   | Uploads and Artifact files (`OPENBOTS_FILES_DIR`)                      | `openbots`, 0700 |
| `/data/home`    | The Bots' home, which `/home/bot` links to                             | `bot`, 0750      |
| `/data/agent`   | The computer agent's state: the cookie store and the Chromium profiles | root, 0711       |
| `/data/backups` | Where `openbots backup` writes by default                              | root, 0700       |

`/data` itself is root's with mode 0711, so the `bot` user reaches its home and nothing else.

**One disk holds everything.** The database, Redis, uploads, the Bots' home and the backups
written to `/data/backups` share the volume. A Bot that fills its home (a large download, a build
cache) fills the disk under PostgreSQL too, and PostgreSQL stops accepting writes when the disk is
full. There is no separate quota for the Bots' home. `disk-watch` logs a warning while less than 10
percent is free, `openbots backup` refuses to write onto `/data` when that would leave less than
10 percent free, and `openbots restore` checks for twice the backup's size first. Give the volume
room (10 GB to start, more for Bots that download a lot), and grow it when the warning appears.

## One volume, one container

Two containers on one volume would run two PostgreSQL servers on one data directory and corrupt
it. The entrypoint refuses to start while another container holds an exclusive `flock` on
`/data/.lock`, so a second container on the same volume stops at once (exit 75) with "another
container is using this volume". Then `volume-lock` takes the lock before anything else starts and
holds it while the container runs.
Stop the old container before you start a new one (see [Upgrade](#upgrade)). The lock holds
between containers on one machine; a volume on a network filesystem shared between machines is not
supported.

## Settings

`/data/.env` takes every setting in the repository's `.env.example`. The container's own
environment overrides it, so a platform's secrets work without editing the file:
`fly secrets set OPENBOTS_RELAY_URL=wss://...` and a restart is enough. Edit the file with
`docker exec -it openbots nano /data/.env` and restart the container to apply a change.

A secret can also come as `NAME_FILE`, the path of a file holding it (a Docker or Kubernetes
secret). The image reads such a file into `NAME` when it starts and unsets `NAME_FILE`, so the
server always sees one of the two. A `NAME_FILE` in the environment wins over `NAME` in
`/data/.env`, as any setting in the environment does.

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
database role gets the new password on each boot. Removing one, or the master key, while the
database exists stops the container at boot instead (see [What runs inside](#what-runs-inside)).

The image fixes these, whatever the environment or `/data/.env` say:

| Setting                       | Value                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | `postgres://openbots:<POSTGRES_PASSWORD>@127.0.0.1:5432/openbots`                     |
| `REDIS_URL`                   | `redis://:<OPENBOTS_REDIS_PASSWORD>@127.0.0.1:6379`                                   |
| `OPENBOTS_COMPUTER_AGENT_URL` | `http://127.0.0.1:7070`                                                               |
| `OPENBOTS_STDIO_RUNNER`       | `computer`: stdio connectors run under the computer agent                             |
| `OPENBOTS_FILES_DIR`          | `/data/files`                                                                         |
| `OPENBOTS_MCP_DIR`            | `/opt/openbots/mcp`                                                                   |
| `OPENBOTS_ROLE`               | `all`                                                                                 |
| `OPENBOTS_STANDALONE`         | `1`                                                                                   |
| `OPENBOTS_SETUP_PAIRING_ONLY` | `1`: the web wizard cannot create the owner; pair from the terminal (`openbots pair`) |
| `PORT`                        | `3000`                                                                                |
| `DOCKER_HOST`                 | unset                                                                                 |

A value for one of these, from the environment (`fly secrets set DATABASE_URL=...`, `docker run
-e`) or from `/data/.env`, and its `NAME_FILE`, is ignored, and each boot logs a line naming it
("Ignoring DATABASE_URL from the container's environment: the image fixes it"). Remove it
(`fly secrets unset DATABASE_URL`). The container keeps starting; it does not stop over it.

The standalone image is a single person's install: `OPENBOTS_DEPLOYMENT=managed` stops the
container at boot with a message saying so. `OPENBOTS_HTTP_BIND` has no meaning here; choose
what to publish with `docker run -p` or the platform's settings. Set `OPENBOTS_PUBLIC_URL` when
the platform gives the container a public hostname and you want webhooks or connector sign-in.

## Resources

Plan for about 2 GB of memory (Chromium, PostgreSQL and Node together), 2 CPUs and a 10 GB
volume to start.

When memory runs out, the kernel kills the process it scores worst. The computer agent and
everything it starts (the Bots' shells and browsers) run with `oom_score_adj` +500, so a Bot's
program goes first. The server, PostgreSQL and Redis ask for -500; lowering it needs
`CAP_SYS_RESOURCE`, which Docker does not give by default, so without
`--cap-add SYS_RESOURCE` they stay at 0, still well below the Bots. Docker's own
`--memory` limit applies to the whole container.

The container cannot limit the Bots' processes by itself (its cgroup is read-only under Docker),
so give the container `--pids-limit` (4096 is plenty). On Fly the Machine is a VM, and its memory,
process limit and `/dev/shm` are the VM's.

## Commands

Run these with `docker exec <container> openbots <command>` (`fly ssh console -C "openbots
pair"` on Fly). Each runs with the settings the server has.

| Command                      | What it does                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pair [--name <n>] [--link]` | Prints a QR code for pairing a phone; `--link` prints the link instead. Use `docker exec -it` for the QR code                                                     |
| `devices [revoke <id>]`      | Lists paired devices, or revokes one                                                                                                                              |
| `relay`                      | Shows this server's relay host id and whether the relay sees it linked                                                                                            |
| `keygen`                     | Prints a fresh `OPENBOTS_MASTER_KEY`                                                                                                                              |
| `rotate-key`                 | Re-encrypts every stored secret under `OPENBOTS_MASTER_KEY`                                                                                                       |
| `migrate`                    | Applies the database migrations (the server does this at every start)                                                                                             |
| `backup [dir]`               | Backs up into a new `<dir>/<UTC timestamp>`, `dir` being `/data/backups` by default, so the same command runs every time. `--out <dir>` writes into exactly `dir` |
| `restore <dir> [--yes]`      | Restores a backup, stopping the server while it runs. Without a terminal (`docker exec` without `-it`) it needs `--yes`, and stops with a message otherwise       |

To rotate the master key, follow the README's "Rotating the master key" with `/data/.env` in
place of `.env`, `docker exec openbots openbots keygen` for the new key, and a container restart
in place of `docker compose up -d`.

## Backup and restore

```sh
docker exec openbots openbots backup                 # writes /data/backups/<timestamp>
docker cp openbots:/data/backups/<timestamp> ./openbots-backup
```

A backup holds the database dump, `files.tar.gz`, the Bots' home as `home.tar.gz`, the computer
agent's state as `agent.tar.gz` and a `MANIFEST` with checksums. It is checked before the command
finishes, as the compose stack's is. It does not hold `/data/.env`: keep a copy of it, or at least
of `OPENBOTS_MASTER_KEY`, apart from the backup. A backup on the volume is lost with the volume,
so copy it off, and delete old ones from `/data/backups`: they take space on the same disk as the
database. With a second disk mounted in the container, `openbots backup /mnt/backups` writes there.

To restore onto the same container:

```sh
docker cp ./openbots-backup openbots:/data/backups/restore
docker exec openbots openbots restore /data/backups/restore --yes
```

To restore onto a new container or a new volume, put the old master key in place first, since the
new container generated a key of its own:

1. Set `OPENBOTS_MASTER_KEY=<the old key>` in the new container's `/data/.env`
   (`docker exec -it openbots nano /data/.env`), or pass it as a secret
   (`docker run -e OPENBOTS_MASTER_KEY=...`, `fly secrets set OPENBOTS_MASTER_KEY=...`).
2. Restart the container (`docker restart -t 60 openbots`).
3. Copy the backup in and run `openbots restore <dir> --yes` as above.

`restore` first checks everything: the checksums, the dump, every archive, and that the volume has
twice the backup's size free. Nothing is deleted before those checks pass. It then stops the
`openbots` and `computer-agent` services, empties Redis (the job queues, so no job from before the
restore runs against the restored database), recreates the database, puts back `/data/files`,
`/data/home` and `/data/agent`, and starts the services again. Without `--yes` it asks first, which
needs `docker exec -it`. A backup of the compose stack restores too, as long as it holds one
computer volume: that volume becomes the Bots' home. Restore with the master key the backup was
made under. A volume snapshot from the platform (`fly volumes snapshots`) is the coarser
alternative.

**Moving a server: stop the old one first.** A backup carries the server's identity, the key it
links to the relay with. Restored on a second machine while the first still runs, both dial the
relay as one server, and the phone's traffic goes to whichever linked last. Stop the old container
(or Machine) before you start the restored one.

## Upgrade

Pull the new image, stop the old container cleanly, and start a new one on the same volume:

```sh
docker pull ghcr.io/danielpang/openbots/standalone:latest
docker stop -t 60 openbots
docker rm openbots
docker run -d --name openbots --restart unless-stopped \
  --stop-timeout 60 --pids-limit 4096 --cap-add NET_ADMIN \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v openbots-data:/data -p 127.0.0.1:3000:3000 \
  ghcr.io/danielpang/openbots/standalone:latest
```

Not `docker rm -f`: it kills PostgreSQL without a shutdown, and the next start has to recover the
database from its log. `docker stop -t 60` gives the image's services the 45 seconds they take at
most. The image stops on `SIGTERM` (its `STOPSIGNAL`).

On Fly, `fly deploy` does the same, within `kill_timeout`. Migrations run at start, and the
computer agent comes from the same release, so there is nothing else to pull.

**PostgreSQL's major version.** The image runs PostgreSQL 16 (the Dockerfile's `POSTGRES_MAJOR`).
PostgreSQL opens only the data files of its own major version, so an image on a later major
version stops at boot on a volume made by 16, with a message saying so, and changes nothing. A
release that moves to a new major version says so in its notes. To move the data across:

1. On the old image, back up: `docker exec openbots openbots backup`, and copy the backup and the
   master key off the container.
2. Stop the old container (`docker stop -t 60 openbots`).
3. Start the new image on a **new** volume with the old master key
   (`-e OPENBOTS_MASTER_KEY=<the old key>`), copy the backup in and run
   `openbots restore <dir> --yes`. The dump is portable between major versions.
4. Keep the old volume until the new server works, then remove it.

`pg_upgrade` can convert the old volume in place instead, but it needs both versions' binaries in
one container, which this image does not carry; the backup and restore above is the supported way.

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
  With `--cap-add NET_ADMIN`, the image drops traffic to that address from the Bots' users at boot
  (an `iptables` rule with the `owner` match; the log says "Blocked the metadata address"). Without
  it, block the address in the platform's firewall (on EC2, require IMDSv2 with a hop limit of 1).
- `OPENBOTS_SANDBOX_EGRESS_PROXY` is advisory here. It sets `HTTP_PROXY` and `HTTPS_PROXY` for
  the Bots' programs, and a program that honours them goes through the proxy, but nothing stops a
  program that ignores them from reaching the network directly. In the compose stack the sandbox
  firewall enforces it; in this image only the platform's firewall can.
- On Fly, the Machine's private network is reachable from the Bots' shells: other apps in your
  Fly organization (`<app>.internal`, over its IPv6 network) and, when present, the Machines API
  socket at `/.fly/api`. Keep this app in an organization of its own if others in it hold
  anything a Bot should not reach.
- A flaw in the Linux kernel, or in the agent's user switching, reaches everything in the
  container at once.

That suits one person on a machine they own, the way one runs a coding agent on a VPS. Where
Docker is available, on any VM you control, the compose stack is the hardened path.
