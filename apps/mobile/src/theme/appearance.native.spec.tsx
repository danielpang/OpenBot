import React from 'react';
import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { Alert, Appearance, Text, useColorScheme } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { AppearanceProvider, useTheme } from './index';
import { SettingsScreen } from '../screens/settings';

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../api/provider', () => ({ useMobile: () => ({ hosts: [], lockEnabled: false }) }));

function Preview() {
  return <Text testID="theme-color">{useTheme().background}</Text>;
}
function App() {
  return (
    <AppearanceProvider>
      <SettingsScreen />
      <Preview />
    </AppearanceProvider>
  );
}

beforeEach(() => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  jest.mocked(SecureStore.setItemAsync).mockResolvedValue(undefined);
  jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
  jest.mocked(useColorScheme).mockReturnValue('light');
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

const choice = (name: string) => screen.getByRole('radio', { name });

describe('appearance preference', () => {
  it('defaults to System and follows system changes', async () => {
    const view = render(<App />);
    await waitFor(() => expect(choice('System').props.accessibilityState.disabled).toBe(false));
    expect(choice('System').props.accessibilityState.checked).toBe(true);
    expect(Appearance.setColorScheme).toHaveBeenLastCalledWith('unspecified');
    jest.mocked(useColorScheme).mockReturnValue('dark');
    view.rerender(<App />);
    expect(screen.getByTestId('theme-color').props.children).toBe('#171717');
  });

  it.each(['Light', 'Dark'])(
    'persists %s and applies it to native UI and content',
    async (label) => {
      render(<App />);
      await waitFor(() => expect(choice(label).props.accessibilityState.disabled).toBe(false));
      fireEvent.press(choice(label));
      await waitFor(() => expect(choice(label).props.accessibilityState.checked).toBe(true));
      expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
        'openbots.appearance.v1',
        label.toLowerCase(),
      );
      expect(Appearance.setColorScheme).toHaveBeenLastCalledWith(label.toLowerCase());
      expect(screen.getByTestId('theme-color').props.children).toBe(
        label === 'Dark' ? '#171717' : '#ffffff',
      );
    },
  );

  it('restores the saved choice and can return to System', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue('dark');
    render(<App />);
    await waitFor(() => expect(choice('Dark').props.accessibilityState.checked).toBe(true));
    expect(Appearance.setColorScheme).toHaveBeenLastCalledWith('dark');
    fireEvent.press(choice('System'));
    await waitFor(() => expect(choice('System').props.accessibilityState.checked).toBe(true));
    expect(Appearance.setColorScheme).toHaveBeenLastCalledWith('unspecified');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('openbots.appearance.v1', 'system');
  });

  it('disables changes during hydration and persistence', async () => {
    let finishLoad!: (value: string | null) => void;
    let finishSave!: () => void;
    jest.mocked(SecureStore.getItemAsync).mockReturnValue(
      new Promise((resolve) => {
        finishLoad = resolve;
      }),
    );
    jest.mocked(SecureStore.setItemAsync).mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    render(<App />);
    expect(choice('Dark').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      finishLoad(null);
    });
    fireEvent.press(choice('Dark'));
    expect(choice('Light').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      finishSave();
    });
    expect(choice('Dark').props.accessibilityState.checked).toBe(true);
    expect(choice('Light').props.accessibilityState.disabled).toBe(false);
  });

  it('keeps the current choice and reports a failed save', async () => {
    jest.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error('Storage unavailable'));
    render(<App />);
    await waitFor(() => expect(choice('Dark').props.accessibilityState.disabled).toBe(false));
    fireEvent.press(choice('Dark'));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Could not save appearance', 'Storage unavailable'),
    );
    expect(choice('System').props.accessibilityState.checked).toBe(true);
    expect(choice('Dark').props.accessibilityState.disabled).toBe(false);
  });

  it('keeps an explicit Light choice when the device switches to Dark', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue('light');
    const view = render(<App />);
    await waitFor(() => expect(choice('Light').props.accessibilityState.checked).toBe(true));
    jest.mocked(useColorScheme).mockReturnValue('dark');
    view.rerender(<App />);
    expect(screen.getByTestId('theme-color').props.children).toBe('#ffffff');
  });

  it('falls back to System for an unreadable preference', async () => {
    jest.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error('Storage unavailable'));
    render(<App />);
    await waitFor(() => expect(choice('System').props.accessibilityState.disabled).toBe(false));
    expect(choice('System').props.accessibilityState.checked).toBe(true);
  });

  it('falls back to System for an invalid saved preference', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue('invalid');
    render(<App />);
    await waitFor(() => expect(choice('System').props.accessibilityState.disabled).toBe(false));
    expect(choice('System').props.accessibilityState.checked).toBe(true);
  });
});
