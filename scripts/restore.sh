#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh. This replaces the current
# database, files and computer volumes.
#
#   bash scripts/restore.sh <backup dir> [--yes] [--skip-home]
#
# It first checks everything it can before it changes anything: the MANIFEST
# checksums, a readable database dump, intact archives, where each archive
# goes, and the free space (twice the backup's size). Only then does it ask
# (--yes skips the question; without a terminal to ask on, --yes is needed)
# and replace the data.
#
# With Docker running it restores into the compose stack in this checkout: it
# stops openbots and the computers, recreates the database, refills the files
# volume and each computer volume, starts the stack again and checks that the
# files and users came back. A backup of the standalone image restores there
# too: its files are given to the server's uid 1000, and its home.tar.gz
# fills the home volume of the computer the restored database names (made if
# missing). The standalone computer's sign-ins (agent.tar.gz) have no place in
# the compose stack and are left out, with a message. --skip-home leaves the
# Bots' home out on purpose.
#
# Without Docker it restores a development install from DATABASE_URL and
# OPENBOTS_FILES_DIR (computer volumes and the Bots' home are left out, with a
# message).
#
# Inside the standalone image (OPENBOTS_STANDALONE=1, `docker exec <container>
# openbots restore <dir> --yes`) it stops the openbots and computer-agent
# services through s6, empties Redis (the queues, so no job from before runs
# against the restored database), restores the database and /data/files,
# /data/home and /data/agent, and starts them again. A compose backup with
# one computer volume restores that volume as the Bots' home.
#
# Use the same OPENBOTS_MASTER_KEY as the install the backup came from, and
# stop the install the backup came from if it still runs: two servers with
# one database dial the relay as one server.
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
SKIP_HOME=0
for arg in "$@"; do
  case "$arg" in
    -y | --yes) YES=1 ;;
    --skip-home) SKIP_HOME=1 ;;
    -h | --help)
      sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option '$arg' (try --help)" ;;
    *) SRC="$arg" ;;
  esac
done
[ -n "$SRC" ] || die "usage: scripts/restore.sh <backup dir> [--yes] [--skip-home]"
[ -f "$SRC/database.dump" ] || die "$SRC/database.dump not found"
[ -f "$SRC/files.tar.gz" ] || die "$SRC/files.tar.gz not found"
SRC="$(cd "$SRC" && pwd)"

# Asked before any work: without a terminal the question cannot be answered,
# and a silent "no" would look like a restore that did nothing.
if [ "$YES" = 0 ] && [ ! -t 0 ]; then
  die "there is no terminal to ask on (docker exec without -it, a script, CI). Pass --yes to restore without asking."
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The nearest directory of PATH that exists, for df.
existing_dir() {
  local dir="$1"
  while [ ! -d "$dir" ]; do dir="$(dirname "$dir")"; done
  printf '%s\n' "$dir"
}
# Available KiB from `df -Pk` output on stdin.
avail_kib() { awk 'NR == 2 { print $4 }'; }

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
  [ "$(id -u)" = 0 ] || die "run it as root in the container: docker exec <container> openbots restore <dir> --yes"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  MODE=compose
else
  MODE=local
  [ -n "${DATABASE_URL:-}" ] || die "Docker is not running and DATABASE_URL is not set"
  command -v pg_restore >/dev/null 2>&1 || die "pg_restore is not installed"
fi

# --- Checks: nothing below changes anything until the question ---------------
log "Verifying $SRC"
expected_files=""
backup_mode=""
if [ -f "$SRC/MANIFEST" ]; then
  while read -r kind a b; do
    case "$kind" in
      sha256)
        [ -f "$SRC/$b" ] || die "$b is listed in MANIFEST but missing"
        [ "$(sha256 "$SRC/$b")" = "$a" ] || die "$b does not match its MANIFEST checksum"
        ;;
      files) expected_files="$a" ;;
      mode) backup_mode="$a" ;;
    esac
  done <"$SRC/MANIFEST"
else
  log "No MANIFEST (a backup from before checksums were added); checking the archives only"
fi
# A backup from before MANIFEST named its mode: home.tar.gz says standalone.
if [ -z "$backup_mode" ] && [ -f "$SRC/home.tar.gz" ]; then backup_mode=standalone; fi
for archive in "$SRC/files.tar.gz" "$SRC/home.tar.gz" "$SRC/agent.tar.gz" "$SRC"/computers/*.tar.gz; do
  [ -e "$archive" ] || continue
  gzip -t "$archive" || die "$(basename "$archive") is corrupt"
done
if [ "$MODE" = compose ]; then
  compose up -d --wait postgres
  list_dump() { compose exec -T postgres pg_restore --list <"$SRC/database.dump"; }
  # The computers in the dump, as "<id> <home volume>": the volume the docker
  # provider names openbots-home-<id> when the row has none.
  dump_computers() {
    compose exec -T postgres pg_restore --data-only --table=computers -f - <"$SRC/database.dump" |
      awk -F'\t' '
        /^COPY [a-z_]*\.?computers \(/ {
          cols = $0
          sub(/^COPY [^(]*\(/, "", cols)
          sub(/\) FROM stdin;$/, "", cols)
          n = split(cols, names, ", ")
          for (i = 1; i <= n; i++) {
            if (names[i] == "id") idc = i
            if (names[i] == "volume_name") vc = i
          }
          copying = 1
          next
        }
        copying && $0 == "\\." { copying = 0; next }
        copying {
          volume = vc ? $vc : ""
          if (volume == "" || volume == "\\N") volume = "openbots-home-" $idc
          print $idc, volume
        }'
  }
else
  list_dump() { pg_restore --list "$SRC/database.dump"; }
fi
listing="$(list_dump)" || die "pg_restore cannot read database.dump"
grep -q 'TABLE DATA public users ' <<<"$listing" || die "database.dump has no users table"

# Where the Bots' home goes, decided now so a backup that cannot be put back
# whole stops here, before anything is deleted.
home_archive=""
home_volume=""
home_computer=""
case "$MODE" in
  standalone)
    # home.tar.gz, or the one computer volume of a compose backup.
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
    ;;
  compose)
    if [ -f "$SRC/home.tar.gz" ]; then
      if [ "$SKIP_HOME" = 1 ]; then
        log "Leaving out the Bots' home (home.tar.gz), as --skip-home asks"
      else
        computers="$(dump_computers)" || die "cannot read the computers from database.dump"
        count="$(printf '%s' "$computers" | grep -c . || true)"
        if [ "$count" = 0 ]; then
          die "the backup holds the Bots' home (home.tar.gz) but its database has no computer, so there is no computer volume to put it in. Open a Bot's Computer page once on the server the backup came from and back up again, or pass --skip-home to restore without the Bots' home."
        elif [ "$count" -gt 1 ]; then
          die "the backup holds one Bots' home (home.tar.gz) and its database has $count computers, so where it goes is not clear. Pass --skip-home to restore without it, and copy the files in by hand."
        fi
        read -r home_computer home_volume <<<"$computers"
        [[ "$home_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "the computer's volume name '$home_volume' is not a Docker volume name"
        home_archive="$SRC/home.tar.gz"
      fi
    fi
    if [ -f "$SRC/agent.tar.gz" ]; then
      log "Note: agent.tar.gz (the standalone computer's browser sign-ins and cookie store) has no place in the compose stack and is left out; the Bots sign in to sites again"
    fi
    ;;
  local)
    [ ! -f "$SRC/home.tar.gz" ] || log "Note: the Bots' home (home.tar.gz) needs Docker and is left out"
    ;;
esac

# Twice the backup: the archives and dump unpack to more than they weigh,
# and the database is rebuilt beside the space its indexes need.
backup_bytes=0
for f in "$SRC/database.dump" "$SRC/files.tar.gz" "$home_archive" "$SRC/agent.tar.gz" "$SRC"/computers/*.tar.gz; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  backup_bytes=$((backup_bytes + $(wc -c <"$f")))
done
need_kib=$((backup_bytes * 2 / 1024))
case "$MODE" in
  standalone) free_kib="$(df -Pk /data | avail_kib)" ;;
  compose) free_kib="$(files_run df -Pk /data/files | avail_kib)" ;;
  local) free_kib="$(df -Pk "$(existing_dir "${OPENBOTS_FILES_DIR:-/data/files}")" | avail_kib)" ;;
esac
if [ -n "$free_kib" ] && [ "$free_kib" -lt "$need_kib" ]; then
  die "not enough free space: restoring this backup needs about $((need_kib / 1024)) MiB (twice its size) and $((free_kib / 1024)) MiB is free. Nothing was changed."
fi

if [ "$YES" = 0 ]; then
  printf 'This replaces the current OpenBots data with %s. Continue? [y/N] ' "$SRC"
  read -r answer
  case "$answer" in
    y | Y | yes) ;;
    *) die "aborted" ;;
  esac
fi

# --- The restore ---------------------------------------------------------------
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

  log "Emptying Redis (the job queues)"
  REDISCLI_AUTH="$(sed -n 's/^requirepass "\(.*\)"$/\1/p' /run/redis/redis.conf)"
  export REDISCLI_AUTH
  [ "$(redis-cli -h 127.0.0.1 -p 6379 FLUSHALL)" = OK ] || die "Redis did not empty; nothing else was changed"
  unset REDISCLI_AUTH

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
  if [ "$backup_mode" = standalone ]; then
    # The standalone server is uid 990; here it is uid 1000, and nothing in a
    # standalone backup belongs to anyone else (its stdio servers ran in the
    # computer).
    log "Giving the files to the server's user (uid 1000)"
    files_run chown -R 1000:1000 /data/files
  fi
  restored_files="$(files_run sh -c 'find /data/files -type f | wc -l' | tr -d '[:space:]')"

  # Stops whatever runs on a volume, then refills it from an archive.
  refill_volume() {
    local volume="$1" archive="$2" containers
    containers="$(docker ps -q --filter "volume=$volume")"
    # shellcheck disable=SC2086 # one id per word
    [ -z "$containers" ] || docker stop $containers >/dev/null
    docker run --rm -i --entrypoint sh -v "$volume:/volume" "$HELPER_IMAGE" \
      -c 'find /volume -mindepth 1 -delete && tar --numeric-owner -xzf - -C /volume' <"$archive"
  }
  for archive in "$SRC"/computers/*.tar.gz; do
    [ -e "$archive" ] || continue
    volume="$(basename "$archive" .tar.gz)"
    log "Computer volume $volume"
    refill_volume "$volume" "$archive"
  done
  if [ -n "$home_archive" ]; then
    log "The Bots' home, into computer volume $home_volume"
    if ! docker volume inspect "$home_volume" >/dev/null 2>&1; then
      # Labelled as the docker provider labels the volumes it makes.
      docker volume create --label "openbots.computer=$home_computer" "$home_volume" >/dev/null
    fi
    refill_volume "$home_volume" "$home_archive"
  fi

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
