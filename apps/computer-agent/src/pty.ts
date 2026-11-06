// node-pty, shared by the terminal (`WS /pty`, ws.ts) and the coding
// sessions that run under a pseudo-terminal (`WS /coder` with `pty`, coder.ts).

/** The part of node-pty's API used here, so typecheck does not need it installed. */
export interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): Pty;
}

export interface Pty {
  /** The child's pid, which is also its process group's: node-pty starts it in a new session. */
  pid?: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

// Typed as string, not a literal, so tsc does not try to resolve it.
const NODE_PTY: string = 'node-pty';
let ptyModule: Promise<NodePty | undefined> | undefined;

/**
 * node-pty, or undefined where it is not installed or its native binding did
 * not build. It is an optional dependency so a checkout without a C++
 * toolchain still installs; the image build checks that it loads.
 */
export function loadPty(): Promise<NodePty | undefined> {
  ptyModule ??= import(NODE_PTY).then(
    (m: NodePty) => m,
    () => undefined,
  );
  return ptyModule;
}
