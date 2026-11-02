import { describe, expect, it } from 'vitest';
import {
  appSandbox,
  APP_SUBNETS,
  chooseSandbox,
  containersOnNetwork,
  overlaps,
  parseNetworks,
  withSandbox,
} from './network.js';

describe('the app stack sandbox network', () => {
  it('names the network after its subnet, with a bridge name Linux takes', () => {
    for (let octet = APP_SUBNETS.first; octet >= APP_SUBNETS.last; octet--) {
      const choice = appSandbox(octet);
      expect(choice.bridge.length).toBeLessThanOrEqual(15);
      expect(choice.bridge).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
      expect(choice.subnet).toBe(`172.30.${octet}.0/24`);
      expect(choice.serverIp).toBe(`172.30.${octet}.2`);
    }
    expect(appSandbox(254)).toEqual({
      network: 'openbots-app-sandbox-254',
      bridge: 'openbots-a-254',
      subnet: '172.30.254.0/24',
      serverIp: '172.30.254.2',
      proxyIp: '172.30.254.3',
    });
  });

  it('reads network inspect output, networks without a subnet included', () => {
    expect(parseNetworks('bridge 192.168.215.0/24\nhost\nboth 10.1.0.0/16 fd00::/64\n\n')).toEqual([
      { name: 'bridge', subnets: ['192.168.215.0/24'] },
      { name: 'host', subnets: [] },
      { name: 'both', subnets: ['10.1.0.0/16', 'fd00::/64'] },
    ]);
  });

  it('tells overlapping IPv4 ranges, and ignores IPv6', () => {
    expect(overlaps('172.30.254.0/24', '172.30.254.0/24')).toBe(true);
    expect(overlaps('172.30.0.0/16', '172.30.254.0/24')).toBe(true);
    expect(overlaps('172.30.254.128/25', '172.30.254.0/24')).toBe(true);
    expect(overlaps('172.30.254.7', '172.30.254.0/24')).toBe(true);
    expect(overlaps('172.30.253.0/24', '172.30.254.0/24')).toBe(false);
    expect(overlaps('172.16.0.0/12', '172.30.254.0/24')).toBe(true);
    expect(overlaps('192.168.0.0/16', '172.30.254.0/24')).toBe(false);
    expect(overlaps('fd00::/8', '172.30.254.0/24')).toBe(false);
  });

  it('picks the first free /24 from 172.30.254.0 down, never the default 172.30.255.0', () => {
    expect(chooseSandbox([])?.subnet).toBe('172.30.254.0/24');
    expect(chooseSandbox([{ name: 'openbots-sbx', subnets: ['172.30.255.0/24'] }])?.subnet).toBe(
      '172.30.254.0/24',
    );
    expect(
      chooseSandbox([
        { name: 'a', subnets: ['172.30.254.0/24'] },
        { name: 'b', subnets: ['172.30.253.0/25'] },
      ])?.subnet,
    ).toBe('172.30.252.0/24');
    // A name in use is skipped though its subnet is free.
    expect(
      chooseSandbox([{ name: 'openbots-app-sandbox-254', subnets: ['10.0.0.0/24'] }])?.network,
    ).toBe('openbots-app-sandbox-253');
    expect(chooseSandbox([], ['172.30.254.0/24'])?.subnet).toBe('172.30.253.0/24');
    // Docker's whole default pool overlaps every one.
    expect(chooseSandbox([{ name: 'wide', subnets: ['172.16.0.0/12'] }])).toBeNull();
  });

  it('writes every key, keeps the rest, and moves a proxy URL that pointed at the old proxy', () => {
    const env = [
      '# mine',
      'OPENBOTS_SANDBOX_SUBNET=172.30.255.0/24',
      'OPENBOTS_SANDBOX_EGRESS_PROXY_IP=172.30.255.3',
      'OPENBOTS_SANDBOX_EGRESS_PROXY=http://bot:pw@172.30.255.3:8888/',
      '',
    ].join('\n');
    expect(withSandbox(env, appSandbox(250))).toBe(
      [
        '# mine',
        'OPENBOTS_SANDBOX_SUBNET=172.30.250.0/24',
        'OPENBOTS_SANDBOX_EGRESS_PROXY_IP=172.30.250.3',
        'OPENBOTS_SANDBOX_EGRESS_PROXY=http://bot:pw@172.30.250.3:8888/',
        'OPENBOTS_SANDBOX_NETWORK=openbots-app-sandbox-250',
        'OPENBOTS_SANDBOX_BRIDGE=openbots-a-250',
        'OPENBOTS_SANDBOX_SERVER_IP=172.30.250.2',
        '',
      ].join('\n'),
    );
    // A proxy elsewhere stays.
    const elsewhere =
      'OPENBOTS_SANDBOX_EGRESS_PROXY_IP=172.30.255.3\nOPENBOTS_SANDBOX_EGRESS_PROXY=http://10.0.0.5:3128\n';
    expect(withSandbox(elsewhere, appSandbox(250))).toContain(
      'OPENBOTS_SANDBOX_EGRESS_PROXY=http://10.0.0.5:3128\n',
    );
  });

  it("finds this install's containers on a network, by directory", () => {
    const listed = '/a/stack\topenbots-app_default,openbots-sbx\n/b/src\topenbots-sbx\n';
    const own = (dir: string) => dir === '/a/stack';
    expect(containersOnNetwork(listed, 'openbots-sbx', own)).toBe(true);
    expect(containersOnNetwork(listed, 'openbots-app_docker-api', own)).toBe(false);
    expect(containersOnNetwork('/b/src\topenbots-sbx\n', 'openbots-sbx', own)).toBe(false);
    expect(containersOnNetwork('', 'openbots-sbx', own)).toBe(false);
  });
});
