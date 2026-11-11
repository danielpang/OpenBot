import { describe, expect, it } from 'vitest';
import { glassWindowOptions, supportsLiquidGlass } from './glass.js';

describe('supportsLiquidGlass', () => {
  it('is on from macOS 26 (Darwin 25)', () => {
    expect(supportsLiquidGlass('darwin', '25.5.0')).toBe(true);
    expect(supportsLiquidGlass('darwin', '26.0.0')).toBe(true);
  });

  it('is off on earlier macOS and other systems', () => {
    expect(supportsLiquidGlass('darwin', '24.6.0')).toBe(false);
    expect(supportsLiquidGlass('darwin', '')).toBe(false);
    expect(supportsLiquidGlass('win32', '10.0.26100')).toBe(false);
    expect(supportsLiquidGlass('linux', '25.0.0')).toBe(false);
  });
});

describe('glassWindowOptions', () => {
  it('puts the sidebar material behind a clear page', () => {
    expect(glassWindowOptions(true)).toEqual({
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      trafficLightPosition: { x: 20, y: 17 },
    });
  });

  it('leaves the window alone without glass', () => {
    expect(glassWindowOptions(false)).toEqual({});
  });
});
