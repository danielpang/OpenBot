// Bundled for WKWebView by scripts/build-office.mjs, never imported by React Native.
// It shows the Mac app's office (apps/web's Office) with the Bots the app passes in.
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { Office } from '../../web/src/features/office/office';
import type { Bot } from '../../web/src/features/bots/queries';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __officeBots: Bot[];
    __officeReceive: (bots: Bot[]) => void;
  }
}

function App() {
  const [bots, setBots] = useState(window.__officeBots);
  useEffect(() => {
    window.__officeReceive = setBots;
    // The Mac app sits the office low under a wide sky. A phone is tall, so center it,
    // letting the city and its ground carry on above and below.
    document.querySelector('svg.office')?.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }, []);
  return <Office bots={bots} />;
}

createRoot(document.getElementById('office')!).render(<App />);
