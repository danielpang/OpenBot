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
# and the fixed settings below replace whatever those say.

OPENBOTS_DATA=/data
OPENBOTS_ENV_FILE="$OPENBOTS_DATA/.env"
# Who runs what (docker/standalone.Dockerfile makes these users). The bot user
# is uid 1000, as in the computer image, so the server has a uid of its own.
# shellcheck disable=SC2034 # read by the scripts that source this
OPENBOTS_SERVER_USER=openbots
# shellcheck disable=SC2034
OPENBOTS_LIB=/usr/local/lib/openbots

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
  openbots_read_env_file "$OPENBOTS_ENV_FILE"

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
  unset DOCKER_HOST DATABASE_URL_FILE REDIS_URL_FILE
  return 0
}
