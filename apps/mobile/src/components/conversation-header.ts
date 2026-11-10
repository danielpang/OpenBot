import { useGlassEnabled } from './glass';
import { useTheme } from '../theme';

/** Shared native glass navigation, with an opaque accessibility/older-OS fallback. */
export function useConversationHeader() {
  const glass = useGlassEnabled();
  const c = useTheme();
  return {
    headerTransparent: true,
    headerStyle: { backgroundColor: glass ? 'transparent' : c.background },
    scrollEdgeEffects: { top: glass ? ('soft' as const) : ('hidden' as const) },
  };
}
