# shellcheck shell=bash
# The standalone image's settings, sourced by its services
# (docker/standalone/s6-rc.d) and by the `openbots` command (bin/openbots), so
# `docker exec <container> openbots pair` sees what the server sees.
#
# A setting comes from the first of:
#   1. the environment of the process that sources this, which for a service
#      run under with-contenv and for `docker exec` is the container's
#   2. /run/s6/container_environment, the container's environment as s6
#      saved it at boot (for a shell that did not inherit it)
#   3. /data/.env, which standalone-init writes on first boot
# A secret given as NAME_FILE in 1 or 2 counts as given there: it is read
# into NAME and NAME_FILE is unset, so the server never sees both. The fixed
# settings below replace whatever those say.

OPENBOTS_DATA=/data
OPENBOTS_ENV_FILE="$OPENBOTS_DATA/.env"
# Who runs what (docker/standalone.Dockerfile makes these users). The bot user
# is uid 1000, as in the computer image, so the server has a uid of its own.
# shellcheck disable=SC2034 # read by the scripts that source this
OPENBOTS_SERVER_USER=openbots
# shellcheck disable=SC2034
OPENBOTS_LIB=/usr/local/lib/openbots
# The PostgreSQL major version the image carries, written at build time from
# the Dockerfile's POSTGRES_MAJOR.
# shellcheck disable=SC2034
OPENBOTS_PG_MAJOR="$(cat "$OPENBOTS_LIB/standalone/postgres-major" 2>/dev/null || echo 16)"
# shellcheck disable=SC2034
OPENBOTS_PGBIN="/usr/lib/postgresql/$OPENBOTS_PG_MAJOR/bin"

# The settings the image fixes: anything the environment or /data/.env says
# for them is ignored (standalone-init logs it).
# shellcheck disable=SC2034
OPENBOTS_FIXED_SETTINGS="DATABASE_URL REDIS_URL DOCKER_HOST OPENBOTS_COMPUTER_AGENT_URL OPENBOTS_STDIO_RUNNER OPENBOTS_FILES_DIR OPENBOTS_MCP_DIR OPENBOTS_ROLE OPENBOTS_STANDALONE PORT"
# The secrets that may come as NAME_FILE: those apps/server/src/env-files.ts
# reads (docker/entrypoint.sh's SECRET_VARS) and the image's own passwords.
OPENBOTS_FILE_SECRETS="OPENBOTS_MASTER_KEY OPENBOTS_MASTER_KEY_PREVIOUS DATABASE_URL OPENBOTS_DB_APP_PASSWORD REDIS_URL OPENBOTS_COMPUTER_AGENT_TOKEN OPENBOTS_METRICS_TOKEN OPENBOTS_LOCAL_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GITHUB_CLIENT_SECRET GOOGLE_CLIENT_SECRET GITHUB_APP_PRIVATE_KEY GITHUB_APP_CLIENT_SECRET GITHUB_APP_WEBHOOK_SECRET POSTGRES_PASSWORD OPENBOTS_REDIS_PASSWORD"

# Sets NAME to VALUE unless NAME is set already, even to the empty string.
openbots_default() {
  if [ -z "${!1+x}" ]; then
    export "$1=$2"
  fi
}

# Reads KEY=VALUE lines from a dotenv file, as Docker Compose's env_file does
# for the values install.sh writes: no expansion, one pair of quotes removed.
openbots_read_env_file() {
  local line name value
  [ -r "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    openbots_default "$name" "$value"
  done <"$1"
}

# Reads each secret's NAME_FILE into NAME when NAME is empty, then unsets
# every NAME_FILE, so the server gets one of the two, never both (it refuses
# to start on both). A NAME already set wins over its NAME_FILE.
openbots_resolve_secret_files() {
  local name file_var file value
  for name in $OPENBOTS_FILE_SECRETS; do
    file_var="${name}_FILE"
    file="${!file_var:-}"
    [ -n "$file" ] || continue
    if [ -z "${!name:-}" ]; then
      value="$(cat "$file" 2>/dev/null)" || {
        echo "openbots: ${name}_FILE names $file, which cannot be read" >&2
        return 1
      }
      export "$name=$value"
    else
      echo "openbots: both $name and ${name}_FILE are set; using $name" >&2
    fi
    unset "${name}_FILE"
  done
  return 0
}

# Every setting the server runs with, exported. Fails when standalone-init has
# not written the passwords yet.
openbots_load_env() {
  local file name
  if [ -d /run/s6/container_environment ]; then
    for file in /run/s6/container_environment/*; do
      [ -f "$file" ] || continue
      name="${file##*/}"
      [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      openbots_default "$name" "$(cat "$file")"
    done
  fi
  # The container's NAME_FILE before /data/.env's NAME: the container wins.
  openbots_resolve_secret_files || return 1
  openbots_read_env_file "$OPENBOTS_ENV_FILE"
  openbots_resolve_secret_files || return 1

  local missing=""
  for name in OPENBOTS_MASTER_KEY POSTGRES_PASSWORD OPENBOTS_REDIS_PASSWORD OPENBOTS_COMPUTER_AGENT_TOKEN; do
    [ -n "${!name:-}" ] || missing="$missing $name"
  done
  if [ -n "$missing" ]; then
    echo "openbots: not set:$missing (standalone-init writes them to $OPENBOTS_ENV_FILE on first boot)" >&2
    return 1
  fi

  # The fixed settings: everything runs in this container.
  export OPENBOTS_STANDALONE=1
  export OPENBOTS_ROLE=all
  export PORT=3000
  export DATABASE_URL="postgres://openbots:${POSTGRES_PASSWORD}@127.0.0.1:5432/openbots"
  export REDIS_URL="redis://:${OPENBOTS_REDIS_PASSWORD}@127.0.0.1:6379"
  export OPENBOTS_COMPUTER_AGENT_URL=http://127.0.0.1:7070
  export OPENBOTS_STDIO_RUNNER=computer
  export OPENBOTS_FILES_DIR="$OPENBOTS_DATA/files"
  export OPENBOTS_MCP_DIR=/opt/openbots/mcp
  unset DOCKER_HOST
  for name in $OPENBOTS_FIXED_SETTINGS; do
    unset "${name}_FILE"
  done
  return 0
}

# The server's environment, from openbots_load_env's: DATABASE_URL and
# REDIS_URL carry the passwords, so the passwords themselves go. The
# entrypoint then moves the URLs and the other secrets into files.
openbots_server_env() {
  openbots_load_env || return 1
  unset POSTGRES_PASSWORD OPENBOTS_REDIS_PASSWORD
}

# Sets this process's oom_score_adj, which what it starts inherits: the
# server, Postgres and Redis go low (-500) and the Bots' computer high (+500),
# so under memory pressure the kernel ends a Bot's program first. Lowering
# needs CAP_SYS_RESOURCE, which Docker does not give by default; without it
# the value stays where it is and the computer's +500 still puts it first.
openbots_oom_score_adj() {
  printf '%s' "$1" 2>/dev/null >/proc/self/oom_score_adj || true
}
