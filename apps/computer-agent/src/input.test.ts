import { describe, expect, it } from 'vitest';
import { xdotoolArgs } from './input.js';

describe('xdotoolArgs', () => {
  it('maps every action onto one chained xdotool call', () => {
    expect(xdotoolArgs({ action: 'click' })).toEqual([
      'click',
      '--repeat',
      '1',
      '--delay',
      '80',
      '1',
    ]);
    expect(xdotoolArgs({ action: 'click', x: 5, y: 6, button: 'right', count: 3 })).toEqual([
      'mousemove',
      '--sync',
      '5',
      '6',
      'click',
      '--repeat',
      '3',
      '--delay',
      '80',
      '3',
    ]);
    expect(xdotoolArgs({ action: 'double_click', x: 1, y: 2 })).toEqual([
      'mousemove',
      '--sync',
      '1',
      '2',
      'click',
      '--repeat',
      '2',
      '--delay',
      '80',
      '1',
    ]);
    expect(xdotoolArgs({ action: 'type', text: '-n hello' })).toEqual([
      'type',
      '--delay',
      '12',
      '--',
      '-n hello',
    ]);
    expect(xdotoolArgs({ action: 'key', keys: ' ctrl+s  Return ' })).toEqual([
      'key',
      '--delay',
      '12',
      '--',
      'ctrl+s',
      'Return',
    ]);
    expect(xdotoolArgs({ action: 'scroll', x: 9, y: 9, direction: 'down' })).toEqual([
      'mousemove',
      '--sync',
      '9',
      '9',
      'click',
      '--repeat',
      '3',
      '--delay',
      '20',
      '5',
    ]);
    expect(xdotoolArgs({ action: 'scroll', direction: 'left', amount: 1 })).toEqual([
      'click',
      '--repeat',
      '1',
      '--delay',
      '20',
      '6',
    ]);
    expect(xdotoolArgs({ action: 'move', x: 3, y: 4 })).toEqual(['mousemove', '--sync', '3', '4']);
    expect(xdotoolArgs({ action: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).toEqual([
      'mousemove',
      '--sync',
      '1',
      '2',
      'mousedown',
      '1',
      'mousemove',
      '--sync',
      '3',
      '4',
      'mouseup',
      '1',
    ]);
    expect(xdotoolArgs({ action: 'cursor_position' })).toEqual(['getmouselocation', '--shell']);
  });

  it('rejects half a coordinate and bad values', () => {
    expect(() => xdotoolArgs({ action: 'click', x: 5 })).toThrow('Give both x and y');
    expect(() => xdotoolArgs({ action: 'move', x: -1, y: 0 })).toThrow();
    expect(() => xdotoolArgs({ action: 'type', text: '' })).toThrow();
  });
});
