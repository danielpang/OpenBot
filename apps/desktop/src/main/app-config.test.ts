import { describe, expect, it } from 'vitest';
import { cloudUrl, parseCloudUrl } from './app-config.js';

describe('the cloud URL from the build', () => {
  it('takes an https origin, and nothing else', () => {
    expect(parseCloudUrl('https://app.openbots.example/x')).toBe('https://app.openbots.example');
    expect(parseCloudUrl('http://localhost:3000')).toBe('http://localhost:3000');
    for (const bad of [undefined, '', '  ', 'nope', 'http://app.openbots.example', 3]) {
      expect(parseCloudUrl(bad)).toBeNull();
    }
    expect(parseCloudUrl('https://me:pw@app.openbots.example')).toBeNull();
  });

  it('reads the packaged package.json, and ignores the environment there', () => {
    const packageJson = { openbots: { cloudUrl: 'https://app.openbots.example' } };
    const env = { OPENBOTS_CLOUD_URL: 'https://elsewhere.example' };
    expect(cloudUrl({ packaged: true, packageJson, env })).toBe('https://app.openbots.example');
    expect(cloudUrl({ packaged: true, packageJson: { name: 'x' }, env })).toBeNull();
    expect(cloudUrl({ packaged: true, packageJson: null, env })).toBeNull();
  });

  it('reads OPENBOTS_CLOUD_URL in development', () => {
    expect(cloudUrl({ packaged: false, env: { OPENBOTS_CLOUD_URL: 'https://dev.example' } })).toBe(
      'https://dev.example',
    );
    expect(cloudUrl({ packaged: false, env: {} })).toBeNull();
  });
});
