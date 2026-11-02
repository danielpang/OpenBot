import { useSyncExternalStore } from 'react';
import type { Store } from './store.js';

/** The store's state, re-rendering on every update. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
