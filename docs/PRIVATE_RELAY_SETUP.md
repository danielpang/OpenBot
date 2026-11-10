# Host your own private relay

Most installs should use the shared relay: the Mac app configures it by default, and the
[VM guide](VM_SETUP.md) enables it on a server. Hosting your own puts the connection infrastructure
and its metadata logs under your control. It does not run Bots or replace the OpenBots server,
database or computer containers.

The relay carries end-to-end encrypted traffic between paired phones and servers. It cannot read
chat contents, API requests or pairing codes. It sees host ids, addresses, connection timing and
byte counts. "Private" means self-operated, not authenticated or invite-only: the public endpoint
still needs network protection and rate limiting.

**Push limitation:** without the app's APNs key, a self-hosted relay carries the tunnel but cannot
send iOS push notifications. The project's App Store key is not distributed. Protocol,
configuration and limits: [relay README](../apps/relay/README.md).

## 1. Prepare a relay host

You need:

- A server with Docker. It can be your OpenBots host or a separate machine.
- A domain such as `relay.example.com`, pointed at that server.
- A TLS reverse proxy that supports WebSocket upgrades. This guide uses Caddy installed on the
  host, with the relay in a separate container.
- Ports 80 and 443 open for HTTPS/TLS. Keep the backend port 3200 private.

Unlike an OpenBots server behind a relay, the **relay must be reachable by phones and servers**.

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
port 3200 to the internet: clients could spoof the address used for rate limits. The single relay
needs no database or volume.

If you already run the OpenBots Compose stack, use its optional profile **instead**:

```sh
docker compose --profile relay up -d
```

The profile also binds port 3200 to loopback by default. Keep passing `--profile relay` to
operations that should include the relay service. Configuration:
[`docker-compose.relay.yml`](../docker/docker-compose.relay.yml).

## 3. Put TLS in front

Install [Caddy](https://caddyserver.com/docs/install) on the host and add this to its Caddyfile,
with your domain:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:3200
}
```

Reload Caddy. It handles the certificate and WebSocket upgrades. Caddy must run **on the host**: a
Caddy container's loopback would not reach the relay container.

Check the backend and the public endpoint:

```sh
curl -fsS http://127.0.0.1:3200/healthz
curl -fsS https://relay.example.com/healthz
```

A Cloudflare Tunnel or another WebSocket-capable TLS proxy can replace Caddy. Keep its backend
private and configure trusted client-address forwarding. For a managed multi-machine relay, use
the [Fly deployment guide](../deploy/relay/README.md) instead.

## 4. Point OpenBots at your relay

**Mac app / This Mac:** open **Relay…** in the OpenBots menu and enter:

```text
wss://relay.example.com
```

After a warning, the app restarts the local stack and revokes paired devices. Pair every phone
again with the new QR code.

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

Existing phones keep the old relay address. Revoke their pairings in Settings > Devices and pair
again. Pairing requires a compatible mobile build (the iOS and Android apps are on their way).

## Operate and update

**Standalone container.** Logs: `docker logs --tail=100 openbots-relay`. To update:

1. Pull the new version.
2. Run `docker stop -t 30 openbots-relay`. Give it time to drain active connections.
3. Remove the stopped container.
4. Repeat the run command with the new tag.

**Compose profile.** Update `OPENBOTS_VERSION`, then run `docker compose --profile relay pull` and
`docker compose --profile relay up -d`. This also updates the stack to that release. Back up
OpenBots first if you are upgrading its server alongside the relay.

The relay stores no chat history. Restrict access to its metadata logs, monitor its health and
keep it patched. See [relay operations](../apps/relay/README.md) and
[security boundaries](SECURITY.md#13-private-relay-and-paired-devices).
