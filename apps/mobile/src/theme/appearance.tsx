import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { Appearance, useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export type AppearanceMode = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'openbots.appearance.v1';
const AppearanceContext = createContext<{
  mode: AppearanceMode;
  ready: boolean;
  saving: boolean;
  setMode: (mode: AppearanceMode) => Promise<void>;
} | null>(null);

export function AppearanceProvider({ children }: PropsWithChildren) {
  const [mode, setModeState] = useState<AppearanceMode>('system');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(STORAGE_KEY)
      .then((saved) => {
        if (active && (saved === 'light' || saved === 'dark')) setModeState(saved);
      })
      .catch(() => {
        /* A missing/unreadable preference defaults to System. */
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // Also styles UIKit tabs, navigation controls, keyboards, pickers and sheets.
    // Clearing the override resumes live updates from the device's appearance.
    Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
  }, [mode]);

  async function setMode(next: AppearanceMode) {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, next);
      setModeState(next);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <AppearanceContext.Provider value={{ mode, ready, saving, setMode }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error('AppearanceProvider is required');
  return context;
}

export function useThemeScheme(): 'light' | 'dark' {
  const context = useContext(AppearanceContext);
  const system = useColorScheme();
  return context?.mode === 'light' || context?.mode === 'dark'
    ? context.mode
    : system === 'dark'
      ? 'dark'
      : 'light';
}
