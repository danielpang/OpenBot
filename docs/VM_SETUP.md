# Run OpenBots on a VM with the shared relay

An always-on Linux VM or home server keeps Bots and Routines working while your Mac sleeps. This
guide uses the Docker Compose stack and the shared OpenBots relay. You need no public OpenBots HTTP
port, domain or TLS certificate, only outbound internet access for images, models, tools and the
relay.

Phone pairing requires a compatible mobile build (the iOS and Android apps are on their way). Until
then, use the web UI or Mac app through the SSH tunnel in step 3.

## 1. Prepare the machine

- Linux with Docker Engine and Compose v2.24 or later, plus `git`, `curl` and `openssl`.
- Docker's iptables firewall backend. Rootless Docker and the nftables backend need equivalent
  sandbox rules applied separately; see the [self-hosting reference](SELF_HOSTING.md#install).
- SSH allowed only from your address, or your provider's private management access. Do not open
  port 3000 or the database/Redis ports to the internet.
- Always on, with room for browser workloads and persistent disk storage. Resource needs grow with
  the number of active computers.

Provider-specific provisioning: [EC2](../deploy/ec2/README.md). Single-container platforms:
[deployment options](../deploy/README.md) and the [standalone isolation trade-offs](ARCHITECTURE.md#standalone-an-alternative-not-an-extra-service).

## 2. Install and configure before starting

Run on the VM:

```sh
git clone https://github.com/danielpang/OpenBots.git
cd OpenBots
bash install.sh --no-start
```

The script creates `.env` with a generated encryption key and database passwords. Set these values
in `.env`, replacing existing entries rather than adding duplicates:

```dotenv
OPENBOTS_RELAY_URL=wss://openbots-relay.fly.dev
OPENBOTS_HTTP_BIND=127.0.0.1:
```

- Keep the trailing colon in `OPENBOTS_HTTP_BIND`. It limits HTTP access to the VM itself; phones
  connect through the shared relay.
- Keep `.env` private and back it up securely. Without `OPENBOTS_MASTER_KEY` your stored secrets
  cannot be decrypted.
- To pin a release, set `OPENBOTS_VERSION` to a published version before starting. Otherwise the
  default image tag applies.

## 3. Start and finish setup

```sh
bash install.sh --pair
```

This starts the stack, waits for readiness and prints a short-lived pairing QR code. Treat the code
as a secret. Scan it with the mobile app. On a fresh server with no owner, the first phone to pair
becomes the owner; follow its setup to add a model provider and your first Bot.

New code, or stack checks:

```sh
docker compose run --rm openbots pair
docker compose ps
docker compose run --rm openbots relay
docker compose logs --tail=100 openbots
```

Without a mobile build, finish setup through the web UI. On your Mac, open an SSH tunnel (replace
`user@your-vm` with your VM's SSH address):

```sh
ssh -N -L 3000:127.0.0.1:3000 user@your-vm
```

Keep the tunnel open and visit [http://localhost:3000](http://localhost:3000), or add that address
as a self-hosted server in the Mac app. Use another local port if 3000 is in use. Pair your phone
later from Settings > Devices or with the command above.

**Create the owner before exposing any public web address.** On a fresh install the first visitor
to the setup wizard can create the owner account. This guide keeps HTTP on loopback throughout.

## 4. Keep it running

- Back up data and `.env` separately, and copy backups off the machine:
  [backup and restore](SELF_HOSTING.md#backup-and-restore).
- Back up before updates: [upgrade instructions](SELF_HOSTING.md#upgrade).
- The relay does not publish webhooks or OAuth callback URLs. If an integration needs a public HTTP
  address, follow [public access setup](SELF_HOSTING.md#exposing-your-openbots-server-to-the-internet).
- If the phone reports offline, check the relay URL, outbound connectivity and `openbots relay`
  output. The VM must stay awake with the stack running.

The shared relay carries end-to-end encrypted traffic, not readable chat contents. It can see
connection metadata and has no availability guarantee; see [Terms](TERMS.md). To run that
infrastructure yourself, see the optional [private relay guide](PRIVATE_RELAY_SETUP.md).
