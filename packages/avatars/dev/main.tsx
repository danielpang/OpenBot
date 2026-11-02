import type { Avatar as AvatarValue } from '@openbots/shared';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AVATAR_STATES, generate } from '../src/index.js';
import { Avatar, AvatarEditor } from '../src/react.js';
import './dev.css';

// Fifty seeds in every state, at sidebar size and at profile size, for
// checking that the family reads as one system and every Bot is recognizable
// at 24 px. Toggle reduced motion to see the ring cue instead of motion.

const SEEDS = Array.from({ length: 50 }, (_, i) => `bot-${i}`);

function App() {
  const [size, setSize] = useState(24);
  const [reduced, setReduced] = useState(false);
  const [value, setValue] = useState<AvatarValue>({ kind: 'generated', seed: 'bot-0' });
  return (
    <main className="flex flex-col gap-8 p-6 text-sm">
      <header className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">Avatars</h1>
        {[24, 32, 48, 64].map((px) => (
          <label key={px} className="flex items-center gap-1">
            <input type="radio" checked={size === px} onChange={() => setSize(px)} />
            {px}px
          </label>
        ))}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} />
          reduced motion
        </label>
      </header>

      <section className="max-w-xl">
        <AvatarEditor value={value} onChange={setValue} />
      </section>

      <table className="border-separate border-spacing-x-4 border-spacing-y-2">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th>seed</th>
            {AVATAR_STATES.map((state) => (
              <th key={state}>{state}</th>
            ))}
            <th>parts</th>
          </tr>
        </thead>
        <tbody>
          {SEEDS.map((seed) => {
            const { shape, palette, eyes, accessory } = generate({ seed });
            return (
              <tr key={seed}>
                <td className="font-mono text-xs">{seed}</td>
                {AVATAR_STATES.map((state) => (
                  <td key={state}>
                    <Avatar params={{ seed }} state={state} size={size} reducedMotion={reduced} />
                  </td>
                ))}
                <td className="text-xs text-muted-foreground">
                  {shape} · {palette} · {eyes} · {accessory}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
