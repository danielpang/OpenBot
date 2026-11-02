import { useStore } from './use-store.js';
import type { StartFlow } from './start-flow.js';
import { StatusPage } from './status-page.js';
import { WelcomePage } from './welcome-page.js';

/** The start page: the welcome screen with `welcome=1`, the status page otherwise. */
export function StartPage({ flow }: { flow: StartFlow }) {
  const state = useStore(flow.store);
  return state.mode === 'welcome' ? (
    <WelcomePage flow={flow} state={state} />
  ) : (
    <StatusPage flow={flow} state={state} />
  );
}
