import React from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { WelcomeScreen } from './onboarding';

type Permission = { granted: boolean; canAskAgain: boolean };
const mockGetPermission = jest.fn<() => Promise<Permission>>();
const mockRequestPermission = jest.fn<() => Promise<Permission>>();
const mockPush = jest.fn();
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, mockRequestPermission, mockGetPermission],
}));
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('../api/provider', () => ({ useMobile: jest.fn() }));
jest.mock('../hosts/pairing', () => ({ parsePairingLink: jest.fn() }));
jest.mock('../hosts/connection-qr', () => ({ parseConnectionQr: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

beforeEach(() => {
  mockPush.mockReset();
  mockGetPermission.mockReset().mockResolvedValue({ granted: false, canAskAgain: true });
  mockRequestPermission.mockReset().mockResolvedValue({ granted: false, canAskAgain: false });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

async function scan() {
  render(<WelcomeScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Scan a QR code' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Scan a QR code' }).props.accessibilityState.disabled,
    ).toBe(false),
  );
}

describe('welcome camera permission', () => {
  it('does not request camera access on mount', () => {
    render(<WelcomeScreen />);
    expect(mockGetPermission).not.toHaveBeenCalled();
    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it('opens the scanner only after permission is granted', async () => {
    mockRequestPermission.mockResolvedValue({ granted: true, canAskAgain: true });
    await scan();
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/(onboarding)/pair');
  });

  it('stays home after denial and allows manual entry', async () => {
    await scan();
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'Enter manually' }));
    expect(mockPush).toHaveBeenCalledWith('/(onboarding)/connect');
  });

  it('opens directly when camera access was already granted', async () => {
    mockGetPermission.mockResolvedValue({ granted: true, canAskAgain: true });
    await scan();
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/(onboarding)/pair');
  });

  it('stays home and offers Settings when iOS cannot prompt again', async () => {
    mockGetPermission.mockResolvedValue({ granted: false, canAskAgain: false });
    await scan();
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Camera access is disabled',
      expect.any(String),
      expect.any(Array),
    );
  });

  it('stays home if the permission API fails', async () => {
    mockGetPermission.mockRejectedValue(new Error('Unavailable'));
    await scan();
    expect(mockPush).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Camera unavailable', expect.any(String));
  });
});
