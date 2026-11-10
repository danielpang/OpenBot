# Running OpenBots on a VM

Templates for running OpenBots around the clock on a machine you rent, so Bots and Routines keep working while your Mac sleeps. Your phone reaches the server through the private relay, so none of them needs a public address, DNS or a certificate. Background: [docs/plans/MOBILE_AND_VM_PLAN.md](../docs/plans/MOBILE_AND_VM_PLAN.md) section 8, and the [VM setup guide](../docs/VM_SETUP.md).

## Two shapes

| Shape                | What runs                                                                                                                                                                                      | Use it where                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Compose stack**    | The full install: the server, Postgres and Redis in their own containers, and each Bot's computer in its own container behind the Docker guard and the sandbox firewall                        | Any VM where you can run Docker: EC2, Hetzner, DigitalOcean, a home server. **This is the hardened path; prefer it.**         |
| **Standalone image** | `ghcr.io/danielpang/openbots/standalone`: the server, Postgres, Redis and the Bots' computer in one container, with one volume at `/data`. About 2 GB of memory and 2 CPUs, port 3000 optional | A platform that runs one container and no Docker inside it: Fly Machines, Sprites, Railway, Render. Also one person on one VM |

The difference is isolation. In the compose stack a Bot's shell runs in a separate container that cannot reach the server, the database or the network the server is on. In the standalone image the Bots' shells run in the same container as the server, as another user, on one kernel. They cannot read the server's files or secrets, but they can reach the server's port on loopback (every route still needs a key the Bot does not have) and the VM's own network, including a cloud metadata address unless you block it. [docs/SECURITY.md](../docs/SECURITY.md) lists this as a known difference.

## Templates

| Template                                | Shape            | Notes                                                                                                                                                                             |
| --------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [fly/](fly/README.md)                   | Standalone image | One Fly Machine with a volume, never stopped. `fly ssh console -C "openbots pair"` pairs your phone                                                                               |
| [sprites/](sprites/README.md)           | Standalone image | A Sprite pauses when idle, and OpenBots pauses with it: good for use on demand, not for Routines around the clock                                                                 |
| [ec2/](ec2/README.md)                   | Compose stack    | `cloud-init.yaml` installs Docker and runs `install.sh --pair`; the QR code lands in a root-only file on the instance. Works as user data on Hetzner, DigitalOcean and others too |
| Railway, Render, Modal, any Docker host | Standalone image | Run the image with a persistent volume at `/data`, then `openbots pair` in the container's shell. Modal is built for shorter work; the platforms above fit a 24/7 server better   |

**Pair first on Railway and Render.** These platforms publish the service's port as soon as it runs, and until an owner exists whoever opens the web app first can create the owner. Start the service without a public domain if the platform allows it, run `openbots pair` in its shell and pair your phone, and only then give it a public address. If the port is public from the start, pair at once after the first deploy.

**Set the relay.** Every template leaves `OPENBOTS_RELAY_URL` empty for you to fill in. With the recommended setup (no inbound rule, no public address) the relay is the phone's only way to the server: without it, the phone cannot reach the server at all. `install.sh --pair`, the EC2 template and the standalone image's boot log warn when it is empty and no https `OPENBOTS_PUBLIC_URL` is set.

On any Docker host, the standalone image alone:

```sh
docker run -d --name openbots --restart unless-stopped \
  --stop-timeout 60 --pids-limit 4096 --cap-add NET_ADMIN \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v openbots-data:/data -e OPENBOTS_RELAY_URL=wss://<the relay> \
  ghcr.io/danielpang/openbots/standalone:<release>
docker exec -it openbots openbots pair
```

[docker/standalone/README.md](../docker/standalone/README.md) explains each flag. Stop it with `docker stop -t 60 openbots`, never `docker rm -f`, so PostgreSQL shuts down cleanly. Other commands run the same way: `openbots devices`, `openbots relay`, `openbots backup` (a new `/data/backups/<timestamp>` each time), `openbots restore <dir> --yes`, `openbots rotate-key`. Settings come from `/data/.env`, written on first boot, and the container's environment overrides them, except for the settings the image fixes (`DATABASE_URL`, `REDIS_URL` and the others listed in the standalone README), which it ignores with a line in the log.

The standalone image keeps everything on one disk: the database, the Bots' home and any backup written to `/data/backups`. A Bot that fills its home fills the disk under the database too. The image logs a warning below 10 percent free; give the volume room and copy backups off it.
