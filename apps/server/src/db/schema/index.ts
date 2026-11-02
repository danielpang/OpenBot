// The full plan section 4 schema, one file per subsection (4.9, secrets, has no
// tables; see `secrets.ts`). After the first migration, change it only through
// new `drizzle-kit generate` migrations.
export * from './auth.js';
export * from './workspace.js';
export * from './bots.js';
export * from './chats.js';
export * from './runs.js';
export * from './tools.js';
export * from './computer.js';
export * from './prompts.js';
export * from './webhooks.js';
export * from './artifacts.js';
export * from './models.js';
