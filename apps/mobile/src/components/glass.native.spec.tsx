import React, { useEffect } from 'react';
import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, Platform, TextInput, type ViewProps } from 'react-native';
import type * as ReactNative from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { GlassIconButton, GlassProvider, GlassSurface } from './glass';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-glass-effect', () => ({
  isGlassEffectAPIAvailable: jest.fn(() => true),
  isLiquidGlassAvailable: jest.fn(() => true),
  GlassView: (props: ViewProps) => {
    const { View: NativeView } = jest.requireActual<typeof ReactNative>('react-native');
    return <NativeView {...props} testID="native-glass" />;
  },
}));

const listeners = new Map<string, (value: boolean) => void>();
const remove = jest.fn();
const material = () => screen.queryByTestId('native-glass', { includeHiddenElements: true });
beforeEach(() => {
  jest.clearAllMocks();
  listeners.clear();
  jest.mocked(isGlassEffectAPIAvailable).mockReturnValue(true);
  jest.mocked(isLiquidGlassAvailable).mockReturnValue(true);
  jest.spyOn(AccessibilityInfo, 'isReduceTransparencyEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'isDarkerSystemColorsEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    name: string,
    listener: (value: boolean) => void,
  ) => {
    listeners.set(name, listener);
    return { remove };
  }) as unknown as typeof AccessibilityInfo.addEventListener);
});
afterEach(() => {
  jest.restoreAllMocks();
});

function Surface() {
  return (
    <GlassProvider>
      <GlassSurface>
        <TextInput accessibilityLabel="Draft" />
      </GlassSurface>
    </GlassProvider>
  );
}

describe('Liquid Glass material', () => {
  it('starts opaque, then uses regular native glass without intercepting input', async () => {
    render(<Surface />);
    expect(material()).toBeNull();
    await waitFor(() => expect(material()).toBeTruthy());
    expect(material()!.props).toMatchObject({
      glassEffectStyle: 'regular',
      pointerEvents: 'none',
      accessibilityElementsHidden: true,
    });
    expect(screen.getByLabelText('Draft')).toBeTruthy();
  });

  it.each(['api', 'design', 'platform'])(
    'uses opaque surfaces when %s support is unavailable',
    (support) => {
      if (support === 'api') jest.mocked(isGlassEffectAPIAvailable).mockReturnValue(false);
      if (support === 'design') jest.mocked(isLiquidGlassAvailable).mockReturnValue(false);
      if (support === 'platform') jest.replaceProperty(Platform, 'OS', 'android');
      render(<Surface />);
      expect(material()).toBeNull();
      expect(AccessibilityInfo.isReduceTransparencyEnabled).not.toHaveBeenCalled();
    },
  );

  it.each(['transparency', 'contrast'])(
    'stays opaque for increased %s accessibility needs',
    async (preference) => {
      if (preference === 'transparency')
        jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockResolvedValue(true);
      else jest.mocked(AccessibilityInfo.isDarkerSystemColorsEnabled).mockResolvedValue(true);
      render(<Surface />);
      await act(async () => {});
      expect(material()).toBeNull();
    },
  );

  it('fails closed if accessibility preferences cannot be read', async () => {
    jest
      .mocked(AccessibilityInfo.isReduceTransparencyEnabled)
      .mockRejectedValue(new Error('Unavailable'));
    render(<Surface />);
    await act(async () => {});
    expect(material()).toBeNull();
  });

  it('updates live without remounting the draft and removes listeners on unmount', async () => {
    const mounted = jest.fn();
    function Draft() {
      useEffect(() => {
        mounted();
      }, []);
      return <TextInput accessibilityLabel="Draft" />;
    }
    const view = render(
      <GlassProvider>
        <GlassSurface>
          <Draft />
        </GlassSurface>
      </GlassProvider>,
    );
    await waitFor(() => expect(material()).toBeTruthy());
    act(() => listeners.get('reduceTransparencyChanged')!(true));
    expect(material()).toBeNull();
    act(() => listeners.get('reduceTransparencyChanged')!(false));
    expect(material()).toBeTruthy();
    act(() => listeners.get('darkerSystemColorsChanged')!(true));
    expect(material()).toBeNull();
    expect(mounted).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a live accessibility change with a stale query result', async () => {
    let resolve!: (value: boolean) => void;
    jest.mocked(AccessibilityInfo.isReduceTransparencyEnabled).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<Surface />);
    act(() => listeners.get('reduceTransparencyChanged')!(true));
    await act(async () => {
      resolve(false);
    });
    expect(material()).toBeNull();
  });

  it('keeps floating controls labelled and tappable in the fallback', () => {
    const press = jest.fn();
    render(<GlassIconButton icon="add" label="Create a Bot or group" onPress={press} />);
    fireEvent.press(screen.getByRole('button', { name: 'Create a Bot or group' }));
    expect(press).toHaveBeenCalledTimes(1);
  });
});
