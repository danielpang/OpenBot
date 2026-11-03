#!/usr/bin/env bash
# Tests for docker/standalone/lib/init-lib.sh and the secret-file handling of
# lib/env.sh: what standalone-init refuses, what it generates, and what it
# keeps. Runs anywhere bash runs, as any user, on scratch directories:
#
#   bash docker/standalone/test/init-lib.test.sh
#
# CI runs it in the check job.
#
# `A && pass || fail` is meant: pass only prints. Each case sets its settings
# in a subshell, on purpose, and log and die are called by the library.
# shellcheck disable=SC2015,SC2030,SC2031,SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

# A clean slate of the settings under test; a case sets one in a subshell.
unset OPENBOTS_MASTER_KEY OPENBOTS_MASTER_KEY_FILE POSTGRES_PASSWORD POSTGRES_PASSWORD_FILE \
  OPENBOTS_DB_APP_PASSWORD OPENBOTS_DB_APP_PASSWORD_FILE OPENBOTS_REDIS_PASSWORD \
  OPENBOTS_REDIS_PASSWORD_FILE DATABASE_URL DATABASE_URL_FILE REDIS_URL REDIS_URL_FILE PORT PORT_FILE \
  ANTHROPIC_API_KEY ANTHROPIC_API_KEY_FILE

# Runs "$@" in a subshell with init-lib.sh loaded; prints what it logged,
# exits as it did.
run_lib() {
  (
    log() { printf 'log: %s\n' "$*"; }
    die() {
      printf 'die: %s\n' "$*"
      exit 1
    }
    # shellcheck source=SCRIPTDIR/../lib/init-lib.sh
    . "$LIB/init-lib.sh"
    "$@"
  ) 2>&1
}

# A volume: DIR/.env and DIR/pgdata, the cluster made or not.
make_volume() {
  local dir="$SCRATCH/$1" with_cluster="$2"
  mkdir -p "$dir/pgdata"
  : >"$dir/.env"
  if [ "$with_cluster" = cluster ]; then
    printf '16\n' >"$dir/pgdata/PG_VERSION"
    : >"$dir/pgdata/postgresql.conf"
  fi
  printf '%s\n' "$dir"
}

all_settings() {
  printf 'OPENBOTS_MASTER_KEY=a2V5\nPOSTGRES_PASSWORD=0123456789abcdef01\nOPENBOTS_DB_APP_PASSWORD=0123456789abcdef02\nOPENBOTS_REDIS_PASSWORD=0123456789abcdef03\n'
}

# --- A new master key next to an existing database ----------------------------
vol="$(make_volume missing-key cluster)"
all_settings | grep -v OPENBOTS_MASTER_KEY >"$vol/.env"
if out="$(run_lib require_kept_settings "$vol/pgdata" "$vol/.env")"; then
  fail "a cluster without OPENBOTS_MASTER_KEY is refused"
else
  grep -q 'missing: OPENBOTS_MASTER_KEY' <<<"$out" && grep -q 'unreadable' <<<"$out" &&
    pass "a cluster without OPENBOTS_MASTER_KEY is refused" ||
    fail "a cluster without OPENBOTS_MASTER_KEY is refused, with the reason ($out)"
fi
grep -q OPENBOTS_MASTER_KEY "$vol/.env" && fail "the refused boot wrote no key" || pass "the refused boot wrote no key"

vol="$(make_volume missing-passwords cluster)"
printf 'OPENBOTS_MASTER_KEY=a2V5\n' >"$vol/.env"
out="$(run_lib require_kept_settings "$vol/pgdata" "$vol/.env")" && status=0 || status=$?
if [ "$status" != 0 ] && grep -q 'POSTGRES_PASSWORD OPENBOTS_DB_APP_PASSWORD OPENBOTS_REDIS_PASSWORD' <<<"$out"; then
  pass "a cluster without the database and Redis passwords is refused"
else
  fail "a cluster without the database and Redis passwords is refused ($out)"
fi

vol="$(make_volume key-in-env cluster)"
all_settings | grep -v OPENBOTS_MASTER_KEY >"$vol/.env"
if (export OPENBOTS_MASTER_KEY=a2V5 && run_lib require_kept_settings "$vol/pgdata" "$vol/.env" >/dev/null); then
  pass "a key from the environment is enough"
else
  fail "a key from the environment is enough"
fi
key_file="$SCRATCH/master-key"
printf 'a2V5' >"$key_file"
if (export OPENBOTS_MASTER_KEY_FILE="$key_file" && run_lib require_kept_settings "$vol/pgdata" "$vol/.env" >/dev/null); then
  pass "a key from OPENBOTS_MASTER_KEY_FILE is enough"
else
  fail "a key from OPENBOTS_MASTER_KEY_FILE is enough"
fi

vol="$(make_volume complete cluster)"
all_settings >"$vol/.env"
run_lib require_kept_settings "$vol/pgdata" "$vol/.env" >/dev/null &&
  pass "a cluster with every setting starts" || fail "a cluster with every setting starts"

# --- First boot ----------------------------------------------------------------
vol="$(make_volume fresh none)"
run_lib require_kept_settings "$vol/pgdata" "$vol/.env" >/dev/null &&
  pass "a first boot needs no setting" || fail "a first boot needs no setting"
run_lib ensure_setting "$vol/.env" OPENBOTS_MASTER_KEY echo generated-key >/dev/null
grep -qx 'OPENBOTS_MASTER_KEY=generated-key' "$vol/.env" &&
  pass "a first boot writes a key" || fail "a first boot writes a key"
run_lib ensure_setting "$vol/.env" OPENBOTS_MASTER_KEY echo another-key >/dev/null
[ "$(grep -c OPENBOTS_MASTER_KEY "$vol/.env")" = 1 ] && grep -qx 'OPENBOTS_MASTER_KEY=generated-key' "$vol/.env" &&
  pass "a key that is there is kept" || fail "a key that is there is kept"
(export POSTGRES_PASSWORD_FILE="$key_file" && run_lib ensure_setting "$vol/.env" POSTGRES_PASSWORD echo x >/dev/null)
grep -q POSTGRES_PASSWORD "$vol/.env" && fail "NAME_FILE counts as given" || pass "NAME_FILE counts as given"
[ "$(stat -c %a "$vol/.env" 2>/dev/null || stat -f %Lp "$vol/.env")" = 600 ] &&
  pass "the env file stays 0600" || fail "the env file stays 0600"

# --- PGDATA's state and version -----------------------------------------------
vol="$(make_volume partial none)"
: >"$vol/pgdata/postgresql.conf"
mkdir "$vol/pgdata/base"
[ "$(run_lib pgdata_state "$vol/pgdata")" = partial ] && pass "files without PG_VERSION are a partial cluster" ||
  fail "files without PG_VERSION are a partial cluster"
out="$(run_lib check_pgdata "$vol/pgdata" 16)" && status=0 || status=$?
[ "$status" != 0 ] && grep -q 'no PG_VERSION' <<<"$out" && pass "a partial cluster is refused" ||
  fail "a partial cluster is refused ($out)"

vol="$(make_volume empty none)"
[ "$(run_lib pgdata_state "$vol/pgdata")" = none ] && pass "an empty pgdata is no cluster" ||
  fail "an empty pgdata is no cluster"
[ "$(run_lib pgdata_state "$SCRATCH/nowhere")" = none ] && pass "a missing pgdata is no cluster" ||
  fail "a missing pgdata is no cluster"

vol="$(make_volume old-major cluster)"
out="$(run_lib check_pgdata "$vol/pgdata" 17)" && status=0 || status=$?
[ "$status" != 0 ] && grep -q 'PostgreSQL 16, and this image runs PostgreSQL 17' <<<"$out" && grep -q pg_upgrade <<<"$out" &&
  pass "another major version is refused, naming pg_upgrade" || fail "another major version is refused ($out)"
run_lib check_pgdata "$vol/pgdata" 16 >/dev/null && pass "the same major version starts" ||
  fail "the same major version starts"

# --- Fixed settings ----------------------------------------------------------------
vol="$(make_volume fixed none)"
printf 'REDIS_URL=redis://elsewhere\n' >"$vol/.env"
out="$(export DATABASE_URL=postgres://elsewhere && run_lib warn_fixed_settings "$vol/.env" "DATABASE_URL REDIS_URL PORT")"
grep -q 'Ignoring DATABASE_URL from the container' <<<"$out" && grep -q 'Ignoring REDIS_URL in' <<<"$out" &&
  ! grep -q PORT <<<"$out" && pass "fixed settings that are set are logged, others are not" ||
  fail "fixed settings that are set are logged ($out)"

# --- env.sh: NAME_FILE ----------------------------------------------------------------
out="$(
  (
    # shellcheck source=SCRIPTDIR/../lib/env.sh
    . "$LIB/env.sh"
    export OPENBOTS_MASTER_KEY_FILE="$key_file" ANTHROPIC_API_KEY_FILE="$key_file" ANTHROPIC_API_KEY=direct
    openbots_resolve_secret_files
    printf '%s|%s|%s|%s\n' "$OPENBOTS_MASTER_KEY" "${OPENBOTS_MASTER_KEY_FILE-unset}" "$ANTHROPIC_API_KEY" "${ANTHROPIC_API_KEY_FILE-unset}"
  ) 2>/dev/null
)"
[ "$out" = 'a2V5|unset|direct|unset' ] && pass "NAME_FILE is read into NAME and unset, NAME wins over it" ||
  fail "NAME_FILE is read into NAME and unset ($out)"

echo
if [ "$failures" != 0 ]; then
  echo "$failures failed"
  exit 1
fi
echo "all passed"
