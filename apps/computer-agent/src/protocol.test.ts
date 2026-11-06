import { describe, expect, it } from 'vitest';
import {
  CoderClientMessageSchema,
  CoderStartSchema,
  GitCredentialRequestSchema,
  PtyOpenSchema,
} from './protocol.js';

// The WS /coder frames and the /pty query (I3, I5, I15): shapes only; the
// session itself is coder.ts's.

describe('coder protocol', () => {
  it('fills in the start defaults', () => {
    expect(
      CoderStartSchema.parse({ type: 'start', session_id: 'session-1', command: 'claude' }),
    ).toEqual({
      type: 'start',
      session_id: 'session-1',
      user: 'coder',
      command: 'claude',
      args: [],
      env: {},
      pty: false,
      git_credentials: true,
    });
  });

  it('refuses a short session id, an odd env name, unknown users and fields', () => {
    const start = { type: 'start', session_id: 'session-1', command: 'claude' };
    expect(CoderStartSchema.safeParse({ ...start, session_id: 'short' }).success).toBe(false);
    expect(CoderStartSchema.safeParse({ ...start, env: { 'A-B': 'x' } }).success).toBe(false);
    expect(CoderStartSchema.safeParse({ ...start, user: 'root' }).success).toBe(false);
    expect(CoderStartSchema.safeParse({ ...start, uid: 0 }).success).toBe(false);
    expect(CoderStartSchema.safeParse({ ...start, cols: 10 }).success).toBe(false);
  });

  it('parses every client frame', () => {
    for (const frame of [
      { type: 'stdin', data: 'hi' },
      { type: 'credential', request_id: 'c1', username: 'x-access-token', password: 't' },
      { type: 'credential', request_id: 'c1', denied: 'Push is not approved' },
      { type: 'answer', request_id: 'p1', decision: 'deny', message: 'The owner said no' },
      { type: 'signal', signal: 'SIGINT' },
      { type: 'resize', cols: 120, rows: 40 },
    ]) {
      expect(CoderClientMessageSchema.parse(frame)).toEqual(frame);
    }
    expect(CoderClientMessageSchema.safeParse({ type: 'signal', signal: 'SIGHUP' }).success).toBe(
      false,
    );
    expect(
      CoderClientMessageSchema.safeParse({ type: 'answer', request_id: 'p', decision: 'maybe' })
        .success,
    ).toBe(false);
  });

  it("parses the credential helper's request", () => {
    const secret = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdl';
    const req = { secret, protocol: 'https', host: 'github.com', path: 'a/b.git' };
    expect(GitCredentialRequestSchema.parse(req)).toEqual(req);
    expect(GitCredentialRequestSchema.safeParse({ ...req, token: 'x' }).success).toBe(false);
    // The server's session id is not the secret: a request must carry the secret.
    const { secret: _, ...bare } = req;
    expect(GitCredentialRequestSchema.safeParse({ ...bare, session_id: 'session-1' }).success).toBe(
      false,
    );
  });

  it('reads the /pty query parameters', () => {
    const query = (q: string) =>
      PtyOpenSchema.parse(Object.fromEntries(new URLSearchParams(q).entries()));
    expect(query('cols=100&rows=30')).toEqual({ cols: 100, rows: 30, user: 'bot' });
    expect(query('cwd=repos/a/.worktrees/x&user=coder&preset=claude%20--resume%20v1')).toEqual({
      cwd: 'repos/a/.worktrees/x',
      user: 'coder',
      preset: 'claude --resume v1',
    });
    expect(PtyOpenSchema.safeParse({ user: 'root' }).success).toBe(false);
  });
});
