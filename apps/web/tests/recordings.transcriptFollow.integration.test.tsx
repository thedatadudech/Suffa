/** The transcript list scrolls along with playback unless the switch is off. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptPanel } from '@/modules/classes/player/TranscriptPanel';

const cues = Array.from({ length: 20 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 5,
  text: `سطر ${i}`,
}));

describe('transcript follow-along', () => {
  afterEach(() => localStorage.clear());

  it('scrolls the list to the current line, and stops when switched off', async () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as never;
    const { rerender } = render(
      <TranscriptPanel cues={cues} time={0} onSeek={() => {}} />
    );
    rerender(<TranscriptPanel cues={cues} time={52} onSeek={() => {}} />);
    expect(scrollTo).toHaveBeenCalled();

    const box = screen.getByRole('checkbox', { name: 'Text mitlaufen lassen' });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(localStorage.getItem('suffa.transcript.follow')).toBe('off');
    scrollTo.mockClear();
    rerender(<TranscriptPanel cues={cues} time={80} onSeek={() => {}} />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('remembers the choice on this device', () => {
    localStorage.setItem('suffa.transcript.follow', 'off');
    render(<TranscriptPanel cues={cues} time={0} onSeek={() => {}} />);
    expect(
      screen.getByRole('checkbox', { name: 'Text mitlaufen lassen' })
    ).not.toBeChecked();
  });

  it('aligns the list again when the card is opened', async () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as never;
    render(<TranscriptPanel cues={cues} time={52} onSeek={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /Zuklappen/ }));
    scrollTo.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /Aufklappen/ }));
    expect(scrollTo).toHaveBeenCalled();
  });
});
