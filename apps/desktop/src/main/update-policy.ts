/** Unsigned builds can discover releases but must use the universal DMG. */
export async function updatePolicy(options: {
  packaged: boolean;
  platform: string;
  version: string;
  verifySignature(): Promise<void>;
}): Promise<{ manual?: boolean; disabledReason?: string }> {
  if (!options.packaged || options.platform !== 'darwin' || options.version === '0.0.0') {
    return {
      disabledReason:
        'This development build does not check for updates. Install a versioned OpenBots macOS release or rebuild from source.',
    };
  }
  try {
    await options.verifySignature();
    return {};
  } catch {
    return { manual: true };
  }
}
