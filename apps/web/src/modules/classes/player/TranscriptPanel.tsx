/**
 * Transcript under the player (story 8.1): the current line is marked; a tap jumps there.
 * With "Mitlaufen" on, the list scrolls along with playback (only the list, not the page).
 */
import { useEffect, useRef, useState } from 'react';
import { CollapsibleCard } from '@/components';
import { activeCue, clock, type Cue } from '@/services/media/checkpoints';

export function TranscriptPanel({
  cues,
  time,
  onSeek,
}: {
  cues: readonly Cue[];
  time: number;
  onSeek: (seconds: number) => void;
}) {
  const current = activeCue(cues, time);
  const list = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(readFollow);
  // Bumped when the card is opened again: the list was hidden and must be re-aligned.
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const box = list.current;
    const el = box?.children[current] as HTMLElement | undefined;
    if (!follow || !box || !el) return;
    // Keep the current line in the upper third of the list.
    box.scrollTo?.({ top: el.offsetTop - box.clientHeight / 3, behavior: 'smooth' });
  }, [current, follow, shown]);

  if (cues.length === 0) return null;
  return (
    <CollapsibleCard
      id="transcript"
      title="Transkript"
      onOpenChange={(open) => open && setShown((n) => n + 1)}
    >
      <label className="row muted" style={{ gap: '0.4rem', fontSize: '0.9rem' }}>
        <input
          type="checkbox"
          checked={follow}
          onChange={(e) => {
            setFollow(e.target.checked);
            saveFollow(e.target.checked);
          }}
        />
        Text mitlaufen lassen
      </label>
      <ol className="transcript" ref={list}>
        {cues.map((cue, i) => (
          <li
            key={`${cue.start}-${i}`}
            className={i === current ? 'transcript-current' : ''}
          >
            <button className="transcript-line" onClick={() => onSeek(cue.start)}>
              <span className="muted transcript-time">{clock(cue.start)}</span>
              <span lang="ar" dir="rtl" className="arabic-inline">
                {cue.text}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </CollapsibleCard>
  );
}

const FOLLOW_KEY = 'suffa.transcript.follow';

/** On unless the learner switched it off on this device. */
function readFollow(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveFollow(on: boolean): void {
  try {
    localStorage.setItem(FOLLOW_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode or storage blocked: the choice lasts for this visit only.
  }
}
