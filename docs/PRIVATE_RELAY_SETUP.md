# Host your own private relay

Most installs should use the shared relay; the Mac app configures it by default, and the
[VM guide](VM_SETUP.md) shows how to enable it on a server. Hosting your own is optional: it moves
the connection infrastructure and its metadata logs under your control. It does not run Bots or
replace the OpenBots server, database or computer containers.

The relay carries end-to-end encrypted traffic between paired phones and servers. It cannot read
chat contents, API requests or pairing codes, but it sees host ids, addresses, connection timing
and byte counts. "Private" means self-operated, not an authenticated or invite-only relay service;
its public endpoint still needs appropriate network protection and rate limiting.

**Push limitation:** a self-hosted relay without the app's APNs key carries the tunnel but cannot
send iOS push notifications. The project's App Store key is not distributed. See the
[relay README](../apps/relay/README.md) for the protocol, configuration and limits.

## 1. Prepare a relay host

You need a server with Docker, a domain such as `relay.example.com`, and a TLS reverse proxy that
supports WebSocket upgrades. Unlike an OpenBots server reached through a relay, the **relay must
be reachable by phones and servers**. Point the domain at this host and allow ports 80 and 443
for the HTTPS/TLS setup below. Keep the backend port 3200 private.

The relay can run on the same host as your OpenBots stack or on a separate machine. Here it runs
as a separate container on the same host as a host-installed Caddy reverse proxy.

## 2. Start the relay

Replace `<release>` with a published OpenBots version:

```sh
docker run -d --name openbots-relay \
  --restart unless-stopped --init --stop-timeout 30 \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 127.0.0.1:3200:3200 \
  -e RELAY_TRUST_PROXY=true \
  ghcr.io/danielpang/openbots/relay:<release>
```

`RELAY_TRUST_PROXY=true` assumes requests come only from the trusted reverse proxy. Do not expose
port 3200 directly to the internet: clients could otherwise spoof the address used for rate limits.
The single relay needs no database or volume.

If you already run the OpenBots Compose stack, use its optional profile **instead of** the command
above:

```sh
docker compose --profile relay up -d
```

The profile also binds port 3200 to loopback by default. Keep using `--profile relay` for operations
that need to include the relay service. Configuration is in
[`docker-compose.relay.yml`](../docker/docker-compose.relay.yml).

## 3. Put TLS in front

Install [Caddy](https://caddyserver.com/docs/install) on the host and add this to its Caddyfile,
replacing the domain with yours:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:3200
}
```

Reload Caddy using your installation's service instructions. Caddy handles the certificate and
WebSocket upgrades. This example assumes Caddy runs **on the host**; a Caddy container's loopback
would not reach the relay container.

Check both the backend and the public endpoint:

```sh
curl -fsS http://127.0.0.1:3200/healthz
curl -fsS https://relay.example.com/healthz
```

A Cloudflare Tunnel or another WebSocket-capable TLS proxy can replace Caddy; keep its backend
private and configure trusted client-address forwarding appropriately. For a managed multi-machine
relay, use the [Fly deployment guide](../deploy/relay/README.md) instead.

## 4. Point OpenBots at your relay

**Mac app / This Mac:** open **Relay…** in the OpenBots menu and enter:

```text
wss://relay.example.com
```

The app restarts the local stack and revokes paired devices. Pair every phone again using the
new QR code; the app warns before applying the change.

**VM or Compose server:** replace the relay entry in its `.env`:

```dotenv
OPENBOTS_RELAY_URL=wss://relay.example.com
```

Then apply it:

```sh
docker compose up -d
# If this same stack also hosts the relay, use instead:
# docker compose --profile relay up -d
docker compose run --rm openbots relay
```

Existing phones retain the old relay address. Revoke their old pairings in Settings > Devices and
pair again, using the new relay address. The iOS and Android apps are on their way; pairing requires
a compatible mobile build.

## Operate and update

For a standalone relay container, inspect logs with `docker logs --tail=100 openbots-relay`. To
update, pull the new version, stop it with `docker stop -t 30 openbots-relay`, remove the stopped
container, then repeat the run command with the new tag. Give it time to drain active connections.

For the Compose profile, update `OPENBOTS_VERSION` and use `docker compose --profile relay pull`
and `docker compose --profile relay up -d`; this updates the stack to that release as well. Back up
OpenBots first if you are upgrading its server alongside the relay.

The relay stores no chat history. Restrict access to its metadata logs, monitor its health and
keep it patched. More details: [relay operations](../apps/relay/README.md) and
[security boundaries](SECURITY.md#13-private-relay-and-paired-devices).
