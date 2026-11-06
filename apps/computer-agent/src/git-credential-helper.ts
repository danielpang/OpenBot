import { realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { CODER_CREDENTIAL_SOCKET_ENV, CODER_SESSION_ENV } from './coder-paths.js';

// openbots-git-credential (I5): git's credential helper in the computer.
// docker/computer.Dockerfile installs it system-wide as `credential.helper`,
// and a session with git credentials sets it again through the environment
// (GIT_CONFIG_COUNT, coder-paths.ts `gitConfigEnv`) after clearing any other
// helper, so a repository's own config cannot replace it. The image installs
// it as a shell wrapper at /usr/local/bin/openbots-git-credential that runs
// this file with the runtime's node. git runs it as
// `openbots-git-credential get` with
// `protocol=`, `host=`, `path=` and `username=` lines on stdin; it writes
// them, as one JSON line with the session's secret from
// OPENBOTS_CODER_SESSION, to the session's unix socket
// (OPENBOTS_CODER_CREDENTIAL_SOCKET, coder.ts), and prints the `username=`
// and `password=` lines of the JSON line that comes back. It answers
// nothing, and exits 0, for anything else (no session, a refusal, an agent
// that is not there): git then asks the next helper, of which there is none,
// and the fetch or push fails for want of a credential. `store` and `erase`
// are no-ops: the token lives in this process for one git call and nowhere
// else. Nothing is logged.

/** git's fields, from `key=value` lines up to a blank line or the end. */
export function parseCredentialInput(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const clean = line.replace(/\r$/, '');
    if (clean === '') break;
    const eq = clean.indexOf('=');
    if (eq <= 0) continue;
    const key = clean.slice(0, eq);
    // Multi-valued keys (`wwwauth[]`, `capability[]`) are not needed here.
    if (key.endsWith('[]')) continue;
    fields[key] = clean.slice(eq + 1);
  }
  return fields;
}

/** A value git could not take back on one line, or one that would add a field. */
const unsafe = (value: string) => /[\n\r\0]/.test(value);

export interface CredentialGetOptions {
  env?: NodeJS.ProcessEnv;
  /** Longer than the agent's own wait on the server (30 s). */
  timeoutMs?: number;
}

/** One JSON line to the socket at `file`, and the first line it writes back. */
function ask(file: string, line: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = connect(file, () => conn.write(line));
    let reply = '';
    const timer = setTimeout(() => conn.destroy(new Error('timed out')), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      reply += chunk;
      if (reply.length > 64_000) conn.destroy(new Error('too long'));
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.on('close', () => {
      clearTimeout(timer);
      const nl = reply.indexOf('\n');
      resolve(nl < 0 ? reply : reply.slice(0, nl));
    });
  });
}

/**
 * The answer to git's `get` for `fields`: the lines to print, or '' when
 * there is none to give.
 */
export async function credentialGet(
  fields: Record<string, string>,
  { env = process.env, timeoutMs = 40_000 }: CredentialGetOptions = {},
): Promise<string> {
  const secret = env[CODER_SESSION_ENV];
  const socket = env[CODER_CREDENTIAL_SOCKET_ENV];
  if (!secret || !socket || !fields.protocol || !fields.host) return '';
  try {
    const line = await ask(
      socket,
      `${JSON.stringify({
        secret,
        protocol: fields.protocol,
        host: fields.host,
        ...(fields.path !== undefined ? { path: fields.path } : {}),
        ...(fields.username !== undefined ? { username: fields.username } : {}),
      })}\n`,
      timeoutMs,
    );
    const body = JSON.parse(line) as { username?: unknown; password?: unknown };
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') return '';
    if (unsafe(username) || unsafe(password)) return '';
    return `username=${username}\npassword=${password}\n`;
  } catch {
    return '';
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The helper's whole run: git's operation in `argv[2]`, its fields on stdin. */
export async function main(argv = process.argv): Promise<void> {
  const input = await readStdin();
  if (argv[2] !== 'get') return;
  const out = await credentialGet(parseCredentialInput(input));
  if (out) process.stdout.write(out);
}

const invoked = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (invoked) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
