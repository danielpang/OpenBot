# ee: OpenBots Enterprise Edition

Code for the managed OpenBots service lives here: organizations and admin
features, and later billing and Stripe, and anything else that is not part
of self-hosted OpenBots.

Everything in this directory is proprietary and covered by
[ee/LICENSE](LICENSE). The core is under the Apache License 2.0
in the root [LICENSE](../LICENSE). The mobile app is proprietary and
source-visible under [apps/mobile/LICENSE](../apps/mobile/LICENSE).

Rules for code here:

- The core (`apps/` except `apps/mobile/`, and `packages/`) never imports from `ee/`. Enterprise code
  plugs into the core through its extension points, so self-hosted OpenBots
  builds and runs without this directory. `node scripts/check-licenses.mjs`
  checks both.
- Enterprise code runs only when `OPENBOTS_DEPLOYMENT=managed`.
- Each package is private, says `"license": "SEE LICENSE IN LICENSE"`, and
  keeps a copy of `ee/LICENSE` beside its `package.json`.

## Packages

- `server` (`@openbots/ee-server`): the managed server. `src/main.ts` runs the
  core server (`runServer` from `@openbots/server/server`) with organizations:
  better-auth's organization plugin on the core's tables, roles, invitations,
  email verification and invite email through Resend, and the
  `/api/v1/organizations`, `/api/v1/organization` and `/api/v1/invitations`
  routes. Its image is `server/Dockerfile`.
- `web` (`@openbots/ee-web`): the managed web app. `src/main.tsx` starts the
  core web app (`startWeb` from `@openbots/web/start`) with onboarding, the
  organization switcher and the organization's settings.

See section 21 of [docs/plans/TECHNICAL_PLAN.md](../docs/plans/TECHNICAL_PLAN.md).

## Running it

```sh
pnpm build
OPENBOTS_DEPLOYMENT=managed OPENBOTS_SIGNUP_MODE=open OPENBOTS_DEV_LOG_EMAIL_LINKS=1 \
  node ee/server/dist/main.js
```

Without `RESEND_API_KEY` and `OPENBOTS_EMAIL_FROM` no email is sent: invite
links are there to copy, and with `OPENBOTS_DEV_LOG_EMAIL_LINKS=1` (never in
production) the 6-digit email verification code is in the server's log. For the web
app with hot reload, `pnpm --filter @openbots/ee-web dev` proxies to the
server on :3000.

After changing a route, regenerate the document and the web types:

```sh
pnpm --filter @openbots/ee-server openapi
pnpm exec prettier --write ee/server/openapi.json
pnpm --filter @openbots/ee-web generate
```
