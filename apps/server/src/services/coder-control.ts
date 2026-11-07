import {
  CODER_CONTROL_CHANNEL,
  CoderControlSchema,
  type CoderControl,
  type Unsubscribe,
} from '@openbots/shared';
import type { AppDeps } from '../context.js';

// The coding sessions' control channel (I12): the API process (a decided
// approval, the widget's Stop, a computer that is stopping) tells whichever
// worker runs a session what to do, as RUN_CONTROL_CHANNEL does for runs.
// Messages are checked against `CoderControlSchema` both ways, so a stray
// publish never reaches a running session.

export async function publishCoderControl(
  deps: Pick<AppDeps, 'infra'>,
  msg: CoderControl,
): Promise<void> {
  await deps.infra.bus.publish<CoderControl>(CODER_CONTROL_CHANNEL, CoderControlSchema.parse(msg));
}

export function subscribeCoderControl(
  deps: Pick<AppDeps, 'infra' | 'logger'>,
  handler: (msg: CoderControl) => void,
): Promise<Unsubscribe> {
  return deps.infra.bus.subscribe<unknown>(CODER_CONTROL_CHANNEL, (raw) => {
    const parsed = CoderControlSchema.safeParse(raw);
    if (!parsed.success) {
      deps.logger.warn({ issues: parsed.error.issues.length }, 'ignored a malformed coder control');
      return;
    }
    handler(parsed.data);
  });
}
