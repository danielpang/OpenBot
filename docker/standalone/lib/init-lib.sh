# shellcheck shell=bash
# The checks and setting writers of standalone-init (init.sh), apart from it
# so docker/standalone/test/init-lib.test.sh can run them on a scratch
# directory, as any user, without the image. Each takes its paths as
# arguments. Needs log and die from the caller.

# The settings a database already depends on: a new value next to an
# existing cluster would leave every stored secret unreadable (the master
# key) or the server unable to sign in (the passwords).
# shellcheck disable=SC2034 # read by init.sh and the test
STANDALONE_KEPT_SETTINGS="OPENBOTS_MASTER_KEY POSTGRES_PASSWORD OPENBOTS_DB_APP_PASSWORD OPENBOTS_REDIS_PASSWORD"

# Whether NAME has a value: in the env file, in the environment, or as
# NAME_FILE in the environment.
setting_provided() {
  local name="$1" env_file="$2" file_var="${1}_FILE"
  grep -Eq "^${name}=.+" "$env_file" 2>/dev/null && return 0
  [ -n "${!name:-}" ] && return 0
  [ -n "${!file_var:-}" ] && return 0
  return 1
}

# Writes NAME=VALUE into the env file, in place of an empty NAME= or at the end.
set_in_env_file() {
  local name="$1" value="$2" env_file="$3"
  awk -v name="$name" -v value="$value" '
    index($0, name "=") == 1 && !found { print name "=" value; found = 1; next }
    { print }
    END { if (!found) print name "=" value }
  ' "$env_file" >"$env_file.tmp"
  chmod 600 "$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
}

# Adds NAME to the env file unless it is provided already. `generate` is the
# command that makes a value.
ensure_setting() {
  local env_file="$1" name="$2"
  shift 2
  if grep -Eq "^${name}=.+" "$env_file"; then
    return 0
  fi
  local file_var="${name}_FILE"
  if [ -n "${!name:-}" ] || [ -n "${!file_var:-}" ]; then
    log "Taking $name from the container's environment"
    return 0
  fi
  log "Writing $name to $env_file"
  set_in_env_file "$name" "$("$@")" "$env_file"
}

# What PGDATA holds: `none` (missing or empty), `cluster` (a complete one,
# with PG_VERSION) or `partial` (files but no PG_VERSION: an initdb that was
# cut short in an older image, or something else entirely).
pgdata_state() {
  local pgdata="$1"
  if [ -s "$pgdata/PG_VERSION" ]; then
    echo cluster
  elif [ -d "$pgdata" ] && [ -n "$(ls -A "$pgdata" 2>/dev/null)" ]; then
    echo partial
  else
    echo none
  fi
}

# Refuses a PGDATA that cannot be started: a partial one, or a cluster of
# another PostgreSQL major version than the image's.
check_pgdata() {
  local pgdata="$1" major="$2" state version
  state="$(pgdata_state "$pgdata")"
  case "$state" in
    partial)
      die "$pgdata has files but no PG_VERSION, so it is not a complete database cluster (a first boot cut short during initdb, or files put there by hand). Nothing was changed. If this volume never held data, remove $pgdata and start again; otherwise restore it from a backup (docker/standalone/README.md, Backup and restore)."
      ;;
    cluster)
      version="$(tr -d '[:space:]' <"$pgdata/PG_VERSION")"
      if [ "$version" != "$major" ]; then
        die "the database in $pgdata is PostgreSQL $version, and this image runs PostgreSQL $major. PostgreSQL opens only its own major version's files, so nothing was started or changed. Run the previous image again, or move the data across: back it up with the old image (openbots backup), start this image on a new volume and restore it there (openbots restore), or run pg_upgrade from $version to $major by hand. docker/standalone/README.md, Upgrade, has the steps."
      fi
      ;;
  esac
  return 0
}

# With a database in place, refuses to start while a setting it depends on
# is missing, rather than generating a new one.
require_kept_settings() {
  local pgdata="$1" env_file="$2" name missing=""
  [ "$(pgdata_state "$pgdata")" = cluster ] || return 0
  for name in $STANDALONE_KEPT_SETTINGS; do
    setting_provided "$name" "$env_file" || missing="$missing $name"
  done
  [ -z "$missing" ] && return 0
  die "a database already exists in $pgdata, but these settings are missing:$missing. A new one would be generated, and with a new OPENBOTS_MASTER_KEY every stored secret becomes unreadable. Nothing was changed. Put the values back in $env_file (from your copy of it) or in the container's environment (docker run -e, fly secrets set), then start again. If they are lost for good, start on a new volume and restore a backup there, which still needs the old OPENBOTS_MASTER_KEY to open its secrets."
}

# Logs each fixed setting the environment or the env file tries to set. The
# image ignores those values, and saying so beats silently ignoring them.
warn_fixed_settings() {
  local env_file="$1" fixed="$2" name file_var
  for name in $fixed; do
    file_var="${name}_FILE"
    if [ -n "${!name+x}" ] || [ -n "${!file_var+x}" ]; then
      # OPENBOTS_STANDALONE=1 is the image's own ENV.
      [ "$name" = OPENBOTS_STANDALONE ] && [ "${!name:-}" = 1 ] && [ -z "${!file_var+x}" ] && continue
      log "Ignoring $name from the container's environment: the image fixes it (docker/standalone/README.md, Settings). Remove it, for example with fly secrets unset $name."
    fi
    if grep -Eq "^(${name}|${file_var})=" "$env_file" 2>/dev/null; then
      log "Ignoring $name in $env_file: the image fixes it (docker/standalone/README.md, Settings). Remove the line."
    fi
  done
}

# Free space on the filesystem holding PATH: "<total KiB> <available KiB>".
disk_space_kib() {
  df -Pk "$1" | awk 'NR == 2 { print $2, $4 }'
}
