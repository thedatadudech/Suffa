/** Transcript editor while an automatic transcript runs: waiting, progress, stuck. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TranscriptEditor } from '@/modules/classes/player/RecordingEditors';
import { InteractiveApi, type Transcript } from '@/services/media/interactiveApi';

function setup(transcript: Transcript) {
  const onChange = vi.fn();
  render(
    <TranscriptEditor
      api={new InteractiveApi(vi.fn() as unknown as typeof fetch)}
      classId="c1"
      mediaId="m1"
      transcript={transcript}
      canGenerate
      currentTime={() => 0}
      onChange={onChange}
    />
  );
  return { onChange };
}

const base = {
  source: 'whisper' as const,
  cues: [],
  error: null,
  updatedAt: new Date().toISOString(),
};

describe('transcript progress', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('shows the waiting state, then the percentage, and looks again every few seconds', () => {
    vi.useFakeTimers();
    const { onChange } = setup({ ...base, status: 'queued', progress: null });
    expect(screen.getByRole('status')).toHaveTextContent(/Wartet auf den Start/);
    expect(screen.queryByRole('button', { name: /Automatisch erstellen/ })).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows how far it has come', () => {
    setup({ ...base, status: 'processing', progress: 42 });
    expect(screen.getByRole('status')).toHaveTextContent('42 %');
    expect(screen.getByRole('progressbar', { name: /Fortschritt/ })).toHaveAttribute(
      'value',
      '42'
    );
  });

  it('offers a restart when nothing has moved for a while', () => {
    setup({
      ...base,
      status: 'processing',
      progress: 20,
      updatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });
    expect(screen.getByText(/hängen geblieben/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Automatisch erstellen/ })
    ).toBeInTheDocument();
  });

  it('keeps a finished transcript folded, with the rerun button still at hand', () => {
    setup({
      ...base,
      status: 'ready',
      progress: null,
      cues: [{ start: 0, end: 3, text: 'مرحبا' }],
    });
    expect(screen.getByRole('button', { name: /Aufklappen/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: /Neu erstellen/ })).toBeVisible();
  });
});
