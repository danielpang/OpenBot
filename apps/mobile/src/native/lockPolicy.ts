export const AUTO_LOCK_AFTER_MS = 5 * 60_000;

/** Lock on launch; background timing is kept outside React for deterministic testing. */
export class AppLockPolicy {
  private backgroundAt: number | null = null;
  private unlocked = false;
  constructor(private readonly now: () => number = Date.now) {}
  get locked() {
    return !this.unlocked;
  }
  unlock() {
    this.unlocked = true;
  }
  lock() {
    this.unlocked = false;
  }
  background() {
    this.backgroundAt ??= this.now();
  }
  foreground() {
    if (this.backgroundAt !== null && this.now() - this.backgroundAt >= AUTO_LOCK_AFTER_MS)
      this.lock();
    this.backgroundAt = null;
    return this.locked;
  }
}
