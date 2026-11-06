import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type * as ReactNative from 'react-native';
import { renderHook } from '@testing-library/react-native';
import { defaultDeviceName, useTabletLayout } from './adaptive-layout';

const Native = jest.requireActual<typeof ReactNative>('react-native');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('iPad window layout', () => {
  it('uses the live window width and collapses below 820pt', () => {
    if (Native.Platform.OS !== 'ios') throw new Error('Run with the iOS Jest preset');
    jest.spyOn(Native.Platform, 'isPad', 'get').mockReturnValue(true);
    const dimensions = jest.spyOn(Native, 'useWindowDimensions').mockReturnValue({
      width: 1024,
      height: 768,
      scale: 2,
      fontScale: 1,
    });
    const hook = renderHook(() => useTabletLayout());
    expect(hook.result.current).toBe(true);
    dimensions.mockReturnValue({ width: 819, height: 1024, scale: 2, fontScale: 1 });
    hook.rerender({});
    expect(hook.result.current).toBe(false);
    dimensions.mockReturnValue({ width: 820, height: 1024, scale: 2, fontScale: 1 });
    hook.rerender({});
    expect(hook.result.current).toBe(true);
    expect(defaultDeviceName()).toBe('My iPad');
  });

  it('keeps iPhone navigation compact even in a wide landscape window', () => {
    if (Native.Platform.OS !== 'ios') throw new Error('Run with the iOS Jest preset');
    jest.spyOn(Native.Platform, 'isPad', 'get').mockReturnValue(false);
    jest.spyOn(Native, 'useWindowDimensions').mockReturnValue({
      width: 932,
      height: 430,
      scale: 3,
      fontScale: 1,
    });
    expect(renderHook(() => useTabletLayout()).result.current).toBe(false);
    expect(defaultDeviceName()).toBe('My iPhone');
  });
});
