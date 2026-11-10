const RELOAD_KEY = 'openbots:chunk-recovery';

/** A stale tab may request chunks removed by a deployment. Reload once per build. */
export function installChunkRecovery(build: string) {
  let reloading = false;
  window.addEventListener('vite:preloadError', (event) => {
    if (reloading) {
      event.preventDefault();
      return;
    }
    try {
      if (window.sessionStorage.getItem(RELOAD_KEY) === build) return;
      // Persist before navigating so a broken deployment cannot cause a reload loop.
      window.sessionStorage.setItem(RELOAD_KEY, build);
    } catch {
      // Without storage we cannot guard across reloads. Leave the error visible.
      return;
    }
    reloading = true;
    event.preventDefault();
    window.location.reload();
  });
}
