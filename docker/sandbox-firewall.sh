#!/bin/sh
# Isolation and egress rules for the sandbox network (threat model S-17):
# openbots-sbx, or the one OPENBOTS_SANDBOX_NETWORK names. The `sandbox-firewall` compose service runs this in the host's network
# namespace (on Docker Desktop, the Docker VM's) and keeps the rules in place;
# a person without that service can run it once as root on the Docker host:
#
#   sudo OPENBOTS_SANDBOX_SERVER_IP=172.30.255.2 sh docker/sandbox-firewall.sh --once
#
# The sandbox network has icc off, so containers on it cannot reach each other.
# These rules, in Docker's DOCKER-USER chain and in INPUT:
#   - let the server open connections to each computer's control agent (the
#     agent channel), and let the replies back;
#   - drop everything else between containers on the bridge, so a computer
#     reaches neither another computer nor the server (or its /metrics);
#   - drop a computer's traffic to link-local addresses (cloud metadata), the
#     private ranges (RFC 1918, the LAN, the other compose networks),
#     carrier-grade NAT (100.64/10, e.g. Tailscale) and loopback;
#   - drop a computer's connections to the Docker host itself.
# DNS (port 53) stays open so a resolver on the LAN keeps working. The rest of
# the internet stays reachable: the browser needs it.
#
# With OPENBOTS_SANDBOX_EGRESS_PROXY set (the computers' HTTP_PROXY, e.g.
# http://172.30.255.3:8888), computers may also open connections to that one
# address and port, even on a private address, on the sandbox network or on
# the host. With OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY=true they reach nothing else
# but DNS, so the proxy's allowlist cannot be bypassed. The proxy needs an IPv4
# address here, not a name: the rules match addresses.
#
# Two stacks on one Docker host (a source checkout's and the Mac app's) each
# run this for their own bridge and subnet. The chains are named after the
# bridge, and every rule and jump matches it, so neither stack's firewall
# touches the other's rules.
set -eu

SUBNET="${OPENBOTS_SANDBOX_SUBNET:-172.30.255.0/24}"
SERVER="${OPENBOTS_SANDBOX_SERVER_IP:-172.30.255.2}"
# The bridge's name, as docker/docker-compose.yml (com.docker.network.bridge.name)
# and the docker provider (resolveSandboxNetwork, AGENT_PORT in
# packages/computer/src/docker.ts) set it: OPENBOTS_SANDBOX_BRIDGE, else the
# network's name.
BRIDGE="${OPENBOTS_SANDBOX_BRIDGE:-${OPENBOTS_SANDBOX_NETWORK:-openbots-sbx}}"
AGENT_PORT=7070
BLOCKED="169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4"
PROXY="${OPENBOTS_SANDBOX_EGRESS_PROXY:-}"
PROXY_ONLY="${OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY:-false}"
PROXY_IP=
PROXY_PORT=

fail() {
  echo "sandbox-firewall: $*" >&2
  exit 1
}

# Sets PROXY_IP and PROXY_PORT from a proxy URL: scheme://[user:pass@]host:port[/].
# PROXY_IP stays empty for a host name.
parse_proxy() {
  rest=${PROXY#*://}
  [ "$rest" != "$PROXY" ] || return 1
  rest=${rest%%/*}
  rest=${rest##*@}
  host=${rest%:*}
  PROXY_PORT=${rest##*:}
  [ "$host" != "$rest" ] && [ -n "$host" ] || return 1
  case $PROXY_PORT in '' | *[!0-9]*) return 1 ;; esac
  [ "$PROXY_PORT" -ge 1 ] && [ "$PROXY_PORT" -le 65535 ] || return 1
  if echo "$host" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    PROXY_IP=$host
  fi
}

# Lower case, at most 15 characters, no `+` (an iptables wildcard): the rule
# isBridgeName has in packages/computer/src/docker.ts.
echo "$BRIDGE" | grep -Eq '^[a-z0-9][a-z0-9_.-]{0,14}$' ||
  fail "OPENBOTS_SANDBOX_BRIDGE must be a bridge name: lower case letters, digits, _ . -, up to 15 characters (set it when OPENBOTS_SANDBOX_NETWORK is longer)"
# The chains, one pair per bridge. The default bridge keeps the names the
# rules always had; any other gets its own, prefixed so that no bridge name
# can turn into one of Docker's chains.
if [ "$BRIDGE" = openbots-sbx ]; then
  FORWARD_CHAIN=OPENBOTS-SANDBOX
else
  FORWARD_CHAIN="OB-$(echo "$BRIDGE" | tr '[:lower:]' '[:upper:]')"
fi
INPUT_CHAIN="$FORWARD_CHAIN-IN"

case $PROXY_ONLY in
  true | false) ;;
  *) fail "OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY must be true or false" ;;
esac
if [ -n "$PROXY" ]; then
  parse_proxy || fail "OPENBOTS_SANDBOX_EGRESS_PROXY must look like http://172.30.255.3:8888, with the port"
  if [ -z "$PROXY_IP" ]; then
    [ "$PROXY_ONLY" = false ] || fail "OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY needs the proxy's IPv4 address in OPENBOTS_SANDBOX_EGRESS_PROXY, not a name"
    echo "sandbox-firewall: the egress proxy is a name, so no exception is added for it; a proxy on a private address needs its IPv4 address in OPENBOTS_SANDBOX_EGRESS_PROXY" >&2
  fi
elif [ "$PROXY_ONLY" = true ]; then
  fail "OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY needs OPENBOTS_SANDBOX_EGRESS_PROXY"
fi

# Docker's rules live in either the nft or the legacy iptables backend; use the
# one whose FORWARD chain jumps to DOCKER-USER.
pick_iptables() {
  for ipt in iptables-nft iptables-legacy iptables; do
    if command -v "$ipt" >/dev/null 2>&1 && "$ipt" -w -S FORWARD 2>/dev/null | grep -q -- '-j DOCKER-USER'; then
      echo "$ipt"
      return 0
    fi
  done
  return 1
}

applied() {
  "$IPT" -w -C DOCKER-USER -i "$BRIDGE" -j "$FORWARD_CHAIN" 2>/dev/null &&
    "$IPT" -w -C "$FORWARD_CHAIN" -o "$BRIDGE" -j DROP 2>/dev/null &&
    "$IPT" -w -C INPUT -i "$BRIDGE" -j "$INPUT_CHAIN" 2>/dev/null &&
    "$IPT" -w -C "$INPUT_CHAIN" -j DROP 2>/dev/null
}

apply() {
  # Traffic arriving from the sandbox bridge and routed on.
  "$IPT" -w -N "$FORWARD_CHAIN" 2>/dev/null || "$IPT" -w -F "$FORWARD_CHAIN"
  "$IPT" -w -A "$FORWARD_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$IPT" -w -A "$FORWARD_CHAIN" -s "$SERVER" -o "$BRIDGE" -d "$SUBNET" -p tcp --dport "$AGENT_PORT" -j ACCEPT
  "$IPT" -w -A "$FORWARD_CHAIN" -s "$SERVER" -j RETURN
  # The egress proxy, wherever it is. ACCEPT, not RETURN: Docker's own rules
  # would drop it on the sandbox bridge (icc off) or on another network.
  if [ -n "$PROXY_IP" ]; then
    "$IPT" -w -A "$FORWARD_CHAIN" -d "$PROXY_IP" -p tcp --dport "$PROXY_PORT" -j ACCEPT
  fi
  "$IPT" -w -A "$FORWARD_CHAIN" -o "$BRIDGE" -j DROP
  "$IPT" -w -A "$FORWARD_CHAIN" -p udp --dport 53 -j RETURN
  "$IPT" -w -A "$FORWARD_CHAIN" -p tcp --dport 53 -j RETURN
  # Nothing else out but the proxy's own traffic, when it is on the sandbox network.
  if [ "$PROXY_ONLY" = true ]; then
    "$IPT" -w -A "$FORWARD_CHAIN" ! -s "$PROXY_IP" -j DROP
  fi
  for net in $BLOCKED; do
    "$IPT" -w -A "$FORWARD_CHAIN" -d "$net" -j DROP
  done
  "$IPT" -w -C DOCKER-USER -i "$BRIDGE" -j "$FORWARD_CHAIN" 2>/dev/null ||
    "$IPT" -w -I DOCKER-USER -i "$BRIDGE" -j "$FORWARD_CHAIN"

  # Traffic from the sandbox bridge to the host itself.
  "$IPT" -w -N "$INPUT_CHAIN" 2>/dev/null || "$IPT" -w -F "$INPUT_CHAIN"
  "$IPT" -w -A "$INPUT_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$IPT" -w -A "$INPUT_CHAIN" -s "$SERVER" -j RETURN
  # An egress proxy running on the Docker host itself.
  if [ -n "$PROXY_IP" ]; then
    "$IPT" -w -A "$INPUT_CHAIN" -d "$PROXY_IP" -p tcp --dport "$PROXY_PORT" -j RETURN
  fi
  "$IPT" -w -A "$INPUT_CHAIN" -p udp --dport 53 -j RETURN
  "$IPT" -w -A "$INPUT_CHAIN" -p tcp --dport 53 -j RETURN
  "$IPT" -w -A "$INPUT_CHAIN" -j DROP
  "$IPT" -w -C INPUT -i "$BRIDGE" -j "$INPUT_CHAIN" 2>/dev/null ||
    "$IPT" -w -I INPUT -i "$BRIDGE" -j "$INPUT_CHAIN"
}

if ! IPT=$(pick_iptables); then
  echo "sandbox-firewall: no DOCKER-USER chain found; is this the Docker host, and does Docker manage iptables?" >&2
  exit 1
fi
apply
note=
[ -z "$PROXY_IP" ] || note=", egress proxy $PROXY_IP:$PROXY_PORT"
[ "$PROXY_ONLY" = false ] || note="$note only"
echo "sandbox-firewall: rules applied with $IPT (bridge $BRIDGE, chains $FORWARD_CHAIN and $INPUT_CHAIN, server $SERVER, subnet $SUBNET$note)"
[ "${1:-}" = "--once" ] && exit 0

# Keep them: a firewall reload or a Docker restart can drop them.
touch /tmp/applied
while sleep 30; do
  if ! applied; then
    apply
    echo "sandbox-firewall: rules re-applied"
  fi
done
