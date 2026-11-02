import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './context.js';
import { ProblemSchema } from './errors.js';

/**
 * A route-file sub-app. Request validation failures are thrown so the app's
 * error handler renders them as problem documents like every other error.
 */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });
}

/** Security requirement for routes behind `requireUser`: a session cookie or an API key. */
export const authenticated: { [scheme: string]: string[] }[] = [{ session: [] }, { apiKey: [] }];

export function problemResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: ProblemSchema } } };
}

export const authProblems = {
  401: problemResponse('Not signed in'),
};

export const adminProblems = {
  401: problemResponse('Not signed in'),
  403: problemResponse('Not an admin'),
};

/** Members, invites and the audit log: managed only (`requireManaged`), then admins only. */
export const managedProblems = {
  ...adminProblems,
  404: problemResponse('Not on a self-hosted install'),
};

export const OPENAPI_PATH = '/api/v1/openapi.json';

export function openApiDocument(
  app: OpenAPIHono<AppEnv>,
): ReturnType<OpenAPIHono['getOpenAPI31Document']> {
  app.openAPIRegistry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'better-auth.session_token',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'An API key from `POST /api/v1/api-keys`',
  });
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'OpenBots API',
      version: '0.0.0',
      description: 'Accounts and sessions live under `/api/auth/*` (better-auth).',
    },
  });
}
