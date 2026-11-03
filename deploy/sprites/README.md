# OpenBots on a Sprite

A [Sprite](https://docs.fly.io/sprites) is a persistent Linux microVM from Fly.io with its own disk, checkpoints and a URL. OpenBots runs on one as the standalone image (server, Postgres, Redis and the Bots' computer in one container) with its data on the Sprite's persistent disk at `/data`. See [deploy/README.md](../README.md) for how this shape compares with the others.

**Read this first: a Sprite pauses when it is idle.** Sprites pause when no HTTP request and no session is active, and services do not keep a Sprite from pausing (the Sprites docs on services say so). While a Sprite is paused, OpenBots is paused with it: Routines do not run, the relay link is down and the phone shows the server as offline. A request to the Sprite's URL wakes it. A Sprite suits OpenBots you use while you use it, at a low cost. For Bots and Routines that work around the clock, use a Fly Machine ([deploy/fly](../fly/README.md)) or a VM ([deploy/ec2](../ec2/README.md)).

These steps were written against the Sprites documentation as it stood at the time and have not been run end to end. Check the commands against the [Sprites CLI reference](https://docs.fly.io/sprites/cli/commands) before you rely on them.

## Create the Sprite and run the image

A Sprite is a VM you install tools into, not a platform that runs a container image directly. Install a container runtime in it (Docker Engine, if your Sprite allows it), then run the standalone image with its data in the Sprite's persistent filesystem:

```sh
sprite create openbots
sprite console -s openbots
```

In the console:

```sh
sudo mkdir -p /data
docker run -d --name openbots --restart unless-stopped \
  --stop-timeout 60 --pids-limit 4096 --cap-add NET_ADMIN \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v /data:/data -p 127.0.0.1:3000:3000 \
  -e OPENBOTS_RELAY_URL=wss://<the relay> \
  ghcr.io/danielpang/openbots/standalone:<release>
```

Set `OPENBOTS_RELAY_URL`: a paused or private Sprite has no other way for the phone to reach it. [docker/standalone/README.md](../../docker/standalone/README.md) explains the other flags.

To have the Sprite start OpenBots again after a cold boot, register it as a service (`sprite-env services create`, see the Sprites docs on services) with a command that starts the container. Give the service `--http-port 3000` only if you want the Sprite's URL to reach OpenBots; the URL needs your Sprites organization to sign in unless you make it public (`sprite url update --auth public`), and a public URL on a server with no owner lets whoever opens it first create the owner.

## Pair your phone

```sh
sprite exec -s openbots -- docker exec openbots openbots pair
```

Scan the QR code with the OpenBots app. It works once and for 5 minutes. On a server with no owner yet, the phone that pairs becomes the owner. Provider keys can be added on the phone, or passed to `docker run` as `-e ANTHROPIC_API_KEY=...`; any setting in [.env.example](../../.env.example) works the same way and overrides `/data/.env`.

Copy the master key somewhere safe: `docker exec openbots grep OPENBOTS_MASTER_KEY /data/.env`.

## Pausing

When a Sprite pauses, every process in it stops where it is, and resumes where it was when the Sprite wakes. For OpenBots that means:

- **A Routine that was running may run twice.** A Routine paused in the middle of its run can be taken up again as a failed or timed-out job when the Sprite wakes, and run from the start a second time. Routines that send a message or change something outside OpenBots may do so twice.
- **Model replies in progress fail.** The connection to the model provider does not survive the pause: a reply that was streaming ends with an error, and the Bot's run stops there. Ask again after the wake.
- **The relay link drops** and comes back by itself within its backoff after the wake. A paused Sprite cannot be woken through the relay, only through its URL.

## Checkpoints and restore

`sprite checkpoint create` saves the Sprite's filesystem; `sprite restore <version>` puts it back and restarts the Sprite. For OpenBots:

- **The data rolls back with it.** A restore returns the database, the files and the Bots' home to the moment of the checkpoint. Messages, memories and Artifacts made since are gone, and so are devices paired since: a phone paired after the checkpoint has to pair again.
- **Postgres starts as after a power cut.** A checkpoint taken while Postgres runs holds the database as a crash would leave it, and Postgres recovers it from its write-ahead log at start. That is safe for Postgres, but for a copy you mean to keep, stop the container first (`docker stop -t 60 openbots`) or run `docker exec openbots openbots backup`.
- **The relay link comes back by itself.** The server dials the relay out again within its backoff after a restore or a wake. A paused Sprite cannot be woken through the relay, only through its URL.
- **Routines should catch up once (not verified).** The scheduler works from each Routine's next run time, so a Routine that came due while the Sprite was paused or being restored should run at the next tick after it is back, once, not once for every time it missed. This follows from the scheduler's design and has not been tested on a Sprite.

## Upgrade and backups

`docker pull ghcr.io/danielpang/openbots/standalone:<new release>`, then `docker stop -t 60 openbots && docker rm openbots` (not `docker rm -f`, which kills Postgres without a shutdown) and run the container again with the same `docker run` line. Migrations run at start and `/data` stays.

Backups: `docker exec openbots openbots backup` writes a new `/data/backups/<timestamp>/` each time, on the same disk as the database; copy it and the master key off the Sprite and delete it there. Restore with `docker exec openbots openbots restore /data/backups/<timestamp> --yes`.

To restore onto a new Sprite, put the old master key in place first: set `OPENBOTS_MASTER_KEY=<the old key>` in its `/data/.env` (or pass `-e OPENBOTS_MASTER_KEY=...` to `docker run`), restart the container with `docker restart -t 60 openbots`, then copy the backup in and restore it. Stop the old Sprite's container first: two servers restored from one backup dial the relay as one server.
