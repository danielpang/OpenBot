// A small observable state holder for the app pages' flows: plain, so a flow
// is tested without a DOM, and React reads it with useSyncExternalStore
// (./use-store.ts).

export interface Store<T> {
  get(): T;
  /** Merges the patch into the state and tells every subscriber. */
  update(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    update(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
