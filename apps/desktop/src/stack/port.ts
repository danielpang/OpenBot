import { connect, createServer } from 'node:net';

// The local stack's web port (plan 14.4). Compose publishes it on every
// interface, so a port is free only when nothing listens on it at all: a dev
// server on `*:3000` lets 127.0.0.1:3000 bind on macOS, and Docker's own
// forwarder on 127.0.0.1 lets 0.0.0.0 bind. So every address is tried, and a
// connection to 127.0.0.1 too.

/** The port a new stack tries first, and the start of the search. */
export const FIRST_PORT = 3000;
/** How many ports from FIRST_PORT the search tries. */
export const PORT_SEARCH_LIMIT = 100;

/** Answers whether nothing on this Mac listens on the port. */
export type PortCheck = (port: number) => Promise<boolean>;

/** An address this host does not have (no IPv6) is not a conflict. */
const NO_ADDRESS = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

function binds(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) =>
      resolve(NO_ADDRESS.has(error.code ?? '')),
    );
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function answers(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export const nodePortFree: PortCheck = async (port) => {
  for (const host of ['127.0.0.1', '0.0.0.0', '::']) {
    if (!(await binds(port, host))) return false;
  }
  return !(await answers(port));
};

/** The first free port from FIRST_PORT on, skipping `except`, or null when none is. */
export async function findFreePort(
  isFree: PortCheck,
  except: number[] = [],
): Promise<number | null> {
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_SEARCH_LIMIT; port++) {
    if (except.includes(port)) continue;
    if (await isFree(port)) return port;
  }
  return null;
}
