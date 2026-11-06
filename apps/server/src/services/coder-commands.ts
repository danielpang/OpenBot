import { randomUUID } from 'node:crypto';
import type { ComputerAgentClient } from '@openbots/computer';
import type { CoderAgent } from '@openbots/shared';
import { adapterFor } from './coder-adapters/index.js';
import { stripAnsi } from './coder-adapters/common.js';

// One-off commands as `coder` over WS /coder, for the short jobs around the
// sessions: the CLI's version, a sign-in check, signing out, removing a
// worktree.

/** `<cli> --version` on the computer, its first line. */
export async function coderVersion(
  agent: ComputerAgentClient,
  agentName: CoderAgent,
): Promise<string | null> {
  const adapter = adapterFor(agentName);
  const { code, stdout } = await runAsCoder(agent, adapter.command, adapter.versionArgs);
  if (code !== 0) return null;
  const line = stripAnsi(stdout).trim().split('\n')[0]?.trim();
  return line ? line.slice(0, 100) : null;
}

/** How long a one-off command as `coder` (a version, a sign-out, a discard) may take. */
const COMMAND_MS = 60_000;

/** Runs one command as `coder` and collects its output, capped at `maxBytes`. */
export function runAsCoder(
  agent: ComputerAgentClient,
  command: string,
  args: string[],
  { env = {}, maxBytes = 2_000_000 }: { env?: Record<string, string>; maxBytes?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const keep = (current: string, data: string) =>
      current.length >= maxBytes ? current : (current + data).slice(0, maxBytes);
    const timer = setTimeout(() => {
      void opened.then((p) => p.close()).catch(() => {});
    }, COMMAND_MS);
    const opened = agent.coder(
      {
        session_id: randomUUID(),
        user: 'coder',
        command,
        args,
        env,
        git_credentials: false,
      },
      {
        stdout: (d) => (stdout = keep(stdout, d)),
        stderr: (d) => (stderr = keep(stderr, d)),
        credentialRequest: () => {},
        permissionRequest: () => {},
        exit: (info) => {
          clearTimeout(timer);
          void opened.then((p) => p.close()).catch(() => {});
          resolve({
            code: info.code,
            stdout,
            stderr,
            ...(info.error ? { error: info.error } : {}),
          });
        },
      },
    );
    opened.catch((error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
