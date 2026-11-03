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
fly secrets set OPENBOTS_RELAY_URL=wss://<the relay>        # the relay your phone goes through
fly secrets set ANTHROPIC_API_KEY=... OPENAI_API_KEY=...     # optional: you can also add providers on the phone
fly secrets set OPENBOTS_TIMEZONE=Europe/Berlin              # when your Routines should run
```

`fly secrets set` restarts the Machine. Any other setting from [.env.example](../../.env.example) works the same way.

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

Fly gives the app its addresses and a certificate for `<your app>.fly.dev`. `auto_stop_machines = "off"` and `min_machines_running = 1` stay as they are: a stopped Machine runs no Routines and holds no relay link. To go back to no public address, comment the section out again and remove the addresses `fly ips list` shows with `fly ips release`.

## Upgrade

Change the tag in `[build] image` and run `fly deploy`. Migrations run at start, and the data on the volume stays. The Bots' computer is part of the image, so it moves to the same release.

## Backups

Inside the Machine, the image's backup command writes a backup of the database, the files, the Bots' home and the computer's sign-ins:

```sh
fly ssh console -C "openbots backup /data/backups"          # writes /data/backups/<timestamp>/
fly ssh console -C "tar -C /data/backups -czf /data/backup.tar.gz <timestamp>"
fly ssh sftp get /data/backup.tar.gz
```

Keep the copy off the Machine, with the master key kept separately: a backup does not hold it. To restore, upload the archive with `fly ssh sftp shell` (`put`), unpack it under `/data/backups` and run `fly ssh console -C "openbots restore /data/backups/<timestamp>"`.

Fly also snapshots volumes daily (`fly volumes snapshots list <volume id>`); a new volume can be made from a snapshot. A snapshot is a coarse copy of the whole disk taken while Postgres runs, so prefer `openbots backup` for anything you mean to restore.
