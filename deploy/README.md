# Running OpenBots on a VM

Templates for running OpenBots around the clock on a machine you rent, so Bots and Routines keep working while your Mac sleeps. Your phone reaches the server through the private relay, so none of them needs a public address, DNS or a certificate. Background: [docs/MOBILE_AND_VM_PLAN.md](../docs/MOBILE_AND_VM_PLAN.md) section 8, and the README's "Run OpenBots 24/7 on a VM".

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

On any Docker host, the standalone image alone:

```sh
docker run -d --name openbots --restart unless-stopped \
  -v openbots-data:/data -e OPENBOTS_RELAY_URL=wss://<the relay> \
  ghcr.io/danielpang/openbots/standalone:<release>
docker exec openbots openbots pair
```

Other commands run the same way: `openbots devices`, `openbots relay`, `openbots backup [dir]`, `openbots restore <dir>`, `openbots rotate-key`. Settings come from `/data/.env`, written on first boot, and the container's environment overrides them.
