import { describe, expect, it } from 'vitest';
import { aboutPanelOptions } from './about.js';

describe('native About version', () => {
  it('uses the packaged release-tag version, not the local build fallback', () => {
    expect(
      aboutPanelOptions({ packaged: true, appVersion: '1.2.3', buildVersion: '0.9.0' }),
    ).toEqual({
      applicationName: 'OpenBots',
      applicationVersion: '1.2.3',
      version: '',
      copyright: 'Copyright © OpenBots contributors',
    });
    expect(
      aboutPanelOptions({ packaged: true, appVersion: '1.3.0-rc.1', buildVersion: '0.9.0' })
        .applicationVersion,
    ).toBe('1.3.0-rc.1');
  });

  it('shows the embedded Git-tag baseline for local runs and unstamped packages', () => {
    for (const packaged of [false, true]) {
      expect(
        aboutPanelOptions({ packaged, appVersion: '0.0.0', buildVersion: '0.0.1' })
          .applicationVersion,
      ).toBe('0.0.1 (development)');
    }
  });

  it('labels a build without Git tags as development, not a 0.0.0 release', () => {
    expect(
      aboutPanelOptions({ packaged: false, appVersion: '0.0.0', buildVersion: '0.0.0' })
        .applicationVersion,
    ).toBe('Development build');
  });
});
