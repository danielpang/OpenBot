#!/usr/bin/env bash
# Starts Postgres (with pgvector) and Redis for development and prints the
# variables to export before `pnpm dev` or `pnpm test`.
#
#   bash scripts/dev.sh           # Docker when it is running, else the local services
#   bash scripts/dev.sh --docker  # the compose stack's postgres and redis, published on localhost
#   bash scripts/dev.sh --local   # the apt services from `scripts/dev-setup.sh --services`
#
# Both give postgres://openbots:openbots@127.0.0.1:5432/openbots and
# redis://127.0.0.1:6379.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_URL=postgres://openbots:openbots@127.0.0.1:5432/openbots
REDIS_URL=redis://127.0.0.1:6379

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf 'dev: %s\n' "$*" >&2
  exit 1
}

MODE=auto
for arg in "$@"; do
  case "$arg" in
    --docker) MODE=docker ;;
    --local) MODE=local ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument '$arg' (try --help)" ;;
  esac
done
if [ "$MODE" = auto ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    MODE=docker
  else
    MODE=local
  fi
fi

if [ "$MODE" = docker ]; then
  cd "$REPO_DIR"
  # The compose file reads .env for the openbots service; a copy of the example
  # is enough for postgres and redis.
  if [ ! -f .env ]; then
    log "Creating .env from .env.example"
    cp .env.example .env
  fi
  log "Starting postgres and redis with Docker Compose"
  docker compose --project-directory . -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
    up -d --wait postgres redis
else
  if ! command -v pg_ctlcluster >/dev/null 2>&1 || ! command -v redis-server >/dev/null 2>&1; then
    die "no Docker and no local services; run 'bash scripts/dev-setup.sh --services' first"
  fi
  SUDO=""
  [ "$(id -u)" -eq 0 ] || SUDO="sudo"
  log "Starting the local Postgres and Redis"
  if ! $SUDO pg_ctlcluster 16 main status >/dev/null 2>&1; then
    $SUDO pg_ctlcluster 16 main start
  fi
  if ! redis-cli ping >/dev/null 2>&1; then
    $SUDO redis-server --daemonize yes --save '' --appendonly no
  fi
fi

log "Ready. Export these, plus OPENBOTS_MASTER_KEY (pnpm -s --filter @openbots/server keygen), then run pnpm dev:"
echo
echo "export DATABASE_URL=$DATABASE_URL"
echo "export REDIS_URL=$REDIS_URL"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  # The computer refuses a Docker API that is not the docker guard, so the
  # server on the host reaches Docker through one run from this checkout.
  echo
  log "For Bot computers, run the docker guard in another terminal and export DOCKER_HOST too:"
  echo
  echo "pnpm --filter @openbots/computer docker-guard"
  echo "export DOCKER_HOST=tcp://127.0.0.1:2375"
fi
