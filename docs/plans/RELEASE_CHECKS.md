# Release checks

Manual checks for maintainers to run on a Docker host before a release.

## Checking the container hardening

The automated tests check the docker guard's rules, the compose files and the metrics token without
Docker. The checks below need Docker (Linux, and Docker Desktop on a Mac). Run them from the
checkout after `docker compose up -d`:

1. `docker compose ps`: `docker-guard` and `sandbox-firewall` are healthy and `openbots` started.
   `docker compose logs sandbox-firewall` names the iptables backend it used.
2. Start a Bot's computer from the web UI; it starts and its screen shows.
   `docker compose logs docker-guard` has no `refused` lines.
3. The guard refuses an unsafe container. This must print `403` and a `docker guard:` message:
   ```sh
   docker compose exec openbots node -e "fetch('http://docker-guard:2375/containers/create?name=openbots-computer-x',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({Image:'alpine',HostConfig:{Privileged:true}})}).then(async r=>console.log(r.status,await r.text()))"
   ```
   The same with `http://docker-socket-proxy:2375/_ping` fails: the server cannot reach the socket
   proxy.
4. The guard acts only on computers: the same command with
   `http://docker-guard:2375/containers/openbots-postgres-1/stop` (method `POST`, no body) prints
   `403` and Postgres keeps running.
5. `docker network inspect openbots-sbx` (or your `OPENBOTS_SANDBOX_NETWORK`) shows
   `com.docker.network.bridge.enable_icc: false`, the subnet from `.env` and `openbots` at
   `OPENBOTS_SANDBOX_SERVER_IP`.
6. From inside a computer (its terminal in the web UI), each of these must fail or time out:
   `curl -m 5 http://<OPENBOTS_SANDBOX_SERVER_IP>:3000/healthz` (the server),
   `curl -m 5 http://169.254.169.254/` (metadata), `curl -m 5 http://<your router's LAN IP>/`,
   `curl -m 5 http://172.30.255.1/` (the host), and, with a second account's computer running,
   `curl -m 5 http://<its address>:7070/healthz`. `curl -m 10 https://example.com` and
   `getent hosts example.com` must work.
7. `curl -i http://localhost:3000/metrics` answers 404 without `OPENBOTS_METRICS_TOKEN`, 401 with it
   set and no token sent, and 200 with `-H "Authorization: Bearer <token>"`.
8. Restart Docker (or reboot): the computer still starts afterwards, and the rules are back
   (`sudo iptables -S OPENBOTS-SANDBOX`, or `iptables-legacy` / `iptables-nft`; `OB-<BRIDGE>` for
   another bridge).
9. With a second stack on its own `OPENBOTS_SANDBOX_NETWORK` and subnet running beside this one,
   both start, each `sandbox-firewall` log names its own bridge and chains, both chain pairs are in
   `iptables -S`, and from a computer of either stack the other stack's server address and
   computers time out like step 6.
10. `docker compose pull` resolves `tecnativa/docker-socket-proxy` by its pinned digest on both
    amd64 and arm64.
11. The catalog's stdio MCP servers are in the image and start without downloading anything
    (S-20):
    - `docker buildx build --platform linux/amd64,linux/arm64 -f docker/server.Dockerfile .`
      succeeds.
    - In the running server,
      `docker compose exec openbots ls -l /opt/openbots/mcp/node_modules/.bin` lists
      `mcp-server-filesystem` and `mcp-server-postgres`, owned by root.
    - Add the Filesystem connector and a Postgres connector (a public, read-only database) on the
      Connectors page and press Test on each: both list their tools, and
      `docker compose exec openbots ps -o user,cmd -e` shows them running from
      `/opt/openbots/mcp`, with no `npx` or `npm` process.
12. Stdio MCP servers run as `nobody` with no capabilities and cannot read the server (S-1). With
    the Filesystem connector added (press Test so it runs), list the processes:
    ```sh
    docker compose exec openbots sh -c 'for d in /proc/[0-9]*; do printf "%s " "${d#/proc/}"; grep -E "^(Name|Uid|CapEff)" "$d/status" | tr -s "\t\n" "  "; echo; done'
    ```
    - `node` shows Uid `1000` and CapEff `00000000000000c0` (SETUID and SETGID only), and the MCP
      server shows Uid `65534` and CapEff `0000000000000000`.
    - As the stdio servers' user, the server's environment is out of reach:
      `docker compose exec --user 65534 openbots cat /proc/<node pid>/environ` fails with
      "Permission denied".
    - `docker compose exec --user 1000 openbots ls -l /run/openbots` lists the secrets, each
      `-rw-------`.
    - Remove the connector: the MCP server's process is gone from the list within a few seconds.
    - Then `docker compose run --rm openbots rotate-key` reports every secret under the current
      key, and `bash scripts/backup.sh` followed by `bash scripts/restore.sh` brings the
      connector's files back with their owners.
13. The egress proxy (plan 9.5). With the `.env` lines from
    [Egress proxy for the computers](../SELF_HOSTING.md#egress-proxy-for-the-computers) and
    `docker compose --profile egress up -d`, start a computer and in its terminal:
    - `env | grep -i proxy` lists the proxy.
    - `curl -m 10 https://en.wikipedia.org` works.
    - `curl -m 10 https://example.com` gets a 403 from tinyproxy.
    - `curl -m 10 --noproxy '*' https://example.com` times out (proxy only).
    - The proxy's log (`docker compose logs egress-proxy`) shows both requests, and the firewall's
      names the proxy.

## Docker verification checklist

Some behaviour cannot run in a sandbox without Docker or an X stack, so the unit tests cover it with
fakes. Check these by hand on a Docker host before a release:

- **The computer's screen lock (S-7).** Build the computer image (`docker/computer.Dockerfile`).
  Inside it, run `pnpm --filter @openbots/computer-agent test` with `DISPLAY` set, so
  `display.test.ts` runs against real Xvfb, x11vnc and Chromium. Then, with a Bot's screen
  running:
  - In the Bot's terminal or through `bash`, `env` shows no `OPENBOTS_AGENT_TOKEN`, and neither
    do `tr '\0' '\n' < /proc/1/environ` nor `docker inspect` on the computer's container.
    `/var/lib/openbots/token` does not exist once the agent is up.
  - `curl http://127.0.0.1:9222/json/version` fails: Chromium has no DevTools port.
  - Nothing listens on `127.0.0.1:5910` or `[::1]:5900`: x11vnc is on
    `/tmp/openbots/screens/screen-0/vnc.sock`, and `ls -l` on it as root shows it is
    `screen-0`'s, mode 0755.
  - **Downloads (K1).** Have Bot A download a file in its browser. It shows up in
    `/home/bot/Downloads` in the file browser, `read_file` returns it, and `ls -l` shows it as
    `screen-0`'s, group `bot`, mode 0664; `ls -ld /home/bot/Downloads` shows `drwxrwsrwt`.
    `/home/bot/.config/openbots/chromium` is gone after the first start on an upgraded computer.
  - **Nothing to take first (S-7).** With Bot B's screen stopped, have Bot A run
    `touch /tmp/.X11-unix/X11 /tmp/.X11-lock` and `python3 -m http.server 5911 &`, then start
    Bot B's screen: it comes up, and the preview shows its desktop.
  - `ps -o uid,gid,cmd -C Xvfb,x11vnc,chrome` shows each screen's processes as uid and gid
    2000+n, and the agent (`ps -o ruid,euid -C node`) as real uid 0, effective uid 1000.
  - **Cross-screen access is refused (S-7).** `display.test.ts` "another screen (S-7)" must pass
    as root with `/usr/local/libexec/openbots/runas` installed, so its "as root" case runs too.
    Then, with two Bots' screens running, have Bot A run, through `bash`:
    `xdotool getmouselocation` works; `DISPLAY=:11 xdotool getmouselocation` (Bot B's display)
    fails with "Can't open display"; `cat /tmp/openbots/screens/screen-1/Xauthority` and
    `ls /var/lib/openbots/screens/screen-1` fail with "Permission denied". The terminal can reach
    no display at all.
  - Each Bot keeps its logins across a computer restart, and a new Bot that gets a deleted Bot's
    screen number starts logged out.
  - The web preview still shows the screen, and the browser tools still drive Chromium.
  - Take the screen over and ask the Bot to run a command. It waits, then answers that the owner
    has the screen.
