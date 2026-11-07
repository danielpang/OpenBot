import { readFileSync } from 'node:fs';

// Secrets from files (S-1). Each variable below may instead be given as
// NAME_FILE, the path of a file holding the value: a compose or Kubernetes
// secret, say. A process's /proc/<pid>/environ always shows the environment it
// started with, and `docker inspect` shows the container's, so a value read
// from a file is in neither. docker/entrypoint.sh turns these variables into
// such files before it starts the server, so its list must match this one
// (env-files.test.ts checks).

export const SECRET_ENV_VARS = [
  'OPENBOTS_MASTER_KEY',
  'OPENBOTS_MASTER_KEY_PREVIOUS',
  'DATABASE_URL',
  'OPENBOTS_DB_APP_PASSWORD',
  'REDIS_URL',
  'OPENBOTS_COMPUTER_AGENT_TOKEN',
  'OPENBOTS_METRICS_TOKEN',
  'OPENBOTS_LOCAL_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_WEBHOOK_SECRET',
] as const;

export interface ResolvedEnv {
  /** The environment with every NAME_FILE read into NAME. */
  env: NodeJS.ProcessEnv;
  /** Secrets that came from the plain environment, not from a file. */
  fromEnvironment: string[];
}

/**
 * Reads each NAME_FILE into NAME. Throws when a file cannot be read or when
 * both NAME and NAME_FILE are set, as either could be the one meant. Trailing
 * whitespace (the newline an editor adds) is dropped.
 */
export function resolveSecretFiles(
  env: NodeJS.ProcessEnv,
  names: readonly string[] = SECRET_ENV_VARS,
): ResolvedEnv {
  const resolved: NodeJS.ProcessEnv = { ...env };
  const fromEnvironment: string[] = [];
  const problems: string[] = [];
  for (const name of names) {
    const file = env[`${name}_FILE`];
    const value = env[name];
    if (!file) {
      if (value) fromEnvironment.push(name);
      continue;
    }
    if (value) {
      problems.push(`  ${name}: set either ${name} or ${name}_FILE, not both`);
      continue;
    }
    try {
      resolved[name] = readFileSync(file, 'utf8').trimEnd();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? String(err);
      problems.push(`  ${name}_FILE: cannot read ${file} (${code})`);
    }
  }
  if (problems.length) throw new Error(`invalid configuration:\n${problems.join('\n')}`);
  return { env: resolved, fromEnvironment };
}

/** One secret, from NAME or NAME_FILE (for CLIs that need just one, such as migrate-cli). */
export function secretFromEnv(
  name: (typeof SECRET_ENV_VARS)[number],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveSecretFiles(env, [name]).env[name] || undefined;
}
