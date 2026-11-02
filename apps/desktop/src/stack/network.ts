import { envValue, setEnvValue } from './env.js';

// The sandbox network of the Mac app's stack (plan 9.5, 14.4). A source
// checkout's stack uses openbots-sbx on 172.30.255.0/24, the defaults in
// docker/docker-compose.yml. The app's stack gets a network of its own, on a
// free /24 from APP_SUBNETS, so the two can run side by side on one Mac
// (OPENBOTS_SANDBOX_NETWORK in .env.example).

/** The compose defaults, which a stack without these keys in `.env` runs on. */
export const DEFAULT_SANDBOX = {
  network: 'openbots-sbx',
  subnet: '172.30.255.0/24',
} as const;

/**
 * Where the app picks its subnet: 172.30.254.0/24 down to 172.30.1.0/24, the
 * first one no Docker network on this Mac overlaps. Inside 172.30.0.0/16,
 * which the compose file leaves out of TRUSTED_PROXIES, and never
 * 172.30.255.0/24, which a source checkout's stack takes when it starts.
 */
export const APP_SUBNETS = { prefix: '172.30', first: 254, last: 1 } as const;

/** The `.env` keys that place a stack's sandbox network. */
export const SANDBOX_KEYS = [
  'OPENBOTS_SANDBOX_NETWORK',
  'OPENBOTS_SANDBOX_BRIDGE',
  'OPENBOTS_SANDBOX_SUBNET',
  'OPENBOTS_SANDBOX_SERVER_IP',
  'OPENBOTS_SANDBOX_EGRESS_PROXY_IP',
] as const;

export interface SandboxChoice {
  network: string;
  /** Its bridge on the Docker host: at most 15 characters. */
  bridge: string;
  subnet: string;
  /** The server's fixed address on it (.2), which the sandbox firewall lets through. */
  serverIp: string;
  /** The `egress` profile's proxy (.3). */
  proxyIp: string;
}

/**
 * The app's network on 172.30.<octet>.0/24, named after it so a new choice never
 * reuses a name. Its bridge is `openbots-a-<octet>` ("a" for the app), within
 * the 15 characters a bridge name may have.
 */
export function appSandbox(octet: number): SandboxChoice {
  const net = `${APP_SUBNETS.prefix}.${octet}`;
  return {
    network: `openbots-app-sandbox-${octet}`,
    bridge: `openbots-a-${octet}`,
    subnet: `${net}.0/24`,
    serverIp: `${net}.2`,
    proxyIp: `${net}.3`,
  };
}

export interface DockerNetwork {
  name: string;
  subnets: string[];
}

/** `docker network inspect` with NETWORK_FORMAT: a name and its subnets per line. */
export function parseNetworks(stdout: string): DockerNetwork[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([name]) => name)
    .map(([name, ...subnets]) => ({ name: name!, subnets }));
}

/** An IPv4 CIDR as its first address and size, or null for anything else (IPv6). */
function ipv4Range(cidr: string): { start: number; size: number } | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(cidr.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const bits = match[5] == null ? 32 : Number(match[5]);
  if (octets.some((o) => o > 255) || bits > 32) return null;
  const address = octets.reduce((n, o) => n * 256 + o, 0);
  const size = 2 ** (32 - bits);
  return { start: Math.floor(address / size) * size, size };
}

/** Two IPv4 ranges share an address; never for IPv6. */
export function overlaps(a: string, b: string): boolean {
  const x = ipv4Range(a);
  const y = ipv4Range(b);
  if (!x || !y) return false;
  return x.start < y.start + y.size && y.start < x.start + x.size;
}

/**
 * The app's network on the first /24 of APP_SUBNETS that no existing network
 * overlaps, whose names are not taken, and that is not in `avoid` (the
 * subnet a stack is leaving); null when every one is in use.
 */
export function chooseSandbox(
  existing: DockerNetwork[],
  avoid: string[] = [],
): SandboxChoice | null {
  const taken = [...existing.flatMap((n) => n.subnets), ...avoid];
  const names = new Set(existing.map((n) => n.name));
  for (let octet = APP_SUBNETS.first; octet >= APP_SUBNETS.last; octet--) {
    const choice = appSandbox(octet);
    if (names.has(choice.network)) continue;
    if (taken.some((subnet) => overlaps(subnet, choice.subnet))) continue;
    return choice;
  }
  return null;
}

/**
 * Puts the stack on `choice`. An egress proxy URL that pointed at the old
 * network's proxy address follows it to the new one.
 */
export function withSandbox(env: string, choice: SandboxChoice): string {
  const oldProxyIp = envValue(env, 'OPENBOTS_SANDBOX_EGRESS_PROXY_IP')?.trim();
  let next = env;
  next = setEnvValue(next, 'OPENBOTS_SANDBOX_NETWORK', choice.network);
  next = setEnvValue(next, 'OPENBOTS_SANDBOX_BRIDGE', choice.bridge);
  next = setEnvValue(next, 'OPENBOTS_SANDBOX_SUBNET', choice.subnet);
  next = setEnvValue(next, 'OPENBOTS_SANDBOX_SERVER_IP', choice.serverIp);
  next = setEnvValue(next, 'OPENBOTS_SANDBOX_EGRESS_PROXY_IP', choice.proxyIp);
  const proxy = envValue(next, 'OPENBOTS_SANDBOX_EGRESS_PROXY')?.trim();
  if (proxy && oldProxyIp) {
    const moved = proxy.replace(
      new RegExp(`^(https?://(?:[^/@]+@)?)${oldProxyIp.replace(/\./g, '\\.')}(:\\d+/?)$`),
      `$1${choice.proxyIp}$2`,
    );
    if (moved !== proxy) next = setEnvValue(next, 'OPENBOTS_SANDBOX_EGRESS_PROXY', moved);
  }
  return next;
}

/** The network a stack's `.env` names, or null when it names none (compose's default). */
export function envNetwork(env: string): string | null {
  return envValue(env, 'OPENBOTS_SANDBOX_NETWORK')?.trim() || null;
}

/** Whether `docker container ls` with NETWORKS_FORMAT lists a container of `projectDir` on `network`. */
export function containersOnNetwork(
  stdout: string,
  network: string,
  ownDir: (dir: string) => boolean,
): boolean {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .some(
      ([dir, networks]) =>
        dir != null &&
        dir.trim() !== '' &&
        ownDir(dir.trim()) &&
        (networks ?? '')
          .split(',')
          .map((n) => n.trim())
          .includes(network),
    );
}
