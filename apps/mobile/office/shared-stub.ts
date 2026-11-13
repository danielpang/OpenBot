// Stands in for @openbots/shared in the office bundle. The avatars only need these two,
// and the real package builds every schema up front, which would triple the bundle.
// src/office/stubs.test.ts keeps the states in step with the real schema.
export function packageName(name: string): `@openbots/${string}` {
  return `@openbots/${name}`;
}
export const BotStateKindSchema = {
  options: ['idle', 'thinking', 'working', 'waiting', 'blocked', 'done'] as const,
};
