/** Lesson summary of a recording in the player: teacher drafts and publishes, learners read. */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SummaryPanel } from '@/modules/classes/player/SummaryPanel';
import { InteractiveApi, type SummaryState } from '@/services/media/interactiveApi';

const CONTENT = {
  overview: 'Die Lehrerin übt das Vorstellen.',
  points: ['Sich mit Namen vorstellen'],
  vocabulary: [{ ar: 'اِسْم', de: 'Name' }],
  grammar: ['Das Suffix -ī'],
};

function setup(props: {
  summary: SummaryState | null;
  teacher: boolean;
  canSummarize?: boolean;
  hasTranscript?: boolean;
}) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? 'GET',
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(null, { status: init?.method === 'POST' ? 202 : 204 });
  });
  const onChange = vi.fn();
  render(
    <SummaryPanel
      api={new InteractiveApi(fetchImpl as typeof fetch)}
      classId="c1"
      mediaId="m1"
      summary={props.summary}
      teacher={props.teacher}
      canSummarize={props.canSummarize ?? true}
      hasTranscript={props.hasTranscript ?? true}
      onChange={onChange}
    />
  );
  return { requests, onChange };
}

describe('Lesson summary', () => {
  it('lets the teacher ask for a summary', async () => {
    const { requests, onChange } = setup({ summary: null, teacher: true });
    await userEvent.click(
      screen.getByRole('button', { name: 'Zusammenfassung erstellen' })
    );
    expect(requests).toEqual([
      { method: 'POST', path: '/api/v1/classes/c1/media/m1/summary', body: null },
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows a draft to the teacher and publishes it', async () => {
    const { requests } = setup({
      summary: { status: 'ready', error: null, content: CONTENT, publishedAt: null },
      teacher: true,
    });
    expect(screen.getByText(/Entwurf – nur du siehst ihn/)).toBeTruthy();
    expect(screen.getByText('Name')).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: 'Für die Klasse freigeben' })
    );
    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/v1/classes/c1/media/m1/summary',
      body: { published: true },
    });
  });

  it('asks for a transcript first and shows a failed run', () => {
    setup({
      summary: {
        status: 'failed',
        error: 'model down',
        content: null,
        publishedAt: null,
      },
      teacher: true,
      hasTranscript: false,
    });
    expect(screen.getByText(/braucht die Aufnahme zuerst ein Transkript/)).toBeTruthy();
    expect(screen.getByText(/model down/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Zusammenfassung erstellen' })
    ).toBeNull();
  });

  it('shows learners only a published summary, without buttons', async () => {
    setup({
      summary: {
        status: 'ready',
        error: null,
        content: CONTENT,
        publishedAt: '2026-09-26',
      },
      teacher: false,
    });
    expect(screen.getByRole('heading', { name: 'Zusammenfassung' })).toBeTruthy();
    expect(screen.getByText('Die Lehrerin übt das Vorstellen.')).toBeVisible();
    // Only the fold button, no teacher actions; folding hides the text.
    const fold = screen.getByRole('button');
    expect(fold).toHaveAccessibleName(/Zuklappen/);
    await userEvent.click(fold);
    expect(screen.getByText('Die Lehrerin übt das Vorstellen.')).not.toBeVisible();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    localStorage.clear();
  });

  it('shows nothing to learners without a summary', () => {
    const { container } = render(<div />);
    setup({ summary: null, teacher: false });
    expect(screen.queryByText('Zusammenfassung')).toBeNull();
    expect(container).toBeTruthy();
  });
});
