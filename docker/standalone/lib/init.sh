#!/bin/bash
# standalone-init, the oneshot every other service waits for. Runs as root
# under with-contenv, so it sees the container's environment.
#
# On first boot it writes /data/.env the way install.sh writes .env (the
# master key, the database and Redis passwords, the computer agent's token,
# OPENBOTS_PUBLIC_URL and OPENBOTS_TIMEZONE) and initialises the database
# cluster. On every boot it adds a setting that is missing, fixes the owner
# and mode of everything under /data, and makes sure the database role, the
# database and the pgvector extension exist, with the role's password from
# the settings. It refuses OPENBOTS_DEPLOYMENT=managed (V6), which stops the
# container.
set -euo pipefail

# shellcheck source=SCRIPTDIR/env.sh
. /usr/local/lib/openbots/standalone/env.sh

PGBIN=/usr/lib/postgresql/16/bin
PGDATA="$OPENBOTS_DATA/pgdata"

log() { printf 'standalone-init: %s\n' "$*"; }
die() {
  printf 'standalone-init: %s\n' "$*" >&2
  exit 1
}

as_postgres() { runuser -u postgres -- "$@"; }

# Hex, so it needs no escaping in DATABASE_URL or REDIS_URL.
hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
# OPENBOTS_MASTER_KEY: 32 random bytes, base64, as `openbots keygen` prints.
master_key() { head -c 32 /dev/urandom | base64 -w 0; }

# Writes NAME=VALUE into /data/.env, in place of an empty NAME= or at the end.
set_in_env_file() {
  awk -v name="$1" -v value="$2" '
    index($0, name "=") == 1 && !found { print name "=" value; found = 1; next }
    { print }
    END { if (!found) print name "=" value }
  ' "$OPENBOTS_ENV_FILE" >"$OPENBOTS_ENV_FILE.tmp"
  chmod 600 "$OPENBOTS_ENV_FILE.tmp"
  mv "$OPENBOTS_ENV_FILE.tmp" "$OPENBOTS_ENV_FILE"
}

# Adds NAME to /data/.env unless the file or the container's environment
# already gives it a value. `generate` is the command that makes one.
ensure_setting() {
  local name="$1"
  shift
  if grep -Eq "^${name}=.+" "$OPENBOTS_ENV_FILE"; then
    return 0
  fi
  if [ -n "${!name:-}" ]; then
    log "Taking $name from the container's environment"
    return 0
  fi
  log "Writing $name to $OPENBOTS_ENV_FILE"
  set_in_env_file "$name" "$("$@")"
}

# Gives everything under DIR to USER:GROUP that is not theirs already, so a
# volume restored from elsewhere, or made by an older image, works.
fix_owner() {
  find "$1" -xdev \( ! -user "$2" -o ! -group "$3" \) -exec chown -h "$2:$3" {} +
}

umask 077

# --- /data and its settings ---------------------------------------------------
# Root's, and closed but for traversal: the bot user reaches /data/home (its
# home) through it and nothing else.
install -d -m 0711 -o root -g root "$OPENBOTS_DATA"
if [ ! -e "$OPENBOTS_ENV_FILE" ]; then
  log "First boot: creating $OPENBOTS_ENV_FILE"
  cat >"$OPENBOTS_ENV_FILE" <<'EOF'
# OpenBots standalone settings, written on first boot (docker/standalone/README.md).
# The container's own environment overrides anything here, so a platform's
# secrets (`fly secrets set NAME=value`) take effect without editing this file.
# Every name in .env.example works here, except those the image fixes:
# DATABASE_URL, REDIS_URL, DOCKER_HOST, OPENBOTS_COMPUTER_AGENT_URL,
# OPENBOTS_STDIO_RUNNER, OPENBOTS_FILES_DIR, OPENBOTS_ROLE and PORT.
#
# Keep a copy of OPENBOTS_MASTER_KEY somewhere safe: without it, stored
# secrets and backups cannot be decrypted.
EOF
fi
chown root:root "$OPENBOTS_ENV_FILE"
chmod 600 "$OPENBOTS_ENV_FILE"

# s6 keeps the container's environment as one file per variable, and that is
# where `fly secrets set` and `docker run -e` put provider keys and the relay
# URL. Only root reads it (env.sh, as each service starts), so no Bot's shell
# or other user in the container can.
if [ -d /run/s6/container_environment ]; then
  chown -R root:root /run/s6/container_environment
  chmod 0700 /run/s6/container_environment
  find /run/s6/container_environment -type f -exec chmod 0600 {} +
fi

ensure_setting OPENBOTS_MASTER_KEY master_key
ensure_setting POSTGRES_PASSWORD hex 24
ensure_setting OPENBOTS_DB_APP_PASSWORD hex 24
ensure_setting OPENBOTS_REDIS_PASSWORD hex 24
ensure_setting OPENBOTS_COMPUTER_AGENT_TOKEN hex 32
ensure_setting OPENBOTS_PUBLIC_URL echo http://localhost:3000
ensure_setting OPENBOTS_TIMEZONE echo "${TZ:-UTC}"

openbots_load_env

if [ "${OPENBOTS_DEPLOYMENT:-self_hosted}" = managed ]; then
  die "OPENBOTS_DEPLOYMENT=managed: the standalone image is a single-person install and runs self_hosted only. Unset OPENBOTS_DEPLOYMENT or set it to self_hosted."
fi
# They go into DATABASE_URL, REDIS_URL and SQL below unescaped.
for name in POSTGRES_PASSWORD OPENBOTS_REDIS_PASSWORD; do
  [[ "${!name}" =~ ^[A-Za-z0-9_-]{16,128}$ ]] ||
    die "$name must be 16 to 128 letters, digits, - or _"
done

# --- Owners and modes -----------------------------------------------------------
install -d -m 0700 -o postgres -g postgres "$PGDATA"
fix_owner "$PGDATA" postgres postgres
install -d -m 0700 -o redis -g redis "$OPENBOTS_DATA/redis"
fix_owner "$OPENBOTS_DATA/redis" redis redis
# The server's uploads and Artifact files; only its stdio servers would write
# as anyone else, and here they run in the computer.
install -d -m 0700 -o "$OPENBOTS_SERVER_USER" -g "$OPENBOTS_SERVER_USER" "$OPENBOTS_DATA/files"
fix_owner "$OPENBOTS_DATA/files" "$OPENBOTS_SERVER_USER" "$OPENBOTS_SERVER_USER"
# The Bots' home (/home/bot links here). Its contents keep their owners: the
# screens' users write some of them.
if [ ! -d "$OPENBOTS_DATA/home" ]; then
  install -d -m 0750 -o bot -g bot "$OPENBOTS_DATA/home"
fi
chown bot:bot "$OPENBOTS_DATA/home"
# The computer agent's state (cookie store, Chromium profiles, its token
# file): root's; the agent lays out the inside itself.
install -d -m 0711 -o root -g root "$OPENBOTS_DATA/agent"
install -d -m 0700 -o root -g root "$OPENBOTS_DATA/backups"

# --- The database -------------------------------------------------------------
install -d -m 0700 -o postgres -g postgres /run/postgresql
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "First boot: initialising the database cluster in $PGDATA"
  # The superuser `postgres` signs in over the socket as the postgres user
  # only; every TCP connection needs a password.
  as_postgres "$PGBIN/initdb" -D "$PGDATA" -U postgres --encoding=UTF8 --locale=C.UTF-8 \
    --auth-local=peer --auth-host=scram-sha-256 >/dev/null
fi
# Rewritten on each boot, so the rules below always hold: the owner and the
# app role from loopback with a password, the superuser over the socket as
# the postgres user. The server's settings also pass on the command line
# (s6-rc.d/postgres/run).
cat >"$PGDATA/pg_hba.conf" <<'EOF'
# Written by standalone-init on each boot; changes here do not last.
local   all        postgres                          peer
host    openbots   openbots,openbots_app 127.0.0.1/32 scram-sha-256
EOF
chown postgres:postgres "$PGDATA/pg_hba.conf"
chmod 600 "$PGDATA/pg_hba.conf"

# A short-lived server on the socket only, to make the role and the database.
log "Checking the database role and database"
as_postgres "$PGBIN/pg_ctl" -D "$PGDATA" -w -t 300 -l /run/postgresql/init.log \
  -o "-c listen_addresses='' -c unix_socket_directories=/run/postgresql" start >/dev/null ||
  {
    cat /run/postgresql/init.log >&2
    die "the database did not start"
  }
stop_postgres() { as_postgres "$PGBIN/pg_ctl" -D "$PGDATA" -w -t 120 -m fast stop >/dev/null; }
trap stop_postgres EXIT
# The owner of the tables, as POSTGRES_USER is in the compose stack's Postgres,
# but not a superuser: CREATEROLE lets its migrations make and grant the
# openbots_app, openbots_auth and openbots_system roles.
as_postgres "$PGBIN/psql" -h /run/postgresql -d postgres -v ON_ERROR_STOP=1 -q <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openbots') THEN
    CREATE ROLE openbots;
  END IF;
END
\$\$;
ALTER ROLE openbots WITH LOGIN CREATEROLE PASSWORD '${POSTGRES_PASSWORD}';
SELECT 'CREATE DATABASE openbots OWNER openbots'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openbots')\gexec
EOF
# The first migration creates it too, which a role that is not a superuser
# may do only once it exists.
as_postgres "$PGBIN/psql" -h /run/postgresql -d openbots -v ON_ERROR_STOP=1 -q \
  -c 'CREATE EXTENSION IF NOT EXISTS vector'
stop_postgres
trap - EXIT
rm -f /run/postgresql/init.log
log "Ready"
