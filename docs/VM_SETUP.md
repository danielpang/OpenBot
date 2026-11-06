# Run OpenBots on a VM with the shared relay

Use an always-on Linux VM or home server so Bots and Routines keep working while your Mac sleeps.
This guide uses the Docker Compose stack and the shared OpenBots relay. You do not need a public
OpenBots HTTP port, domain or TLS certificate. You still need outbound internet access for images,
models, tools and the relay.

The iOS and Android apps are on their way. Phone pairing below requires a compatible mobile build;
until then, use the web UI or Mac app through the SSH tunnel described below.

## 1. Prepare the machine

- Use a Linux machine with Docker Engine and Compose v2.24 or later, plus `git`, `curl` and `openssl`.
- Use Docker's iptables firewall backend. Rootless Docker and the nftables backend need equivalent
  sandbox rules applied separately; see the [self-hosting reference](SELF_HOSTING.md#install).
- Allow SSH only from your address, or use your provider's private management access. Do not open
  port 3000 or the database/Redis ports to the internet.
- Choose an always-on machine with room for browser workloads and persistent disk storage. Resource
  needs grow with the number of active computers.

For provider-specific provisioning, see [EC2](../deploy/ec2/README.md). For single-container platforms,
see [deployment options](../deploy/README.md) and the [standalone isolation trade-offs](ARCHITECTURE.md#standalone-an-alternative-not-an-extra-service).

## 2. Install and configure before starting

Run on the VM:

```sh
git clone https://github.com/danielpang/OpenBots.git
cd OpenBots
bash install.sh --no-start
```

The script creates `.env` and generates the encryption key and database passwords. Edit `.env` and
set these values, replacing existing entries rather than adding duplicates:

```dotenv
OPENBOTS_RELAY_URL=wss://openbots-relay.fly.dev
OPENBOTS_HTTP_BIND=127.0.0.1:
```

Keep the trailing colon in `OPENBOTS_HTTP_BIND`. It limits HTTP access to the VM itself; the shared
relay provides the phone's remote connection. Keep `.env` private and back it up securely, especially
`OPENBOTS_MASTER_KEY`: without that key your stored secrets cannot be decrypted.

For a pinned deployment, set `OPENBOTS_VERSION` to a published release version in `.env` before
starting. Otherwise the default image tag applies.

## 3. Start and finish setup

```sh
bash install.sh --pair
```

This starts the stack, waits for readiness and prints a short-lived pairing QR code. Scan it with
a compatible OpenBots mobile build. On a fresh server with no owner, the first phone to pair becomes
the owner; follow its setup to add a model provider and your first Bot. Treat the code as a secret.

To generate a new code, or check the stack:

```sh
docker compose run --rm openbots pair
docker compose ps
docker compose run --rm openbots relay
docker compose logs --tail=100 openbots
```

Without a mobile build, finish setup through the web UI instead. On your Mac, open an SSH tunnel
(replace `user@your-vm` with your VM's SSH address):

```sh
ssh -N -L 3000:127.0.0.1:3000 user@your-vm
```

Keep the tunnel open and visit [http://localhost:3000](http://localhost:3000). You can also add that
address as a self-hosted server in the Mac app. Use another local port if 3000 is already in use.
Pair your phone later from Settings > Devices or with the command above.

**Create the owner before exposing any public web address.** On a fresh install the first visitor
to the setup wizard can create the owner account. This guide keeps HTTP on loopback throughout.

## 4. Keep it running

- Back up data and `.env` separately, and copy backups off the machine:
  [backup and restore](SELF_HOSTING.md#backup-and-restore).
- Back up before updates: [upgrade instructions](SELF_HOSTING.md#upgrade).
- A relay connection does not publish webhooks or OAuth callback URLs. If an integration needs a
  public HTTP address, follow [public access setup](SELF_HOSTING.md#exposing-your-openbots-server-to-the-internet).
- If the phone reports offline, check the relay URL, outbound connectivity and `openbots relay`
  output. The VM must remain awake and the stack running.

The shared relay carries end-to-end encrypted traffic, not readable chat contents. It can see
connection metadata and has no availability guarantee; see [Terms](TERMS.md). To operate that
connection infrastructure yourself, use the optional [private relay guide](PRIVATE_RELAY_SETUP.md).
