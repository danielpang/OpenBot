import { describe, expect, it } from 'vitest';
import {
  acceptClient,
  authenticateToServer,
  ByteReader,
  vncAuthResponse,
  vncPassword,
} from './rfb.js';

const challenge = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

describe('VNC authentication (S-7)', () => {
  it('answers a challenge as DES does, with the key bits reversed', () => {
    // openssl enc -des-ecb -K ceccc64ecc2e841e -nopad (the key is "s3cr3t!x" reversed bitwise)
    expect(vncAuthResponse('s3cr3t!x', challenge).toString('hex')).toBe(
      'beb4e613e3ad9604ef1ad81a3b353cce',
    );
    // VNC reads 8 characters.
    expect(vncAuthResponse('s3cr3t!xyz', challenge)).toEqual(
      vncAuthResponse('s3cr3t!x', challenge),
    );
  });

  it('makes a fresh 8-character password each time', () => {
    const passwords = new Set(Array.from({ length: 50 }, vncPassword));
    expect(passwords.size).toBe(50);
    for (const p of passwords) expect(p).toMatch(/^[\w-]{8}$/);
  });

  it('logs in to the server with the password', async () => {
    const server = new ByteReader();
    const sent: Buffer[] = [];
    const done = authenticateToServer(server, (b) => sent.push(b), 'pw123456');
    server.push(Buffer.from('RFB 003.008\n'));
    server.push(Buffer.from([2, 1, 2]));
    server.push(challenge);
    server.push(Buffer.from([0, 0, 0, 0]));
    await done;
    expect(sent.map((b) => b.toString('hex'))).toEqual([
      Buffer.from('RFB 003.008\n').toString('hex'),
      '02',
      vncAuthResponse('pw123456', challenge).toString('hex'),
    ]);
  });

  it('fails when the server refuses the password or offers no VNC authentication', async () => {
    const refused = new ByteReader();
    const login = authenticateToServer(refused, () => {}, 'wrong');
    refused.push(Buffer.from('RFB 003.008\n'));
    refused.push(Buffer.from([1, 2]));
    refused.push(challenge);
    refused.push(Buffer.from([0, 0, 0, 1, 0, 0, 0, 4]));
    refused.push(Buffer.from('nope'));
    await expect(login).rejects.toThrow('VNC handshake: nope');

    const open = new ByteReader();
    const noAuth = authenticateToServer(open, () => {}, 'pw');
    open.push(Buffer.from('RFB 003.008\n'));
    open.push(Buffer.from([1, 1]));
    await expect(noAuth).rejects.toThrow('offers types 1');
  });

  it('lets the client in without a password, for each RFB version', async () => {
    for (const [version, chosen, expected] of [
      ['RFB 003.008\n', [1], ['RFB 003.008\n', '0101', '00000000']],
      ['RFB 003.007\n', [1], ['RFB 003.008\n', '0101']],
      ['RFB 003.003\n', [], ['RFB 003.008\n', '00000001']],
    ] as const) {
      const client = new ByteReader();
      const sent: Buffer[] = [];
      const done = acceptClient(client, (b) => sent.push(b));
      client.push(Buffer.from(version));
      client.push(Buffer.from(chosen));
      await done;
      expect(sent.map((b, i) => (i === 0 ? b.toString() : b.toString('hex')))).toEqual(expected);
    }
  });
});
