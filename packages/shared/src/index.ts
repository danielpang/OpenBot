export const PRODUCT_NAME = 'OpenBots';

export type PackageName = `@openbots/${string}`;

export function packageName(name: string): PackageName {
  return `@openbots/${name}`;
}

export * from './limits.js';
export * from './events.js';
export * from './notices.js';
export * from './queue.js';
export * from './bots.js';
export * from './parts.js';
export * from './providers.js';
export * from './policy.js';
export * from './artifacts.js';
export * from './computer.js';
export * from './coders.js';
export * from './coder-runtime.js';
export * from './routines.js';
export * from './skills.js';
export * from './webhooks.js';
export * from './git.js';
