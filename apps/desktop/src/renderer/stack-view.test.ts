import { describe, expect, it } from 'vitest';
import { portTakenText, stackView } from './stack-view.js';

const ready = {
  state: 'ready' as const,
  cli: 'docker',
  runtime: 'orbstack' as const,
  serverVersion: '27',
  composeVersion: '2.30',
};

describe('stackView', () => {
  it('asks for Docker when it is missing or stopped', () => {
    expect(
      stackView({
        docker: { state: 'missing', installed: [] },
        services: [],
        upgrade: null,
        port: null,
      }),
    ).toMatchObject({
      canStart: false,
      canOpenRuntime: false,
    });
    expect(
      stackView({
        docker: { state: 'stopped', cli: 'docker', installed: ['orbstack'], error: '' },
        services: [],
        upgrade: null,
        port: null,
      }),
    ).toMatchObject({ text: 'Docker is not running. Open OrbStack.', canOpenRuntime: true });
  });

  it('offers Start before the stack runs and Open once every service is healthy', () => {
    expect(stackView({ docker: ready, services: [], upgrade: null, port: null })).toMatchObject({
      canStart: true,
      canStop: false,
      running: false,
    });
    const starting = stackView({
      docker: ready,
      services: [
        { service: 'server', state: 'running', health: 'starting' },
        { service: 'postgres', state: 'running', health: 'healthy' },
      ],
      upgrade: null,
      port: null,
    });
    expect(starting).toMatchObject({
      text: 'Starting: 1 of 2 services ready.',
      canStart: true,
      canStop: true,
    });
    const running = stackView({
      docker: ready,
      services: [
        { service: 'server', state: 'running', health: 'healthy' },
        { service: 'redis', state: 'running', health: '' },
      ],
      upgrade: null,
      port: null,
    });
    expect(running).toMatchObject({
      text: 'Running on OrbStack.',
      running: true,
      canStart: false,
      canStop: true,
    });
  });

  it('offers Update when the app is a newer release than the stack, once Docker is ready', () => {
    const upgrade = { from: '0.3.0', to: '0.4.0' };
    const view = stackView({
      docker: ready,
      services: [{ service: 'server', state: 'running', health: 'healthy' }],
      upgrade,
      port: null,
    });
    expect(view).toMatchObject({
      upgrade: "This Mac runs OpenBots 0.3.0. Update to 0.4.0, the app's version.",
      canUpgrade: true,
      running: true,
    });
    expect(
      stackView({
        docker: { state: 'stopped', cli: 'docker', installed: ['orbstack'], error: '' },
        services: [],
        upgrade,
        port: null,
      }),
    ).toMatchObject({ canUpgrade: false });
    expect(stackView({ docker: ready, services: [], upgrade: null, port: null })).toMatchObject({
      upgrade: null,
      canUpgrade: false,
    });
  });

  it('names a port another app took and offers the free one instead of Start', () => {
    const view = stackView({
      docker: ready,
      services: [],
      upgrade: null,
      port: { port: 3000, taken: true, free: 3001 },
    });
    expect(view).toMatchObject({
      text: 'Port 3000 is in use by another app. OpenBots can use port 3001 instead.',
      canStart: false,
      freePort: 3001,
    });
    expect(
      stackView({
        docker: ready,
        services: [],
        upgrade: null,
        port: { port: 3000, taken: true, free: null },
      }),
    ).toMatchObject({
      text: expect.stringMatching(/no nearby port is free/),
      freePort: null,
    });
    expect(
      stackView({
        docker: ready,
        services: [],
        upgrade: null,
        port: { port: 3000, taken: false, free: null },
      }),
    ).toMatchObject({ canStart: true, freePort: null });
    expect(portTakenText(3000, 3001)).not.toMatch(/[–—]/);
  });
});
