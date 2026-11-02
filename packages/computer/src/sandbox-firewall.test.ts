import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// docker/sandbox-firewall.sh (S-17, plan 9.5) run for real with `--once`, but
// against a stand-in `iptables-nft` that records each call and reports a
// DOCKER-USER chain. No Docker host here: this checks which rules the script
// adds and in what order, not what the kernel does with them.

const SCRIPT = fileURLToPath(new URL('../../../docker/sandbox-firewall.sh', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'sandbox-firewall-'));
const log = path.join(dir, 'calls');
writeFileSync(
  path.join(dir, 'iptables-nft'),
  `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "-w -S FORWARD") echo "-A FORWARD -j DOCKER-USER" ;;
  *" -C "*) exit 1 ;;
esac
exit 0
`,
);
chmodSync(path.join(dir, 'iptables-nft'), 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(env: Record<string, string> = {}, { keepLog = false } = {}) {
  if (!keepLog) rmSync(log, { force: true });
  const result = spawnSync('sh', [SCRIPT, '--once'], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, ...env },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    // Refused before touching iptables.
  }
  const forwardChain = /chains (\S+) and/.exec(result.stdout)?.[1] ?? 'OPENBOTS-SANDBOX';
  const rules = (chain: string) =>
    calls
      .filter((c) => c.startsWith(`-w -A ${chain} `))
      .map((c) => c.slice(`-w -A ${chain} `.length));
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    forward: rules(forwardChain),
    input: rules(`${forwardChain}-IN`),
    rules,
  };
}

const PROXY_ACCEPT = '-d 172.30.255.3 -p tcp --dport 8888 -j ACCEPT';
const PROXY_INPUT = '-d 172.30.255.3 -p tcp --dport 8888 -j RETURN';

describe('sandbox firewall (S-17)', () => {
  it('lets the server reach the agents, and drops the bridge, private ranges and the host', () => {
    const { status, stdout, forward, input, calls } = run();
    expect(status).toBe(0);
    expect(stdout).toContain('rules applied with iptables-nft');
    expect(forward).toEqual([
      '-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
      '-s 172.30.255.2 -o openbots-sbx -d 172.30.255.0/24 -p tcp --dport 7070 -j ACCEPT',
      '-s 172.30.255.2 -j RETURN',
      '-o openbots-sbx -j DROP',
      '-p udp --dport 53 -j RETURN',
      '-p tcp --dport 53 -j RETURN',
      ...[
        '169.254.0.0/16',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '100.64.0.0/10',
        '127.0.0.0/8',
        '0.0.0.0/8',
        '224.0.0.0/4',
      ].map((net) => `-d ${net} -j DROP`),
    ]);
    expect(input).toEqual([
      '-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
      '-s 172.30.255.2 -j RETURN',
      '-p udp --dport 53 -j RETURN',
      '-p tcp --dport 53 -j RETURN',
      '-j DROP',
    ]);
    expect(calls).toContain('-w -I DOCKER-USER -i openbots-sbx -j OPENBOTS-SANDBOX');
    expect(calls).toContain('-w -I INPUT -i openbots-sbx -j OPENBOTS-SANDBOX-IN');
  });

  describe('with an egress proxy (plan 9.5)', () => {
    it('lets computers reach the proxy address and port only, before any drop', () => {
      const { status, stdout, forward, input } = run({
        OPENBOTS_SANDBOX_EGRESS_PROXY: 'http://172.30.255.3:8888',
      });
      expect(status).toBe(0);
      expect(stdout).toContain('egress proxy 172.30.255.3:8888)');
      // ACCEPT ahead of the bridge drop, so a proxy on the sandbox network
      // (or any private address) is reachable; Docker's icc rule comes later.
      const accept = forward.indexOf(PROXY_ACCEPT);
      expect(accept).toBeGreaterThan(forward.indexOf('-s 172.30.255.2 -j RETURN'));
      expect(accept).toBeLessThan(forward.indexOf('-o openbots-sbx -j DROP'));
      expect(forward.filter((r) => r.includes('172.30.255.3'))).toEqual([PROXY_ACCEPT]);
      // A proxy on the Docker host itself.
      expect(input.indexOf(PROXY_INPUT)).toBeGreaterThan(-1);
      expect(input.indexOf(PROXY_INPUT)).toBeLessThan(input.indexOf('-j DROP'));
      // Private ranges stay dropped for everything else.
      expect(forward).toContain('-d 172.16.0.0/12 -j DROP');
      expect(forward.some((r) => r.startsWith('!'))).toBe(false);
    });

    it.each([
      ['credentials and a trailing slash', 'http://bot:secret@172.30.255.3:8888/'],
      ['https', 'https://172.30.255.3:8888'],
    ])('reads the address from a URL with %s', (_, url) => {
      const { status, forward } = run({ OPENBOTS_SANDBOX_EGRESS_PROXY: url });
      expect(status).toBe(0);
      expect(forward).toContain(PROXY_ACCEPT);
    });

    it('adds no exception for a proxy given by name, and says so', () => {
      const { status, stderr, forward, input } = run({
        OPENBOTS_SANDBOX_EGRESS_PROXY: 'http://proxy.example.com:3128',
      });
      expect(status).toBe(0);
      expect(stderr).toContain('no exception is added');
      expect(forward.some((r) => r.includes('3128'))).toBe(false);
      expect(input.some((r) => r.includes('3128'))).toBe(false);
    });

    it.each([
      ['no port', 'http://172.30.255.3'],
      ['no scheme', '172.30.255.3:8888'],
      ['a port out of range', 'http://172.30.255.3:70000'],
      ['a port that is not a number', 'http://172.30.255.3:http'],
    ])('refuses a proxy URL with %s before touching iptables', (_, url) => {
      const { status, stderr, calls } = run({ OPENBOTS_SANDBOX_EGRESS_PROXY: url });
      expect(status).toBe(1);
      expect(stderr).toContain('OPENBOTS_SANDBOX_EGRESS_PROXY must look like');
      expect(calls).toEqual([]);
    });

    it('drops every other connection with OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY, DNS and the proxy aside', () => {
      const { status, stdout, forward } = run({
        OPENBOTS_SANDBOX_EGRESS_PROXY: 'http://172.30.255.3:8888',
        OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY: 'true',
      });
      expect(status).toBe(0);
      expect(stdout).toContain('egress proxy 172.30.255.3:8888 only)');
      const only = forward.indexOf('! -s 172.30.255.3 -j DROP');
      expect(only).toBeGreaterThan(forward.indexOf('-p tcp --dport 53 -j RETURN'));
      expect(only).toBeGreaterThan(forward.indexOf(PROXY_ACCEPT));
      // Before the private range drops, which still apply to the proxy's own traffic.
      expect(only).toBeLessThan(forward.indexOf('-d 169.254.0.0/16 -j DROP'));
    });

    it.each([
      {
        when: 'without a proxy',
        proxy: '',
        only: 'true',
        message: 'needs OPENBOTS_SANDBOX_EGRESS_PROXY',
      },
      {
        when: 'with a proxy given by name',
        proxy: 'http://proxy.example.com:3128',
        only: 'true',
        message: "needs the proxy's IPv4 address",
      },
      {
        when: 'set to something other than true or false',
        proxy: 'http://172.30.255.3:8888',
        only: 'yes',
        message: 'must be true or false',
      },
    ])('refuses OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY $when', ({ proxy, only, message }) => {
      const { status, stderr, calls } = run({
        OPENBOTS_SANDBOX_EGRESS_PROXY: proxy,
        OPENBOTS_SANDBOX_EGRESS_PROXY_ONLY: only,
      });
      expect(status).toBe(1);
      expect(stderr).toContain(message);
      expect(calls).toEqual([]);
    });
  });
});

// The Mac app's stack beside a source checkout's: one firewall per stack, on
// one Docker host, each with its own bridge, subnet and server address.
const APP = {
  OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox-254',
  OPENBOTS_SANDBOX_BRIDGE: 'openbots-a-254',
  OPENBOTS_SANDBOX_SUBNET: '172.30.254.0/24',
  OPENBOTS_SANDBOX_SERVER_IP: '172.30.254.2',
};

describe('sandbox firewall per sandbox network (two stacks on one host)', () => {
  it('names its chains after the bridge and matches only that bridge and subnet', () => {
    const { status, stdout, forward, input, calls } = run(APP);
    expect(status).toBe(0);
    expect(stdout).toContain('bridge openbots-a-254, chains OB-OPENBOTS-A-254 and');
    expect(forward.slice(0, 4)).toEqual([
      '-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
      '-s 172.30.254.2 -o openbots-a-254 -d 172.30.254.0/24 -p tcp --dport 7070 -j ACCEPT',
      '-s 172.30.254.2 -j RETURN',
      '-o openbots-a-254 -j DROP',
    ]);
    expect(input).toContain('-s 172.30.254.2 -j RETURN');
    expect(calls).toContain('-w -I DOCKER-USER -i openbots-a-254 -j OB-OPENBOTS-A-254');
    expect(calls).toContain('-w -I INPUT -i openbots-a-254 -j OB-OPENBOTS-A-254-IN');
    // Nothing of the default stack's.
    expect(calls.some((c) => /openbots-sbx|OPENBOTS-SANDBOX|172\.30\.255\./.test(c))).toBe(false);
  });

  it('names the bridge like the network when OPENBOTS_SANDBOX_BRIDGE is unset', () => {
    const { status, calls } = run({ OPENBOTS_SANDBOX_NETWORK: 'openbots-dev' });
    expect(status).toBe(0);
    expect(calls).toContain('-w -I DOCKER-USER -i openbots-dev -j OB-OPENBOTS-DEV');
  });

  it("leaves the other stack's chains and jumps alone, in either order", () => {
    run();
    const { calls } = run(APP, { keepLog: true });
    const [first, second] = [
      calls.slice(0, calls.lastIndexOf('-w -S FORWARD')),
      calls.slice(calls.lastIndexOf('-w -S FORWARD')),
    ];
    const touches = (call: string, chain: string) =>
      new RegExp(`^-w -[NFACI] ${chain}( |$)`).test(call) || call.endsWith(`-j ${chain}`);
    // Each run creates, flushes and fills only its own pair of chains, and
    // its jumps match only its own bridge.
    for (const [own, other, bridge] of [
      [first, 'OB-OPENBOTS-A-254', 'openbots-sbx'],
      [second, 'OPENBOTS-SANDBOX', 'openbots-a-254'],
    ] as const) {
      expect(own.filter((c) => touches(c, other) || touches(c, `${other}-IN`))).toEqual([]);
      const jumps = own.filter((c) => / -I (DOCKER-USER|INPUT) /.test(c));
      expect(jumps).toHaveLength(2);
      expect(jumps.every((c) => c.includes(` -i ${bridge} `))).toBe(true);
    }
  });

  it.each([
    ['a network name too long for a bridge', { OPENBOTS_SANDBOX_NETWORK: 'openbots-app-sandbox' }],
    ['a bridge name too long', { OPENBOTS_SANDBOX_BRIDGE: 'openbots-sandbox-2' }],
    ["iptables' wildcard", { OPENBOTS_SANDBOX_BRIDGE: 'openbots+' }],
    ['upper case', { OPENBOTS_SANDBOX_BRIDGE: 'DOCKER-USER' }],
    ['a leading dash', { OPENBOTS_SANDBOX_BRIDGE: '-j' }],
  ])('refuses %s before touching iptables', (_, env) => {
    const { status, stderr, calls } = run(env);
    expect(status).toBe(1);
    expect(stderr).toContain('OPENBOTS_SANDBOX_BRIDGE must be a bridge name');
    expect(calls).toEqual([]);
  });

  it("cannot name a chain after one of Docker's", () => {
    const { status, calls } = run({ OPENBOTS_SANDBOX_BRIDGE: 'docker-user' });
    expect(status).toBe(0);
    expect(calls).toContain('-w -I DOCKER-USER -i docker-user -j OB-DOCKER-USER');
    expect(calls.some((c) => /^-w -[NF] DOCKER-USER$/.test(c))).toBe(false);
  });
});
