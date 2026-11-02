import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createStartFlow } from './start-flow.js';
import { StartPage } from './start-page.js';

// The start page's entry (index.html): the flow in ./start-flow.ts, the views
// in ./start-page.tsx.

const flow = createStartFlow(window.openbots, new URLSearchParams(location.search));
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StartPage flow={flow} />
  </StrictMode>,
);
void flow.start();
