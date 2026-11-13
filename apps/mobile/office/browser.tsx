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

const HOME_ZOOM = 1.4;

function App() {
  const [bots, setBots] = useState(window.__officeBots);
  useEffect(() => {
    window.__officeReceive = setBots;
  }, []);
  // A phone is tall, so the office is centered and zoomed in, with the city and its ground
  // carrying on above and below. It doesn't turn; a drag moves it and a pinch zooms.
  return <Office bots={bots} align="middle" turnable={false} homeZoom={HOME_ZOOM} />;
}

createRoot(document.getElementById('office')!).render(<App />);
