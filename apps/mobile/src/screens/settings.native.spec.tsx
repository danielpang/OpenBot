import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { SettingsScreen } from './settings';

const mockMobile = {
  hosts: [] as { id: string; name: string; kind: string; directUrls: string[] }[],
  host: null as { id: string } | null,
  connected: false,
  transport: null,
  notificationsEnabled: false,
  lockEnabled: true,
  enableNotifications: jest.fn(),
  setLockEnabled: jest.fn(),
  removeHost: jest.fn(),
  activateHost: jest.fn(),
};

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../api/provider', () => ({ useMobile: () => mockMobile }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

beforeEach(() => {
  Object.assign(Platform, { OS: 'ios' });
});

describe('settings device copy', () => {
  it('keeps Face ID and iOS Settings wording on iOS', () => {
    render(<SettingsScreen />);
    expect(screen.getByText('Manage alerts in iOS Settings.')).toBeTruthy();
    expect(screen.getByText('Require Face ID or your device passcode.')).toBeTruthy();
    expect(screen.getByLabelText('Require Face ID')).toBeTruthy();
    expect(screen.getByText('OpenBots for iOS')).toBeTruthy();
  });

  it('uses system Settings and biometric copy on Android', () => {
    Object.assign(Platform, { OS: 'android' });
    render(<SettingsScreen />);
    expect(screen.getByText('Manage alerts in system Settings.')).toBeTruthy();
    expect(screen.getByText('Require biometric or your device passcode.')).toBeTruthy();
    expect(screen.queryByLabelText('Require Face ID')).toBeNull();
    expect(screen.getByLabelText('Require biometric or device passcode')).toBeTruthy();
    expect(screen.getByText('OpenBots for Android')).toBeTruthy();
    expect(screen.queryByText(/Face ID/)).toBeNull();
    expect(screen.queryByText(/iOS Settings/)).toBeNull();
  });
});
