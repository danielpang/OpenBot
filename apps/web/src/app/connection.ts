import type { RealtimeStatus } from '../features/transcript/realtime.js';
import type { DesktopConnectionInfo } from './platform.js';

// What the Mac app's connection indicator says (plan 14.4). One small icon in
// the sidebar with a tooltip, coloured only when something is wrong (PRD
// principle 3 wants no status clutter). Its state is the realtime connection
// (connected, or reconnecting once it was open) and, for This Mac only, the
// local stack. Plain, so it is tested without React.

export type IndicatorTone = 'normal' | 'warning' | 'problem';

export interface IndicatorState {
  /** "This Mac (Docker)", "Self-hosted" or "OpenBots account". */
  title: string;
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

export function indicatorState(
  info: DesktopConnectionInfo,
  realtime: RealtimeStatus,
): IndicatorState {
  const title = TITLES[info.kind];
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
  return { title, status, tone, tooltip: `${where}: ${status}` };
}
