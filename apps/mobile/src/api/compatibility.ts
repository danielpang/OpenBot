export const OLDEST_SERVER_VERSION = '0.0.0';
export function serverCompatibility(
  version: unknown,
  oldest = OLDEST_SERVER_VERSION,
): 'supported' | 'update' | 'unknown' {
  if (typeof version !== 'string') return 'unknown';
  const parse = (text: string) =>
    /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/.exec(text)?.slice(1).map(Number);
  const found = parse(version),
    minimum = parse(oldest);
  if (!found || !minimum) return 'unknown';
  for (let i = 0; i < 3; i++) {
    if (found[i]! < minimum[i]!) return 'update';
    if (found[i]! > minimum[i]!) return 'supported';
  }
  return 'supported';
}
