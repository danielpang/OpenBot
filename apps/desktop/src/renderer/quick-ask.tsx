import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createQuickAskFlow } from './quick-ask-flow.js';
import { QuickAsk } from './quick-ask-view.js';

// The quick-ask window's entry (quick-ask.html).

const bridge = window.openbots;
// The window has the menu's vibrancy on macOS (main/index.ts): let it show.
if (bridge.platform.os === 'darwin') document.documentElement.dataset.vibrancy = '';
const flow = createQuickAskFlow(bridge, localStorage);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QuickAsk flow={flow} />
  </StrictMode>,
);
void flow.start();
