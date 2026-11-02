import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` writes a new migration under ./drizzle from the schema.
// The first migration is hand-prefixed with `CREATE EXTENSION IF NOT EXISTS vector`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
