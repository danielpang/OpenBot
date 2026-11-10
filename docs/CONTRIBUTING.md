# Contributing to OpenBots

Start with the [VM guide](VM_SETUP.md) or the [self-hosting reference](SELF_HOSTING.md). The
[development reference](SELF_HOSTING.md#development) covers machine setup.
[PRD.md](plans/PRD.md) and [TECHNICAL_PLAN.md](plans/TECHNICAL_PLAN.md) say what OpenBots is and
how it is built.

## Before you open a pull request

Run the full local checks (`.github/workflows/ci.yml` selects affected checks in CI):

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

If you change an API route, regenerate the OpenAPI document and the client and commit the result:

```sh
pnpm --filter @openbots/server openapi
pnpm exec prettier --write packages/api-client/openapi.json
pnpm --filter @openbots/api-client generate
```

## CI scope and build reuse

CI runs on pull requests and pushes to `main`, not nightly. The **Select affected checks** job
compares changed paths (including deleted and renamed ones) against the merge-base using
`scripts/ci-scope.mjs`:

- **Mobile only:** **iOS unit tests and bundle**. General workspace checks exclude mobile lint,
  typechecking, tests and builds, so nothing runs twice.
- **Desktop:** general workspace checks, without database, browser or container jobs.
- **Server:** also real-Postgres tests, browser tests and image/lifecycle smoke tests.
- **Web:** browser and image/lifecycle tests, but not the server's Postgres suite.
- **Relay:** workspace and image checks.
- **Docker/Compose/backup:** the relevant container checks.
- **Shared packages, the lockfile, CI configuration, unknown code paths:** the full suite.
- **Documentation only:** skips compilation and integration runners.

The general check job builds the non-mobile workspace once. When browser tests are selected, it
uploads `apps/*/dist`, `packages/*/dist` and `ee/*/dist` as **browser-test-build**, and every
Playwright shard downloads that instead of rebuilding. It is a temporary CI artifact kept for
one day, not a GitHub Release asset or an installer. Each shard still gets a fresh Postgres/Redis
environment.

**CI result** always runs. It fails if any selected job fails or is cancelled, and accepts
intentionally skipped jobs. Use it for branch protection instead of requiring each optional job.

Release packaging and publication do not run on PRs. Version-tag pushes run the full release
pipelines, including the iOS EAS build and TestFlight submission when credentials are set. There
is no manual, untagged iOS release workflow; local builds remain available.

## What a change includes

- Tests for every change in behaviour, next to the code (`*.test.ts`). Server tests run on an
  in-memory PGlite database, so they need no Docker, Redis or provider key.
- For changes to queries, transactions or workers, also run the server tests on real Postgres, as
  CI does (the `server-postgres` job). PGlite runs one query at a time, so a test can pass there
  and still race on a real server. Set `DATABASE_URL` to a Postgres with pgvector whose user may
  create databases. Each test app gets its own database, copied from a migrated template
  (`apps/server/src/db/test-db.ts`):

  ```sh
  docker run -d --rm --name openbots-test-pg -p 55432:5432 \
    -e POSTGRES_USER=openbots -e POSTGRES_PASSWORD=openbots -e POSTGRES_DB=openbots \
    pgvector/pgvector:pg16
  DATABASE_URL=postgres://openbots:openbots@127.0.0.1:55432/openbots \
    pnpm turbo run test --filter @openbots/server
  docker rm -f openbots-test-pg
  ```

  A `DATABASE_URL` left in your shell (from `scripts/dev.sh`, say) does the same, against that
  server. On a busy machine, add `-- --maxWorkers=4` so Postgres gets CPU and tests stay clear of
  their 5 second timeout.

- The docs it affects: the README for anything an operator sees, `.env.example` for a new setting,
  and the rows of [TRACEABILITY.md](plans/TRACEABILITY.md) for the PRD requirements it touches.
- Code that matches its neighbours. Read the module you change and follow its style.

## Writing

User-facing text (the web app, the Mac app, the docs) uses plain sentences. Do not use em or en
dashes, or a hyphen as a pause: write two sentences, or use a comma, a colon or parentheses.

## Commits

Small commits, each one logical change. The subject is an imperative sentence in sentence case,
with the PRD IDs it touches in parentheses, for example
`Open Bot to Bot notifications in that chat under the Bot (N1, N2)`. The body says why.

## Releases

Releases are tag driven. One `v<version>` tag publishes the server, computer and sandbox firewall
images, builds the Mac app and makes a GitHub Release with the DMG, the compose bundle and the
image archives (`.github/workflows/release.yml`). CI derives the version from the tag and stamps
the build checkouts, so no version bump commit is needed. See
[apps/desktop/RELEASING.md](../apps/desktop/RELEASING.md) for the steps.

## Contribution licenses

Contributions to the core are under Apache License 2.0. Contributions to `ee/`
or `apps/mobile/` require a contributor license agreement assigning or licensing
rights to Daniel Pang before acceptance.
