import { THINKING_PHRASE_MS, thinkingPhrase } from '@openbots/shared';
import { useEffect, useState } from 'react';
import { OrbGlyph } from '../coders/agent-orb.js';
import './thinking-line.css';

/**
 * A Bot working on a reply with no text yet: the thinking orb and a line of
 * office slang that changes every few seconds. Screen readers hear one steady
 * "is replying" instead of each phrase.
 */
export function ThinkingLine({ seed, who }: { seed: string; who: string }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep((s) => s + 1), THINKING_PHRASE_MS);
    return () => clearInterval(timer);
  }, []);
  const phrase = thinkingPhrase(seed, step);
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" data-thinking>
      <OrbGlyph size={20} />
      <span key={phrase} aria-hidden="true" className="thinking-phrase">
        {phrase}
      </span>
      <span className="sr-only">{who} is replying</span>
    </div>
  );
}
