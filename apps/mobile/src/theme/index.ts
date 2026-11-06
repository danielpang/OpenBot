import { useThemeScheme } from './appearance';
export {
  AppearanceProvider,
  useAppearance,
  useThemeScheme,
  type AppearanceMode,
} from './appearance';

// Native equivalents of packages/ui/src/styles.css's neutral colour tokens.
export const themes = {
  light: {
    background: '#ffffff',
    foreground: '#171717',
    card: '#fafafa',
    muted: '#f5f5f5',
    secondary: '#eaeaea',
    mutedForeground: '#737373',
    border: '#e5e5e5',
    primary: '#262626',
    primaryForeground: '#fafafa',
    success: '#169449',
    warning: '#b45309',
    danger: '#dc2626',
    accent: '#fbefe3',
  },
  dark: {
    background: '#171717',
    foreground: '#fafafa',
    card: '#262626',
    muted: '#303030',
    secondary: '#404040',
    mutedForeground: '#a3a3a3',
    border: '#383838',
    primary: '#e5e5e5',
    primaryForeground: '#262626',
    success: '#50c878',
    warning: '#f0b35a',
    danger: '#ff7676',
    accent: '#3c3025',
  },
} as const;
export type Theme = { [K in keyof typeof themes.light]: string };
export function useTheme(): Theme {
  return themes[useThemeScheme()];
}
