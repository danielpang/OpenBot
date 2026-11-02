import { describe, expect, it } from 'vitest';
import { childEnv, loadConfig, SECRET_ENV_VARS } from './config.js';
import { run } from './proc.js';

describe('loadConfig', () => {
  it('reads the defaults, with the token in a file outside the environment (S-7)', () => {
    expect(loadConfig({})).toEqual({
      tokenFile: '/var/lib/openbots/token',
      port: 7070,
      host: '0.0.0.0',
      home: '/home/bot',
      width: 1280,
      height: 800,
      chromiumPath: undefined,
      runtimeDir: '/tmp/openbots',
      stateDir: '/var/lib/openbots',
    });
  });

  it('still takes a token from the environment, for a remote agent', () => {
    expect(loadConfig({ OPENBOTS_AGENT_TOKEN: 'x'.repeat(32) }).token).toBe('x'.repeat(32));
    expect(
      loadConfig({ OPENBOTS_STATE_DIR: '/data/state', OPENBOTS_AGENT_TOKEN_FILE: '/run/t' }),
    ).toMatchObject({ stateDir: '/data/state', tokenFile: '/run/t' });
    expect(loadConfig({ OPENBOTS_STATE_DIR: '/data/state' }).tokenFile).toBe('/data/state/token');
  });

  it('reads overrides', () => {
    const config = loadConfig({
      OPENBOTS_AGENT_TOKEN: 'x'.repeat(32),
      OPENBOTS_AGENT_PORT: '9000',
      OPENBOTS_SCREEN_SIZE: '1024x768',
      OPENBOTS_HOME: '/data/home',
      OPENBOTS_CHROMIUM: '/usr/bin/chromium',
    });
    expect(config).toMatchObject({
      port: 9000,
      width: 1024,
      height: 768,
      home: '/data/home',
      chromiumPath: '/usr/bin/chromium',
    });
  });

  it('lists every problem at once', () => {
    expect(() =>
      loadConfig({
        OPENBOTS_AGENT_TOKEN: 'short',
        OPENBOTS_AGENT_PORT: 'x',
        OPENBOTS_SCREEN_SIZE: 'big',
        OPENBOTS_HOME: 'rel',
        OPENBOTS_STATE_DIR: 'state',
      }),
    ).toThrow(/TOKEN[\s\S]*PORT[\s\S]*SCREEN_SIZE[\s\S]*HOME[\s\S]*STATE_DIR/);
  });
});

describe('childEnv (S-7)', () => {
  it('passes the environment on without the agent token, whatever the overlays say', () => {
    const before = process.env.OPENBOTS_AGENT_TOKEN;
    process.env.OPENBOTS_AGENT_TOKEN = 'x'.repeat(32);
    try {
      const env = childEnv({ HOME: '/home/bot' }, { DISPLAY: ':10', OPENBOTS_AGENT_TOKEN: 'y' });
      expect(env).toMatchObject({ HOME: '/home/bot', DISPLAY: ':10', PATH: process.env.PATH });
      for (const name of SECRET_ENV_VARS) expect(env).not.toHaveProperty(name);
      expect(process.env.OPENBOTS_AGENT_TOKEN).toBe('x'.repeat(32));
    } finally {
      if (before === undefined) delete process.env.OPENBOTS_AGENT_TOKEN;
      else process.env.OPENBOTS_AGENT_TOKEN = before;
    }
  });

  it('keeps the token from the short commands too (xdotool, import, feh)', async () => {
    const before = process.env.OPENBOTS_AGENT_TOKEN;
    process.env.OPENBOTS_AGENT_TOKEN = 'x'.repeat(32);
    try {
      const { stdout } = await run(
        '/bin/sh',
        ['-c', 'echo "${OPENBOTS_AGENT_TOKEN-unset} $DISPLAY"'],
        {
          env: { DISPLAY: ':12' },
        },
      );
      expect(stdout.toString()).toBe('unset :12\n');
    } finally {
      if (before === undefined) delete process.env.OPENBOTS_AGENT_TOKEN;
      else process.env.OPENBOTS_AGENT_TOKEN = before;
    }
  });
});
