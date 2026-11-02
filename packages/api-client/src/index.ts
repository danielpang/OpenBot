import { packageName } from '@openbots/shared';

export const PACKAGE_NAME = packageName('api-client');
export * from './ws.js';

export { createClient, unwrap, ApiError, type Client, type Problem } from './client.js';
export { createAuthClient, type AuthClient, type SocialProvider } from './auth.js';
export type { components, paths } from './schema.js';
