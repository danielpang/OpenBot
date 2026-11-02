// Reading and writing the stack's `.env` text (plan 14.4), line by line so
// the owner's comments and other settings stay as they are.

/** The value of `name` in a `.env` text (its last line wins, as in Compose), or undefined. */
export function envValue(env: string, name: string): string | undefined {
  let value: string | undefined;
  for (const line of env.split(/\r?\n/)) {
    if (line.startsWith(`${name}=`)) value = line.slice(name.length + 1);
  }
  return value;
}

/** Sets `name=value` on its own line, appending the line when it is missing; every other line stays. */
export function setEnvValue(env: string, name: string, value: string): string {
  const line = new RegExp(`^${name}=.*$`, 'gm');
  if (envValue(env, name) != null) return env.replace(line, () => `${name}=${value}`);
  const separator = env === '' || env.endsWith('\n') ? '' : '\n';
  return `${env}${separator}${name}=${value}\n`;
}
