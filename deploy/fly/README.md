# OpenBots on Fly.io

One Fly Machine runs the standalone image: the server, Postgres, Redis and the Bots' computer in one container, with everything kept on one volume at `/data`. Nothing needs a public address: the server dials the relay out, and your phone reaches it through the relay. See [deploy/README.md](../README.md) for how this shape compares with the compose stack.

You need [flyctl](https://fly.io/docs/flyctl/install/) and a Fly.io account. For what it costs, see [Fly.io's pricing page](https://fly.io/docs/about/pricing/): a `shared-cpu-2x` Machine with 4 GB of memory running all month, plus a 10 GB volume. Your model provider bills its usage separately; each Bot's usage shows in OpenBots.

## Launch

From a checkout of this repository (or with just this `fly.toml` in a folder):

```sh
cd deploy/fly
fly launch --copy-config --no-deploy --name <your app>
fly volumes create data --size 10            # in the app's primary region
```

`fly launch` keeps this file's settings and writes your app name and region into it. Before the first deploy, pick a release in `[build] image` (for example `ghcr.io/danielpang/openbots/standalone:1.2`), so a deploy never upgrades by surprise.

## Settings

The image writes `/data/.env` on its first boot, with a new master key and database passwords. Fly secrets reach the container as environment variables, and those override `/data/.env`:

```sh
fly secrets set OPENBOTS_RELAY_URL=wss://<the relay>        # the relay your phone goes through: without it the phone cannot reach the Machine
fly secrets set ANTHROPIC_API_KEY=... OPENAI_API_KEY=...     # optional: you can also add providers on the phone
fly secrets set OPENBOTS_TIMEZONE=Europe/Berlin              # when your Routines should run
```

`fly secrets set` restarts the Machine. Any other setting from [.env.example](../../.env.example) works the same way, except those the image fixes (`DATABASE_URL`, `REDIS_URL`, `PORT` and the others in [docker/standalone/README.md](../../docker/standalone/README.md#settings)): a secret for one of those is ignored, and each boot logs a line naming it. Remove it with `fly secrets unset <name>`.

`fly.toml` sets `TRUSTED_PROXIES` to `172.16.0.0/16`, the addresses Fly's proxy connects from, so the server reads the client's address from `X-Forwarded-For` for rate limits and webhook IP allowlists. That only matters once the Machine has a public address (below).

## Deploy and pair

```sh
fly deploy
fly ssh console -C "openbots pair"
```

`openbots pair` prints a QR code. Scan it with the OpenBots app on your phone. The code works once and for 5 minutes; run the command again for a new one. On a server with no owner yet, the phone that pairs becomes the owner, so no browser is needed. Add `--link` to print the pairing link as well.

Other commands, the same way:

```sh
fly ssh console -C "openbots devices"       # paired devices; `openbots devices revoke <id>`
fly ssh console -C "openbots relay"         # the host id, and whether the relay sees it linked
fly checks list                             # the /readyz check
fly logs
```

Then copy the master key somewhere safe. Without it, stored secrets and backups cannot be decrypted:

```sh
fly ssh console -C "grep OPENBOTS_MASTER_KEY /data/.env"
```

## A public address (optional)

Webhooks and connector sign-in (OAuth) need a public https address. Pair your phone first: on a server with no owner, whoever opens the address first can create the owner. Then uncomment `[http_service]` in `fly.toml` and:

```sh
fly secrets set OPENBOTS_PUBLIC_URL=https://<your app>.fly.dev
fly deploy
```

Fly gives the app its addresses and a certificate for `<your app>.fly.dev`. Add the addresses `fly ips list` shows to `TRUSTED_PROXIES` in `fly.toml` (for example `TRUSTED_PROXIES = "172.16.0.0/16,<ipv4>,<ipv6>"`) and deploy again: Fly's proxy puts the app's own address last in `X-Forwarded-For`, and the server, which reads that header from the right, needs it listed to find the client before it. `auto_stop_machines = "off"` and `min_machines_running = 1` stay as they are: a stopped Machine runs no Routines and holds no relay link. To go back to no public address, comment the section out again and remove the addresses `fly ips list` shows with `fly ips release`.

## Upgrade

Change the tag in `[build] image` and run `fly deploy`. Fly stops the old Machine with `SIGTERM` and waits `kill_timeout` (60 seconds) before it kills it, which is the time PostgreSQL needs to shut down cleanly; keep it at 60 seconds or more. Migrations run at start, and the data on the volume stays. The Bots' computer is part of the image, so it moves to the same release. A release that moves PostgreSQL to a new major version says so in its notes, and the Machine refuses to start on the old data until you move it across ([docker/standalone/README.md](../../docker/standalone/README.md#upgrade)).

## Resources and isolation

The Machine is a VM, so its memory, its process limit and `/dev/shm` are the VM's, set by Fly from `[[vm]]`; the `docker run` flags of the standalone README have no equivalent here, and Chromium does not need a large `/dev/shm` (it runs with `--disable-dev-shm-usage`). One volume holds the database, the Bots' home and the backups in `/data/backups`: a Bot that fills its home fills the disk under the database, and `fly logs` shows a warning below 10 percent free. Grow the volume with `fly volumes extend`.

The Bots' shells run in the same Machine as the server. They can reach Fly's private network: other apps in your organization (`<app>.internal`) and, when present, the Machines API socket at `/.fly/api`. Keep OpenBots in an organization of its own if others in it hold anything a Bot should not reach. The image blocks the metadata address 169.254.169.254 for the Bots' users at boot. The egress proxy setting (`OPENBOTS_SANDBOX_EGRESS_PROXY`) is advisory in this image: programs that honour `HTTP_PROXY` use it, and nothing stops one that does not.

## Backups

Inside the Machine, the image's backup command writes a backup of the database, the files, the Bots' home and the computer's sign-ins:

```sh
fly ssh console -C "openbots backup"                         # writes a new /data/backups/<timestamp>/
fly ssh console -C "sh -c 'umask 077 && tar -C /data/backups -czf /data/backups/<timestamp>.tar.gz <timestamp>'"
fly ssh sftp get /data/backups/<timestamp>.tar.gz
fly ssh console -C "rm -rf /data/backups/<timestamp> /data/backups/<timestamp>.tar.gz"
```

The archive holds the database and the Bots' sign-ins, so it is written with `umask 077` into `/data/backups`, which only root can open (mode 0700). Each backup takes room on the volume the database uses, and `openbots backup` refuses one that would leave less than 10 percent free, so remove it from the Machine once you have the copy. Keep the copy off the Machine, with the master key kept separately: a backup does not hold it.

To restore onto the same Machine, upload the archive with `fly ssh sftp shell` (`put` it into `/data/backups`), then:

```sh
fly ssh console -C "sh -c 'umask 077 && tar -C /data/backups -xzf /data/backups/<timestamp>.tar.gz'"
fly ssh console -C "openbots restore /data/backups/<timestamp> --yes"
```

To restore onto a new app or a new volume, put the old master key in place first, since the new Machine generated a key of its own: `fly secrets set OPENBOTS_MASTER_KEY=<the old key>` (which restarts the Machine), then upload and restore as above. Stop the old Machine before the new one starts (`fly machine stop`, or `fly scale count 0` on the old app): a restored backup carries the server's identity, and two Machines running it dial the relay as one server. The restore empties Redis, so no job queued before it runs against the restored database.

Fly also snapshots volumes daily (`fly volumes snapshots list <volume id>`); a new volume can be made from a snapshot. A snapshot is a coarse copy of the whole disk taken while Postgres runs, so prefer `openbots backup` for anything you mean to restore.
