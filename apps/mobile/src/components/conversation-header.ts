import { useGlassEnabled } from './glass';
import { useTheme } from '../theme';

/**
 * Shared native glass navigation, with an opaque accessibility/older-OS fallback.
 *
 * The native side applies the soft top edge only when this option changes, and only to
 * the scroll view on screen at that moment. A screen whose list mounts later (after a
 * loading state) passes `listReady: false` until it lays out, so the switch to `soft`
 * reaches the list instead of leaving a hard edge under the header.
 */
export function useConversationHeader(listReady = true) {
  const glass = useGlassEnabled();
  const c = useTheme();
  return {
    headerTransparent: true,
    headerStyle: { backgroundColor: glass ? 'transparent' : c.background },
    scrollEdgeEffects: { top: !glass
        ? ('hidden' as const)
        : listReady
          ? ('soft' as const)
          : ('automatic' as const), },
  };
}
