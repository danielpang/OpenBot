#!/usr/bin/env bash
# Bootstraps the OpenBots toolchain: Node 22, pnpm (via corepack) and the
# workspace dependencies. Safe to run repeatedly.
#
#   bash scripts/dev-setup.sh              # Node, pnpm, pnpm install
#   bash scripts/dev-setup.sh --services   # also Postgres 16 + pgvector and Redis
#
# Environment overrides:
#   OPENBOTS_TOOLCHAIN_DIR  where Node, corepack and the pnpm store go (default:
#                          /workspace/.openbots-toolchain if it has room, else
#                          ~/.local/openbots-toolchain; an existing install is reused)
#   OPENBOTS_MIN_FREE_MB    free space a first install needs on the toolchain volume (default 768)
set -euo pipefail

NODE_MAJOR=22
MIN_FREE_MB="${OPENBOTS_MIN_FREE_MB:-768}"
SERVICES_MIN_FREE_MB=500
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WITH_SERVICES=0
for arg in "$@"; do
  case "$arg" in
    --services) WITH_SERVICES=1 ;;
    -h | --help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "dev-setup: unknown argument '$arg' (try --help)" >&2
      exit 2
      ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mdev-setup: %s\033[0m\n' "$*" >&2
  exit 1
}

# Free megabytes on the volume holding $1 (the nearest existing ancestor).
free_mb() {
  local dir="$1"
  while [ ! -e "$dir" ]; do dir="$(dirname "$dir")"; done
  df -Pm "$dir" | awk 'NR == 2 { print $4 }'
}

# --- Choose the toolchain directory -------------------------------------------

choose_toolchain_dir() {
  if [ -n "${OPENBOTS_TOOLCHAIN_DIR:-}" ]; then
    echo "$OPENBOTS_TOOLCHAIN_DIR"
    return
  fi
  local candidates=()
  [ -d /workspace ] && [ -w /workspace ] && candidates+=("/workspace/.openbots-toolchain")
  candidates+=("$HOME/.local/openbots-toolchain")
  local best="" best_free=-1 c f
  # Reuse an earlier install so reruns never move the toolchain.
  for c in "${candidates[@]}"; do
    if [ -x "$c/node/bin/node" ]; then
      echo "$c"
      return
    fi
  done
  # Otherwise the first candidate with enough room (/workspace when it exists),
  # falling back to whichever has the most free space.
  for c in "${candidates[@]}"; do
    if [ "$(free_mb "$c")" -ge "$MIN_FREE_MB" ]; then
      echo "$c"
      return
    fi
  done
  for c in "${candidates[@]}"; do
    f="$(free_mb "$c")"
    if [ "$f" -gt "$best_free" ]; then
      best="$c"
      best_free="$f"
    fi
  done
  echo "$best"
}

TOOLCHAIN_DIR="$(choose_toolchain_dir)"
NODE_DIR="$TOOLCHAIN_DIR/node"
export COREPACK_HOME="$TOOLCHAIN_DIR/corepack"
export PNPM_HOME="$TOOLCHAIN_DIR/pnpm"
# The store must share a volume with the repo, or pnpm copies instead of hardlinking
# and every package lands on disk twice.
if [ "$(stat -c %d "$(dirname "$TOOLCHAIN_DIR")" 2>/dev/null)" = "$(stat -c %d "$REPO_DIR" 2>/dev/null)" ]; then
  PNPM_STORE_DIR="$TOOLCHAIN_DIR/pnpm-store"
else
  PNPM_STORE_DIR="$(dirname "$REPO_DIR")/.openbots-pnpm-store"
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# --- Node ---------------------------------------------------------------------

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

NODE_BIN_DIR=""
if [ -x "$NODE_DIR/bin/node" ] && [ "$(node_major "$NODE_DIR/bin/node")" -ge "$NODE_MAJOR" ]; then
  NODE_BIN_DIR="$NODE_DIR/bin"
  log "Using Node $("$NODE_BIN_DIR/node" --version) from $NODE_DIR"
elif command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge "$NODE_MAJOR" ]; then
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
  log "Using Node $(node --version) from PATH ($NODE_BIN_DIR)"
fi

free="$(free_mb "$TOOLCHAIN_DIR")"
log "Toolchain directory: $TOOLCHAIN_DIR (${free} MB free)"
# Only a first install needs the headroom; reruns over an installed tree add little.
FIRST_INSTALL=0
[ -n "$NODE_BIN_DIR" ] && [ -d "$REPO_DIR/node_modules/.pnpm" ] || FIRST_INSTALL=1
if [ "$FIRST_INSTALL" = 1 ] && [ "$free" -lt "$MIN_FREE_MB" ]; then
  die "only ${free} MB free on the volume holding $TOOLCHAIN_DIR; need ${MIN_FREE_MB} MB.
Free some space, or point OPENBOTS_TOOLCHAIN_DIR at a bigger volume."
fi
if [ "$FIRST_INSTALL" = 1 ] && [ "$PNPM_STORE_DIR" != "$TOOLCHAIN_DIR/pnpm-store" ]; then
  store_free="$(free_mb "$PNPM_STORE_DIR")"
  [ "$store_free" -ge "$MIN_FREE_MB" ] ||
    die "only ${store_free} MB free on the volume holding $PNPM_STORE_DIR; need ${MIN_FREE_MB} MB."
fi

if [ -z "$NODE_BIN_DIR" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS $(uname -s)" ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tarball="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v n="-${os}-${arch}.tar.xz" '$2 ~ n"$" { print $2 }')"
  [ -n "$tarball" ] || die "could not find a Node ${NODE_MAJOR} tarball for ${os}-${arch}"
  log "Installing ${tarball%.tar.xz} into $NODE_DIR"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/openbots-node.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
  expected="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v t="$tarball" '$2 == t { print $1 }')"
  actual="$( (sha256sum "$tmp/$tarball" 2>/dev/null || shasum -a 256 "$tmp/$tarball") | awk '{ print $1 }')"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $tarball"
  mkdir -p "$TOOLCHAIN_DIR"
  rm -rf "$NODE_DIR.partial"
  mkdir -p "$NODE_DIR.partial"
  tar -xJf "$tmp/$tarball" -C "$NODE_DIR.partial" --strip-components=1 \
    --exclude='*/include' --exclude='*/share/doc' --exclude='*/share/man'
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.partial" "$NODE_DIR"
  rm -rf "$tmp"
  trap - EXIT
  NODE_BIN_DIR="$NODE_DIR/bin"
fi
export PATH="$PNPM_HOME:$NODE_BIN_DIR:$PATH"

# --- pnpm ---------------------------------------------------------------------

mkdir -p "$PNPM_HOME" "$COREPACK_HOME"
# Shims go into PNPM_HOME so an existing system Node's directory is never written to.
corepack enable --install-directory "$PNPM_HOME" pnpm
log "pnpm $(cd "$REPO_DIR" && pnpm --version) (pinned by packageManager in package.json)"
(cd "$REPO_DIR" && pnpm config set store-dir "$PNPM_STORE_DIR" --location global >/dev/null)

# --- Workspace dependencies ---------------------------------------------------

log "Installing workspace dependencies (store: $PNPM_STORE_DIR)"
(cd "$REPO_DIR" && pnpm install --prefer-offline --store-dir "$PNPM_STORE_DIR")

# --- Optional services --------------------------------------------------------

# Keep the service URLs from an earlier --services run.
SERVICE_EXPORTS="$(grep -E "^export (DATABASE_URL|REDIS_URL)=" "$TOOLCHAIN_DIR/env.sh" 2>/dev/null || true)"
if [ "$WITH_SERVICES" = 1 ]; then
  command -v apt-get >/dev/null 2>&1 || die "--services needs apt-get (Ubuntu 24.04)"
  SUDO=""
  [ "$(id -u)" -eq 0 ] || SUDO="sudo"
  psql_admin() {
    if [ -z "$SUDO" ]; then
      (cd / && runuser -u postgres -- psql "$@")
    else
      (cd / && sudo -u postgres psql "$@")
    fi
  }

  packages=(postgresql-16 postgresql-16-pgvector redis-server)
  if dpkg -s "${packages[@]}" >/dev/null 2>&1; then
    log "Using installed ${packages[*]}"
  else
    root_free="$(free_mb /)"
    [ "$root_free" -ge "$SERVICES_MIN_FREE_MB" ] ||
      die "--services needs ${SERVICES_MIN_FREE_MB} MB free on / (have ${root_free} MB)"
    log "Installing ${packages[*]}"
    $SUDO apt-get update -qq
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${packages[@]}"
    $SUDO apt-get clean
  fi

  log "Starting Postgres and Redis"
  if ! $SUDO pg_ctlcluster 16 main status >/dev/null 2>&1; then
    $SUDO pg_ctlcluster 16 main start
  fi
  if ! redis-cli ping >/dev/null 2>&1; then
    $SUDO redis-server --daemonize yes --save '' --appendonly no
  fi

  psql_admin -qtAc "SELECT 1 FROM pg_roles WHERE rolname = 'openbots'" | grep -q 1 ||
    psql_admin -qc "CREATE ROLE openbots LOGIN SUPERUSER PASSWORD 'openbots'"
  psql_admin -qtAc "SELECT 1 FROM pg_database WHERE datname = 'openbots'" | grep -q 1 ||
    psql_admin -qc "CREATE DATABASE openbots OWNER openbots"
  psql_admin -q -d openbots -c "CREATE EXTENSION IF NOT EXISTS vector"

  SERVICE_EXPORTS="export DATABASE_URL=postgres://openbots:openbots@127.0.0.1:5432/openbots
export REDIS_URL=redis://127.0.0.1:6379"
fi

# --- Exports ------------------------------------------------------------------

ENV_FILE="$TOOLCHAIN_DIR/env.sh"
cat >"$ENV_FILE" <<ENV
export PATH="$PNPM_HOME:$NODE_BIN_DIR:\$PATH"
export PNPM_HOME="$PNPM_HOME"
export COREPACK_HOME="$COREPACK_HOME"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
${SERVICE_EXPORTS}
ENV

log "Done. Add these to your shell (or run: source $ENV_FILE):"
echo
cat "$ENV_FILE"
