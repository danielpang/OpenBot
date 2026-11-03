#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh. This replaces the current
# database, files and computer volumes.
#
#   bash scripts/restore.sh <backup dir> [--yes]
#
# It first verifies the backup (MANIFEST checksums, a readable database dump,
# intact archives) and stops before touching anything if that fails. With
# Docker running it restores into the compose stack in this checkout: it
# stops openbots and the computers, recreates the database, refills the files
# volume and each computer volume, starts the stack again and checks that the
# files and users came back. Without Docker it restores a development install
# from DATABASE_URL and OPENBOTS_FILES_DIR (computer volumes are skipped).
# Inside the standalone image (OPENBOTS_STANDALONE=1, `docker exec <container>
# openbots restore <dir> --yes`) it stops the openbots and computer-agent
# services through s6, restores the database and /data/files, /data/home
# and /data/agent, and starts them again. A compose backup with one computer
# volume restores that volume as the Bots' home.
#
# Use the same OPENBOTS_MASTER_KEY as the install the backup came from.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_IMAGE="${OPENBOTS_BACKUP_HELPER_IMAGE:-pgvector/pgvector:pg16}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf 'restore: %s\n' "$*" >&2
  exit 1
}

SRC=""
YES=0
for arg in "$@"; do
  case "$arg" in
    -y | --yes) YES=1 ;;
    -h | --help)
      sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option '$arg' (try --help)" ;;
    *) SRC="$arg" ;;
  esac
done
[ -n "$SRC" ] || die "usage: scripts/restore.sh <backup dir> [--yes]"
[ -f "$SRC/database.dump" ] || die "$SRC/database.dump not found"
[ -f "$SRC/files.tar.gz" ] || die "$SRC/files.tar.gz not found"
SRC="$(cd "$SRC" && pwd)"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

compose() { (cd "$REPO_DIR" && docker compose "$@"); }
# Runs a command on the files volume in a one-off openbots container, as root
# with just the capabilities tar needs to put back files of two owners (the
# server's uid 1000 and nobody, S-1) with their modes: the openbots service
# itself holds none of them.
files_run() {
  local entrypoint="$1"
  shift
  compose run --rm --no-deps -T --user 0:0 \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --entrypoint "$entrypoint" openbots "$@"
}

if [ "${OPENBOTS_STANDALONE:-}" = 1 ]; then
  MODE=standalone
  [ "$(id -u)" = 0 ] || die "run it as root in the container: docker exec <container> openbots restore <dir>"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  MODE=compose
else
  MODE=local
  [ -n "${DATABASE_URL:-}" ] || die "Docker is not running and DATABASE_URL is not set"
  command -v pg_restore >/dev/null 2>&1 || die "pg_restore is not installed"
fi

log "Verifying $SRC"
expected_files=""
if [ -f "$SRC/MANIFEST" ]; then
  while read -r kind a b; do
    case "$kind" in
      sha256)
        [ -f "$SRC/$b" ] || die "$b is listed in MANIFEST but missing"
        [ "$(sha256 "$SRC/$b")" = "$a" ] || die "$b does not match its MANIFEST checksum"
        ;;
      files) expected_files="$a" ;;
    esac
  done <"$SRC/MANIFEST"
else
  log "No MANIFEST (a backup from before checksums were added); checking the archives only"
fi
for archive in "$SRC/files.tar.gz" "$SRC/home.tar.gz" "$SRC/agent.tar.gz" "$SRC"/computers/*.tar.gz; do
  [ -e "$archive" ] || continue
  gzip -t "$archive" || die "$(basename "$archive") is corrupt"
done
if [ "$MODE" = compose ]; then
  compose up -d --wait postgres
  list_dump() { compose exec -T postgres pg_restore --list <"$SRC/database.dump"; }
else
  list_dump() { pg_restore --list "$SRC/database.dump"; }
fi
if [ "$MODE" = standalone ]; then
  # The Bots' home: home.tar.gz, or the one computer volume of a compose backup.
  home_archive=""
  if [ -f "$SRC/home.tar.gz" ]; then
    home_archive="$SRC/home.tar.gz"
  else
    volumes=("$SRC"/computers/*.tar.gz)
    if [ "${#volumes[@]}" = 1 ] && [ -f "${volumes[0]}" ]; then
      home_archive="${volumes[0]}"
      log "No home.tar.gz; the Bots' home comes from $(basename "$home_archive")"
    elif [ "${#volumes[@]}" -gt 1 ]; then
      die "the backup holds several computer volumes; the standalone image has one home"
    fi
  fi
fi
listing="$(list_dump)" || die "pg_restore cannot read database.dump"
grep -q 'TABLE DATA public users ' <<<"$listing" || die "database.dump has no users table"

if [ "$YES" = 0 ]; then
  printf 'This replaces the current OpenBots data with %s. Continue? [y/N] ' "$SRC"
  read -r answer
  case "$answer" in
    y | Y | yes) ;;
    *) die "aborted" ;;
  esac
fi

if [ "$MODE" = standalone ]; then
  as_postgres() { runuser -u postgres -- "$@"; }
  # Puts a directory back from an archive, owners and modes included.
  refill() {
    find "$1" -mindepth 1 -delete
    tar --numeric-owner -xzf "$2" -C "$1"
  }
  # Started again however the restore ends, so a failure leaves a running
  # server on what is there.
  stopped=0
  start_services() {
    [ "$stopped" = 1 ] || return 0
    stopped=0
    log "Starting openbots"
    s6-rc -t 600000 -u change openbots
  }
  trap start_services EXIT

  log "Stopping openbots and the computer agent"
  stopped=1
  s6-rc -d change openbots computer-agent

  log "Database"
  as_postgres psql -h /run/postgresql -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE IF EXISTS openbots WITH (FORCE)' -c 'CREATE DATABASE openbots OWNER openbots'
  as_postgres psql -h /run/postgresql -d openbots -v ON_ERROR_STOP=1 -q \
    -c 'CREATE EXTENSION IF NOT EXISTS vector'
  # As the superuser, keeping the dump's owners: the tables stay openbots's.
  as_postgres pg_restore -h /run/postgresql -d openbots --exit-on-error <"$SRC/database.dump"

  log "Files"
  refill /data/files "$SRC/files.tar.gz"
  # A compose backup's files are uid 1000's, the bot user here.
  chown -R openbots:openbots /data/files
  restored_files="$(find /data/files -type f | wc -l | tr -d '[:space:]')"

  if [ -n "$home_archive" ]; then
    log "The Bots' home"
    refill /data/home "$home_archive"
    chown bot:bot /data/home
  fi
  if [ -f "$SRC/agent.tar.gz" ]; then
    log "The computer agent's state"
    refill /data/agent "$SRC/agent.tar.gz"
  fi

  start_services
  users="$(as_postgres psql -h /run/postgresql -d openbots -tA -c 'SELECT count(*) FROM users')"
elif [ "$MODE" = compose ]; then
  log "Stopping openbots"
  compose stop openbots

  log "Database"
  compose exec -T postgres psql -U openbots -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE IF EXISTS openbots WITH (FORCE)' -c 'CREATE DATABASE openbots OWNER openbots'
  compose exec -T postgres pg_restore -U openbots -d openbots --no-owner --exit-on-error <"$SRC/database.dump"

  log "Files"
  files_run sh -c 'find /data/files -mindepth 1 -delete && tar --numeric-owner -xzf - -C /data/files' \
    <"$SRC/files.tar.gz"
  restored_files="$(files_run sh -c 'find /data/files -type f | wc -l' | tr -d '[:space:]')"

  for archive in "$SRC"/computers/*.tar.gz; do
    [ -e "$archive" ] || continue
    volume="$(basename "$archive" .tar.gz)"
    log "Computer volume $volume"
    containers="$(docker ps -q --filter "volume=$volume")"
    # shellcheck disable=SC2086 # one id per word
    [ -z "$containers" ] || docker stop $containers >/dev/null
    docker run --rm -i --entrypoint sh -v "$volume:/volume" "$HELPER_IMAGE" \
      -c 'find /volume -mindepth 1 -delete && tar --numeric-owner -xzf - -C /volume' <"$archive"
  done

  log "Starting the stack"
  compose up -d --wait
  users="$(compose exec -T postgres psql -U openbots -d openbots -tA -c 'SELECT count(*) FROM users')"
else
  FILES_DIR="${OPENBOTS_FILES_DIR:-/data/files}"
  log "Docker is not running; restoring into the database and $FILES_DIR"

  log "Database"
  pg_restore --clean --if-exists --no-owner --exit-on-error -d "$DATABASE_URL" "$SRC/database.dump"

  log "Files"
  mkdir -p "$FILES_DIR"
  find "$FILES_DIR" -mindepth 1 -delete
  tar -xzf "$SRC/files.tar.gz" -C "$FILES_DIR"
  restored_files="$(find "$FILES_DIR" -type f | wc -l | tr -d '[:space:]')"
  log "Computer volumes need Docker, skipping"
  users="$(psql -d "$DATABASE_URL" -tA -c 'SELECT count(*) FROM users' 2>/dev/null || echo '?')"
fi

log "Checking the restore"
if [ -n "$expected_files" ] && [ "$restored_files" != "$expected_files" ]; then
  die "restored $restored_files files but the backup holds $expected_files"
fi
log "Done: $restored_files files, $users users"
