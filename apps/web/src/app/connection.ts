import type { RealtimeStatus } from '../features/transcript/realtime.js';
import type { DesktopConnectionInfo } from './platform.js';

// What the Mac app's connection indicator says (plan 14.4). One small icon and
// a short name in the sidebar with a tooltip, coloured only when something is wrong (PRD
// principle 3 wants no status clutter). Its state is the realtime connection
// (connected, or reconnecting once it was open) and, for This Mac only, the
// local stack. Plain, so it is tested without React.

export type IndicatorTone = 'normal' | 'warning' | 'problem';

export interface IndicatorState {
  /** "This Mac (Docker)", "Self-hosted", "Paired" or "OpenBots account". */
  title: string;
  /** The short name beside the icon: "This Mac", "Self-hosted" or "OpenBots account". */
  label: string;
  status: string;
  tone: IndicatorTone;
  /** The tooltip and the button's accessible name. */
  tooltip: string;
}

const TITLES: Record<DesktopConnectionInfo['kind'], string> = {
  local: 'This Mac (Docker)',
  remote: 'Self-hosted',
  cloud: 'OpenBots account',
};

const LABELS: Record<DesktopConnectionInfo['kind'], string> = {
  local: 'This Mac',
  remote: 'Self-hosted',
  cloud: 'OpenBots account',
};

/** Labels the Mac app sends for a kind beyond its own: another Mac it paired with reports `remote`. */
const EXTRA_LABELS = new Set(['Paired']);

export function indicatorState(
  info: DesktopConnectionInfo,
  realtime: RealtimeStatus,
): IndicatorState {
  const own = info.kind === 'remote' && EXTRA_LABELS.has(info.label) ? info.label : null;
  const title = own ?? TITLES[info.kind];
  const stack = info.kind === 'local' ? info.stack : undefined;
  const open = realtime.status === 'open';
  let status: string;
  let tone: IndicatorTone;
  if (stack?.state === 'unhealthy') {
    [status, tone] = ['Not healthy', 'warning'];
  } else if (open) {
    [status, tone] = ['Connected', 'normal'];
  } else if (stack?.state === 'stopped') {
    [status, tone] = ['Stopped', 'problem'];
  } else if (realtime.everOpen) {
    [status, tone] = ['Reconnecting…', 'warning'];
  } else {
    [status, tone] = ['Connecting…', 'normal'];
  }
  const where = info.kind === 'local' ? title : `${title} (${info.host})`;
  return { title, label: own ?? LABELS[info.kind], status, tone, tooltip: `${where}: ${status}` };
}
