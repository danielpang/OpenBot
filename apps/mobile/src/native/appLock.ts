import * as LocalAuthentication from 'expo-local-authentication';

export { AppLockPolicy, AUTO_LOCK_AFTER_MS } from './lockPolicy';

/** Uses Face ID/Touch ID with the device passcode as the owner fallback. */
export async function authenticateOwner(): Promise<boolean> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) {
    // A phone without any device authentication cannot protect an owner key.
    throw new Error('Set a device passcode in iOS Settings to unlock OpenBots.');
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock OpenBots',
    cancelLabel: 'Cancel',
    fallbackLabel: 'Use passcode',
    disableDeviceFallback: false,
    biometricsSecurityLevel: 'strong',
  });
  return result.success;
}
