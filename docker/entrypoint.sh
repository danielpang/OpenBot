#!/bin/sh
# Entrypoint of the server image.
#
#   start (default)  apply migrations, then run the server as OPENBOTS_ROLE (api | worker | all)
#   migrate          apply migrations and exit
#   keygen           print a fresh OPENBOTS_MASTER_KEY
#   rotate-key       re-encrypt every stored secret under OPENBOTS_MASTER_KEY (plan 4.9)
#   pair             print a QR code for pairing a phone (--name, --direct <url>, --link)
#   devices          list paired devices, or `devices revoke <id>`
#   relay            this server's relay host id and whether the relay sees it linked
#   docker-guard     run the docker guard in front of the socket proxy (compose service docker-guard)
#   anything else    run it as a command, e.g. `sh`
#
# Started as root (the compose service: `user: 0:0`, every capability dropped
# but SETUID and SETGID), it first becomes uid 1000 and keeps just those two
# capabilities, as ambient ones, so the server can start stdio MCP servers as
# `nobody` and make itself non-dumpable (S-1, packages/mcp/src/privileges.ts).
# Started as uid 1000 (the image's USER, as with a plain `docker run`), it
# runs as that user with whatever capabilities it has, usually none.
#
# The standalone image (docker/standalone.Dockerfile) starts it as root too,
# with OPENBOTS_STANDALONE=1 and OPENBOTS_SERVER_UID and OPENBOTS_SERVER_GID
# naming its own server user, since uid 1000 there is the Bots' `bot` user.
# Its stdio MCP servers run in the computer (OPENBOTS_STDIO_RUNNER=computer),
# so the server keeps no capability at all.
#
# Before the server starts, the secrets below move from the environment into
# private files under OPENBOTS_SECRETS_DIR (a tmpfs in compose) and reach node as
# NAME_FILE, so node's /proc/<pid>/environ, and anything it starts with an
# inherited environment, holds none of them. Without a writable directory
# they stay in the environment and the server logs a warning.
set -eu

SERVER_UID="${OPENBOTS_SERVER_UID:-1000}"
SERVER_GID="${OPENBOTS_SERVER_GID:-$SERVER_UID}"
SECRETS_DIR="${OPENBOTS_SECRETS_DIR:-/run/openbots}"
# The variables apps/server/src/env-files.ts reads from NAME_FILE
# (env-files.test.ts checks that the two lists match).
SECRET_VARS="OPENBOTS_MASTER_KEY OPENBOTS_MASTER_KEY_PREVIOUS DATABASE_URL OPENBOTS_DB_APP_PASSWORD REDIS_URL OPENBOTS_COMPUTER_AGENT_TOKEN OPENBOTS_METRICS_TOKEN OPENBOTS_LOCAL_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GITHUB_CLIENT_SECRET GOOGLE_CLIENT_SECRET"

if [ "$(id -u)" = 0 ] && [ "${OPENBOTS_STANDALONE:-}" = 1 ]; then
  # Leaving uid 0 clears every capability, and no_new_privs keeps a setuid
  # binary from giving one back.
  exec setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups \
    --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$0" "$@"
fi
if [ "$(id -u)" = 0 ]; then
  # Ambient capabilities survive the uid change and the exec of node, and
  # nothing else does: setpriv clears the rest of the permitted set when it
  # leaves uid 0. no_new_privs keeps any setuid binary from giving more back.
  exec setpriv --reuid="$SERVER_UID" --regid="$SERVER_GID" --clear-groups \
    --inh-caps=-all,+setuid,+setgid --ambient-caps=-all,+setuid,+setgid --no-new-privs \
    -- "$0" "$@"
fi

# Writes each secret set in the environment to SECRETS_DIR/NAME (mode 0600)
# and exports NAME_FILE in its place. A secret already given as NAME_FILE is
# left alone, and so is one set both ways (the server reports that).
secrets_to_files() {
  [ -d "$SECRETS_DIR" ] && [ -w "$SECRETS_DIR" ] || return 0
  [ -n "$(find "$SECRETS_DIR" -maxdepth 0 -user "$(id -u)")" ] || return 0
  chmod 0700 "$SECRETS_DIR"
  old_umask="$(umask)"
  umask 077
  for name in $SECRET_VARS; do
    eval "value=\${$name:-}"
    eval "file=\${${name}_FILE:-}"
    if [ -z "$value" ] || [ -n "$file" ]; then continue; fi
    printf '%s' "$value" >"$SECRETS_DIR/$name"
    unset "$name"
    export "${name}_FILE=$SECRETS_DIR/$name"
  done
  umask "$old_umask"
  value=''
}

# OPENBOTS_SERVER_DIR is for tests that run this script outside the image.
# OPENBOTS_MAIN is the server to start: the self-hosted one by default, the
# managed one (ee/server) in the managed image.
cd "${OPENBOTS_SERVER_DIR:-/app/apps/server}"
MAIN="${OPENBOTS_MAIN:-dist/main.js}"

command="${1:-start}"
[ "$#" -gt 0 ] && shift

case "$command" in
  start)
    secrets_to_files
    node dist/db/migrate-cli.js
    exec node "$MAIN" "$@"
    ;;
  migrate)
    secrets_to_files
    exec node dist/db/migrate-cli.js
    ;;
  keygen)
    exec node dist/keygen.js
    ;;
  rotate-key)
    secrets_to_files
    exec node dist/rotate-key.js "$@"
    ;;
  pair | devices | relay)
    secrets_to_files
    exec node dist/cli/main.js "$command" "$@"
    ;;
  docker-guard)
    exec node /app/packages/computer/dist/docker-guard-main.js
    ;;
  *)
    exec "$command" "$@"
    ;;
esac
