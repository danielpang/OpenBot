#!/usr/bin/env bash
# Installs OpenBots with Docker Compose (plan 16.3, D1): clones the repository,
# copies .env.example to .env, generates OPENBOTS_MASTER_KEY and the database
# passwords and starts the stack. Then open the printed URL; the first-run
# wizard creates the admin.
#
#   curl -fsSL https://raw.githubusercontent.com/danielpang/OpenBots/main/install.sh | bash
#   bash install.sh [--dir <path>] [--ref <branch or tag>] [--no-start] [--pair]
#
# --pair prints a QR code for pairing the OpenBots phone app once the stack is
# ready (`openbots pair`), so a server on a VM needs no browser. Without a
# terminal (cloud-init, a pipe) it writes the QR code and the pairing link to
# openbots-pair.txt beside .env, readable only by you, and prints neither.
#
# Run from inside a checkout, or from the compose bundle a GitHub Release
# carries (openbots-compose-<version>.tar.gz), it uses that directory instead
# of cloning and needs no git. It never overwrites an existing .env, master
# key or database password, so running it again is safe. Environment:
# OPENBOTS_GITHUB_OWNER (default danielpang; a new .env pulls that owner's
# images), OPENBOTS_REPO (clone URL, default that owner's OpenBots), OPENBOTS_DIR
# (default ./OpenBots).
set -euo pipefail

GITHUB_OWNER="${OPENBOTS_GITHUB_OWNER:-danielpang}"
REPO_URL="${OPENBOTS_REPO:-https://github.com/$GITHUB_OWNER/OpenBots.git}"
DIR="${OPENBOTS_DIR:-OpenBots}"
REF=""
START=1
PAIR=0

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || die "--dir needs a path"
      DIR="$2"
      shift
      ;;
    --ref)
      [ "$#" -ge 2 ] || die "--ref needs a branch or tag"
      REF="$2"
      shift
      ;;
    --no-start) START=0 ;;
    --pair) PAIR=1 ;;
    -h | --help)
      sed -n '2,21p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option '$1' (try --help)" ;;
  esac
  shift
done

[ "$START" = 1 ] || [ "$PAIR" = 0 ] || die "--pair needs the stack started; drop --no-start"

if [ "$START" = 1 ]; then
  command -v docker >/dev/null 2>&1 || die "Docker is not installed (https://docs.docker.com/get-docker/)"
  docker info >/dev/null 2>&1 || die "Docker is not running"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is not installed"
  # `include` in compose.yaml needs 2.24 or later.
  version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  if [ "${major:-0}" -lt 2 ] || { [ "$major" = 2 ] && [ "${minor:-0}" -lt 24 ]; }; then
    die "Docker Compose $version is too old; OpenBots needs 2.24 or later"
  fi
fi

# A checkout already here (the script was run from one): use it.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || here=""
if [ -n "$here" ] && [ -f "$here/compose.yaml" ] && [ -f "$here/.env.example" ]; then
  DIR="$here"
  log "Using the checkout in $DIR"
elif [ -d "$DIR/.git" ]; then
  log "Using the existing clone in $DIR"
else
  [ ! -e "$DIR" ] || die "$DIR exists and is not an OpenBots clone; pass --dir"
  command -v git >/dev/null 2>&1 || die "git is not installed"
  log "Cloning $REPO_URL into $DIR"
  git clone --depth 1 ${REF:+--branch "$REF"} "$REPO_URL" "$DIR"
fi
cd "$DIR"

if [ -f .env ]; then
  log "Keeping the existing .env"
else
  log "Creating .env from .env.example"
  (umask 077 && cp .env.example .env)
  # The release workflow publishes to ghcr.io/<owner in lower case>/openbots.
  prefix="ghcr.io/$(printf '%s' "$GITHUB_OWNER" | tr '[:upper:]' '[:lower:]')/openbots"
  awk -v prefix="$prefix" '
    /^OPENBOTS_IMAGE_PREFIX=/ { print "OPENBOTS_IMAGE_PREFIX=" prefix; next }
    { print }
  ' .env >.env.tmp
  chmod 600 .env.tmp
  mv .env.tmp .env
fi

generate_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
    echo
  fi
}

if grep -Eq '^OPENBOTS_MASTER_KEY=.+' .env; then
  log "Keeping the existing OPENBOTS_MASTER_KEY"
else
  log "Generating OPENBOTS_MASTER_KEY"
  key="$(generate_key)"
  # awk, not sed: the key may contain / and +.
  awk -v key="$key" '
    /^OPENBOTS_MASTER_KEY=/ { print "OPENBOTS_MASTER_KEY=" key; found = 1; next }
    { print }
    END { if (!found) print "OPENBOTS_MASTER_KEY=" key }
  ' .env >.env.tmp
  chmod 600 .env.tmp
  mv .env.tmp .env
fi

generate_password() {
  # Hex, so it needs no escaping in DATABASE_URL.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
    echo
  fi
}

# The compose Postgres password (threat model S-3). An .env from before it was
# generated already has a database with the password in DATABASE_URL, so that
# one is kept.
if grep -Eq '^POSTGRES_PASSWORD=.+' .env; then
  log "Keeping the existing POSTGRES_PASSWORD"
else
  current="$(sed -n 's#^DATABASE_URL=postgres://openbots:\([^@]*\)@postgres:5432/openbots$#\1#p' .env | tail -n 1)"
  if [ -n "$current" ] && [ "$current" != "change-me" ]; then
    log "Setting POSTGRES_PASSWORD to the password already in DATABASE_URL"
    password="$current"
    if [ "$password" = openbots ]; then
      log "Your database still has the old fixed password; .env.example says how to change it"
    fi
  else
    log "Generating POSTGRES_PASSWORD"
    password="$(generate_password)"
  fi
  awk -v pw="$password" '
    /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" pw; found = 1; next }
    /^DATABASE_URL=postgres:\/\/openbots:change-me@postgres:5432\/openbots$/ {
      print "DATABASE_URL=postgres://openbots:" pw "@postgres:5432/openbots"
      next
    }
    { print }
    END { if (!found) print "POSTGRES_PASSWORD=" pw }
  ' .env >.env.tmp
  chmod 600 .env.tmp
  mv .env.tmp .env
fi

# The password of openbots_app, the database role the server works as under
# row-level security between organizations. An existing one is kept.
if grep -Eq '^OPENBOTS_DB_APP_PASSWORD=.+' .env; then
  log "Keeping the existing OPENBOTS_DB_APP_PASSWORD"
else
  log "Generating OPENBOTS_DB_APP_PASSWORD"
  app_password="$(generate_password)"
  awk -v pw="$app_password" '
    /^OPENBOTS_DB_APP_PASSWORD=/ { print "OPENBOTS_DB_APP_PASSWORD=" pw; found = 1; next }
    { print }
    END { if (!found) print "OPENBOTS_DB_APP_PASSWORD=" pw }
  ' .env >.env.tmp
  chmod 600 .env.tmp
  mv .env.tmp .env
fi

url="$(sed -n 's/^OPENBOTS_PUBLIC_URL=//p' .env | tail -n 1)"
url="${url:-http://localhost:3000}"

if [ "$START" = 0 ]; then
  log "Ready. Start it with: cd $DIR && docker compose up -d"
  exit 0
fi

log "Starting the stack (the first start pulls or builds images and can take a few minutes)"
docker compose up -d

log "Waiting for OpenBots to be ready"
port="$(sed -n 's/^OPENBOTS_HTTP_PORT=//p' .env | tail -n 1)"
ready=0
for _ in $(seq 1 90); do
  command -v curl >/dev/null 2>&1 || break
  if curl -fsS "http://localhost:${port:-3000}/readyz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" = 0 ]; then
  log "OpenBots is not answering yet; check with: cd $DIR && docker compose logs openbots"
fi

cat <<EOF

OpenBots is running. Open $url to finish setup: the wizard creates the admin
account, asks for a model provider key and creates your first Bot.

Your master key is in $DIR/.env (OPENBOTS_MASTER_KEY). Keep a copy somewhere
safe: without it, stored secrets and backups cannot be decrypted.
EOF

[ "$PAIR" = 1 ] || exit 0

# Last, so the QR code is what stays on screen. On a server with no owner yet,
# the phone that pairs becomes the owner instead of the wizard.
if [ "$ready" = 0 ]; then
  log "Not pairing yet: once OpenBots answers, run: cd $DIR && docker compose run --rm openbots pair"
  exit 1
fi
log "Making a pairing code for the OpenBots phone app"
pair_status=0
# stdin is /dev/null and no TTY is asked for: under `curl | bash` the script
# itself arrives on stdin, and the container must not read it.
if [ -t 1 ]; then
  docker compose run --rm -T openbots pair </dev/null || pair_status=$?
else
  # No terminal to scan from: keep the output, with the link, in a file only
  # this user can read. The code in it works once, for 5 minutes.
  pair_file="$PWD/openbots-pair.txt"
  rm -f "$pair_file"
  (umask 077 && : >"$pair_file")
  # Only to the file: without a terminal, standard output is often a log
  # others can read (an instance's console log), and on a server with no
  # owner yet whoever uses this code first becomes the owner.
  docker compose run --rm -T openbots pair --link </dev/null >"$pair_file" || pair_status=$?
  chmod 600 "$pair_file"
  log "The pairing code is in $pair_file (readable by you only). It is not printed here."
fi
if [ "$pair_status" != 0 ]; then
  log "Pairing failed; try again with: cd $DIR && docker compose run --rm openbots pair"
  exit "$pair_status"
fi
log "The code works once and for 5 minutes. For a new one: cd $DIR && docker compose run --rm openbots pair"
