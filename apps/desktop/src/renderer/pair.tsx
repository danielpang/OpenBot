import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPairFlow } from './pair-flow.js';
import { PairWindow } from './pair-view.js';

// The pairing window's entry (pair.html).

const view = new URLSearchParams(location.search).get('view') === 'relay' ? 'relay' : 'pair';
const flow = createPairFlow(window.openbots, view);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PairWindow flow={flow} />
  </StrictMode>,
);
void flow.start();
