import type { AppBridge } from '../preload/bridge.js';

// The app's own pages get the full bridge from the preload.
declare global {
  interface Window {
    openbots: AppBridge;
  }
}
