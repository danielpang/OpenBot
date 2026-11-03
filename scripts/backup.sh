#!/usr/bin/env bash
# Backs up an OpenBots install (plan 16.3): the database, the files directory
# and every computer's home volume, then verifies what it wrote.
#
#   bash scripts/backup.sh [output dir]   # default: backups/<UTC timestamp>
#
# Writes <dir>/database.dump (pg_dump custom format), <dir>/files.tar.gz,
# <dir>/computers/<volume>.tar.gz and <dir>/MANIFEST (checksums and counts
# that restore.sh checks before it replaces anything). Restore with
# scripts/restore.sh.
#
# With Docker running it backs up the compose stack in this checkout (run it
# from anywhere; the stack can be up or down). Without Docker it backs up a
# development install from DATABASE_URL and OPENBOTS_FILES_DIR (computers need
# Docker and are skipped). Inside the standalone image (OPENBOTS_STANDALONE=1,
# `docker exec <container> openbots backup [dir]`) it backs up /data, by
# default into /data/backups/<UTC timestamp>, with the Bots' home as
# home.tar.gz and the computer agent's state as agent.tar.gz.
#
# The backup does not contain OPENBOTS_MASTER_KEY. Keep .env (or at least the
# key) somewhere safe as well: stored secrets cannot be decrypted without it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Any image with tar works; the Postgres image is already on the machine.
HELPER_IMAGE="${OPENBOTS_BACKUP_HELPER_IMAGE:-pgvector/pgvector:pg16}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf 'backup: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  -h | --help)
    sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  -*) die "unknown option '$1' (try --help)" ;;
esac

# The dump holds sessions and sealed secrets: keep the backup private.
umask 077

STANDALONE="${OPENBOTS_STANDALONE:-}"
[ "$STANDALONE" = 1 ] || STANDALONE=""
if [ -n "$STANDALONE" ]; then
  [ "$(id -u)" = 0 ] || die "run it as root in the container: docker exec <container> openbots backup"
  BACKUPS_DIR=/data/backups
else
  BACKUPS_DIR="$REPO_DIR/backups"
fi
OUT="${1:-$BACKUPS_DIR/$(date -u +%Y%m%dT%H%M%SZ)}"
[ ! -e "$OUT" ] || [ -z "$(ls -A "$OUT")" ] || die "$OUT exists and is not empty"
mkdir -p "$OUT/computers"
OUT="$(cd "$OUT" && pwd)"

# A failed backup must not look like a good one: remove what was written.
finished=0
cleanup() {
  if [ "$finished" = 0 ]; then
    printf 'backup: failed; removing the incomplete backup %s\n' "$OUT" >&2
    rm -rf "$OUT"
  fi
}
trap cleanup EXIT

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Regular files in an archive, as `tar -tv` lists them.
archived_files() { tar -tvzf "$1" | grep -c '^-' || true; }

compose() { (cd "$REPO_DIR" && docker compose "$@"); }
# Runs a command on the files volume in a one-off openbots container. The
# volume holds the server's files (uid 1000) and what stdio MCP servers wrote
# as nobody, each private to its owner (S-1), and the openbots service holds no
# capability that reads past file modes. So this runs as root with
# DAC_READ_SEARCH and nothing else: it can read every file and change none.
files_run() {
  local entrypoint="$1"
  shift
  compose run --rm --no-deps -T --user 0:0 --cap-add DAC_READ_SEARCH \
    --entrypoint "$entrypoint" openbots "$@"
}

# Archives a directory that may change while it is read (a Bot at work, a
# running browser): tar's status 1 says a file changed as it was read, and
# the archive is still complete.
tar_live() {
  local status=0
  tar --numeric-owner --warning=no-file-changed --warning=no-file-removed "$@" || status=$?
  [ "$status" -le 1 ] || return "$status"
}

if [ -n "$STANDALONE" ]; then
  MODE=standalone
  log "Backing up the standalone container into $OUT"

  log "Database"
  # As the postgres superuser, over the socket only root and postgres open.
  runuser -u postgres -- pg_dump -h /run/postgresql -d openbots -Fc >"$OUT/database.dump"
  list_dump() { pg_restore --list "$OUT/database.dump"; }

  log "Files"
  tar --numeric-owner -C /data/files -czf "$OUT/files.tar.gz" .
  source_files="$(find /data/files -type f | wc -l | tr -d '[:space:]')"

  log "The Bots' home"
  tar_live -C /data/home -czf "$OUT/home.tar.gz" .
  log "The computer agent's state"
  tar_live -C /data/agent --exclude=./token --exclude=./token.new -czf "$OUT/agent.tar.gz" .
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  MODE=compose
  log "Backing up the compose stack into $OUT"
  compose up -d --wait postgres

  log "Database"
  compose exec -T postgres pg_dump -U openbots -d openbots -Fc >"$OUT/database.dump"
  list_dump() { compose exec -T postgres pg_restore --list <"$OUT/database.dump"; }

  log "Files"
  files_run tar --numeric-owner -C /data/files -czf - . >"$OUT/files.tar.gz"
  source_files="$(files_run sh -c 'find /data/files -type f | wc -l' | tr -d '[:space:]')"

  volumes="$(compose exec -T postgres psql -U openbots -d openbots -tA \
    -c 'SELECT volume_name FROM computers WHERE volume_name IS NOT NULL')"
  for volume in $volumes; do
    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
      log "Computer volume $volume does not exist, skipping"
      continue
    fi
    log "Computer volume $volume"
    docker run --rm --entrypoint tar -v "$volume:/volume:ro" "$HELPER_IMAGE" \
      --numeric-owner -C /volume -czf - . >"$OUT/computers/$volume.tar.gz"
  done
else
  MODE=local
  [ -n "${DATABASE_URL:-}" ] || die "Docker is not running and DATABASE_URL is not set"
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump is not installed"
  FILES_DIR="${OPENBOTS_FILES_DIR:-/data/files}"
  log "Docker is not running; backing up the database and $FILES_DIR into $OUT"

  log "Database"
  pg_dump -Fc -d "$DATABASE_URL" >"$OUT/database.dump"
  list_dump() { pg_restore --list "$OUT/database.dump"; }

  log "Files"
  if [ -d "$FILES_DIR" ]; then
    tar -C "$FILES_DIR" -czf "$OUT/files.tar.gz" .
    source_files="$(find "$FILES_DIR" -type f | wc -l | tr -d '[:space:]')"
  else
    log "$FILES_DIR does not exist; writing an empty archive"
    tar -czf "$OUT/files.tar.gz" -T /dev/null
    source_files=0
  fi
  log "Computer volumes need Docker, skipping"
fi

log "Verifying"
# The dump must be readable by pg_restore and hold the users table's data.
list_dump >"$OUT/database.list" || die "pg_restore cannot read database.dump"
grep -q 'TABLE DATA public users ' "$OUT/database.list" ||
  die "database.dump has no users table; is this an OpenBots database?"
rm "$OUT/database.list"
# Each archive must be complete.
for archive in "$OUT/files.tar.gz" "$OUT/home.tar.gz" "$OUT/agent.tar.gz" "$OUT"/computers/*.tar.gz; do
  [ -e "$archive" ] || continue
  gzip -t "$archive" || die "$(basename "$archive") is corrupt"
done
backed_up="$(archived_files "$OUT/files.tar.gz")"
if [ "$backed_up" != "$source_files" ]; then
  # Uploads during the backup move the count; the archive itself is complete.
  log "Note: files.tar.gz holds $backed_up files; the files directory had $source_files when counted"
fi

{
  echo "# OpenBots backup; scripts/restore.sh checks this before restoring"
  echo "created $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "mode $MODE"
  echo "files $backed_up"
  (cd "$OUT" && for f in database.dump files.tar.gz home.tar.gz agent.tar.gz computers/*.tar.gz; do
    if [ -e "$f" ]; then echo "sha256 $(sha256 "$f") $f"; fi
  done)
} >"$OUT/MANIFEST"

finished=1
log "Done: $OUT ($backed_up files, $(du -sh "$OUT" | cut -f1))"
if [ -n "$STANDALONE" ]; then
  # On the same volume as what it backs up: a copy elsewhere survives losing it.
  log "Copy it off the volume, with /data/.env kept apart: docker cp <container>:$OUT ."
fi
