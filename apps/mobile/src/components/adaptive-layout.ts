import { Platform, useWindowDimensions } from 'react-native';

// Use the current window, not screen/device dimensions: iPad multitasking and
// Stage Manager can give a tablet a phone-sized window. Leave at least 500pt
// for the conversation alongside the 320pt sidebar.
export const TABLET_SIDEBAR_WIDTH = 320;
export const TABLET_SPLIT_MIN_WIDTH = 820;

export function useTabletLayout() {
  const { width } = useWindowDimensions();
  return Platform.OS === 'ios' && Platform.isPad && width >= TABLET_SPLIT_MIN_WIDTH;
}

export function defaultDeviceName() {
  return Platform.OS === 'ios' ? (Platform.isPad ? 'My iPad' : 'My iPhone') : 'My phone';
}
