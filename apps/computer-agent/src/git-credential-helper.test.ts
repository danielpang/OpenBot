import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialGet, parseCredentialInput } from './git-credential-helper.js';

describe('parseCredentialInput', () => {
  it("reads git's key=value lines up to the blank line", () => {
    expect(
      parseCredentialInput(
        'protocol=https\nhost=github.com\npath=acme/app.git\nusername=push\nwwwauth[]=Basic\n\nhost=ignored\n',
      ),
    ).toEqual({ protocol: 'https', host: 'github.com', path: 'acme/app.git', username: 'push' });
    expect(parseCredentialInput('protocol=https\r\nhost=a=b\r\nnot a field\n')).toEqual({
      protocol: 'https',
      host: 'a=b',
    });
  });
});

describe('credentialGet (I5)', () => {
  const fields = { protocol: 'https', host: 'github.com', path: 'acme/app.git' };
  const SECRET = 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0';

  let base: string;
  beforeEach(async () => {
    // The OS temp dir can be too deep for a socket path (macOS); /tmp is not.
    base = await realpath(await mkdtemp('/tmp/ob-cred-'));
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  /** A stand-in for the agent's credential socket: records each line, answers with `reply`. */
  async function relay(reply: string | ((line: string) => string)) {
    const file = path.join(base, 'credential.sock');
    const lines: unknown[] = [];
    const server = createServer((conn) => {
      conn.setEncoding('utf8');
      let buffer = '';
      conn.on('data', (d: string) => {
        buffer += d;
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        lines.push(JSON.parse(line));
        conn.end(typeof reply === 'string' ? reply : reply(line));
      });
    });
    await new Promise<void>((r) => server.listen(file, r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const env = { OPENBOTS_CODER_SESSION: SECRET, OPENBOTS_CODER_CREDENTIAL_SOCKET: file };
    return { file, lines, env };
  }
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it("writes git's question and the session's secret to its socket and prints the answer", async () => {
    const r = await relay('{"username":"x-access-token","password":"ghs_1"}\n');
    const out = await credentialGet({ ...fields, username: 'push' }, { env: r.env });
    expect(out).toBe('username=x-access-token\npassword=ghs_1\n');
    expect(r.lines).toEqual([
      {
        secret: SECRET,
        protocol: 'https',
        host: 'github.com',
        path: 'acme/app.git',
        username: 'push',
      },
    ]);
  });

  it('prints nothing for a refusal, no secret or socket, a missing agent or an answer git could misread', async () => {
    const denied = await relay('{"denied":"Push is not approved"}\n');
    expect(await credentialGet(fields, { env: denied.env })).toBe('');
    expect(await credentialGet(fields, { env: {} })).toBe('');
    expect(await credentialGet(fields, { env: { OPENBOTS_CODER_SESSION: SECRET } })).toBe('');
    expect(
      await credentialGet(fields, {
        env: { OPENBOTS_CODER_CREDENTIAL_SOCKET: denied.file },
      }),
    ).toBe('');
    expect(await credentialGet({ host: 'github.com' }, { env: denied.env })).toBe('');
    expect(denied.lines).toHaveLength(1);
    const gone = { ...denied.env, OPENBOTS_CODER_CREDENTIAL_SOCKET: path.join(base, 'none.sock') };
    expect(await credentialGet(fields, { env: gone })).toBe('');
  });

  it('prints nothing for an answer that would add a field, is not JSON, or never comes', async () => {
    const sneaky = await relay('{"username":"u","password":"p\\nhost=evil.example"}\n');
    expect(await credentialGet(fields, { env: sneaky.env })).toBe('');
    await rm(sneaky.file, { force: true });
    const garbage = await relay('nope\n');
    expect(await credentialGet(fields, { env: garbage.env })).toBe('');
    await rm(garbage.file, { force: true });
    const file = path.join(base, 'credential.sock');
    const held: Socket[] = [];
    const silent = createServer((conn) => void held.push(conn));
    await new Promise<void>((r) => silent.listen(file, r));
    cleanup.push(
      () =>
        new Promise<void>((r) => {
          held.forEach((c) => c.destroy());
          silent.close(() => r());
        }),
    );
    const env = { OPENBOTS_CODER_SESSION: SECRET, OPENBOTS_CODER_CREDENTIAL_SOCKET: file };
    expect(await credentialGet(fields, { env, timeoutMs: 50 })).toBe('');
  });
});
