/**
 * A card whose body folds away behind its heading, e.g. the summary or transcript under the
 * player on a phone. `lead` (status, main action) stays visible when folded. Open or closed is
 * remembered per card on this device.
 */
import { useState, type ReactNode } from 'react';

export function CollapsibleCard({
  id,
  title,
  lead,
  defaultOpen = true,
  onOpenChange,
  children,
}: {
  /** Stable name, used for the element ids and the remembered state. */
  id: string;
  title: ReactNode;
  lead?: ReactNode;
  defaultOpen?: boolean;
  /** Told after the body was shown or hidden (e.g. to scroll it into place). */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const toggle = () => {
    setOpen(!open);
    saveOpen(id, !open);
    onOpenChange?.(!open);
  };
  return (
    <section className="card stack" aria-labelledby={titleId}>
      <div className="collapsible-head">
        <h2 id={titleId} className="eyebrow">
          {title}
        </h2>
        <button
          type="button"
          className="btn collapsible-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          {open ? 'Zuklappen ▴' : 'Aufklappen ▾'}
        </button>
      </div>
      {lead}
      <div id={bodyId} className="stack" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

const key = (id: string) => `suffa.card.${id}`;

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key(id));
    return saved === null ? fallback : saved === 'open';
  } catch {
    return fallback;
  }
}

function saveOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(key(id), open ? 'open' : 'closed');
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
}
