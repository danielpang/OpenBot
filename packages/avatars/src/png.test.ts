import { describe, expect, it } from 'vitest';
import { renderPng } from './png.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('renderPng', () => {
  it.each([64, 256])('renders a %i px PNG', (size) => {
    const png = renderPng({ seed: 'ada' }, size);
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    // IHDR: width and height are the first two fields after the chunk header.
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  });

  it('clamps out-of-range sizes', () => {
    expect(renderPng({ seed: 'ada' }, 4).readUInt32BE(16)).toBe(16);
  });
});
