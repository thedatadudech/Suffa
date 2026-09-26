/**
 * Lesson summary under the player: learners read the published summary; the teacher asks the
 * EU model for one, reads it and publishes or hides it for the class.
 */
import { useEffect, useRef, useState } from 'react';
import { ArabicText, CollapsibleCard, InlineMarkdown } from '@/components';
import type {
  InteractiveApi,
  LessonSummary,
  SummaryState,
} from '@/services/media/interactiveApi';

/** How often a running summary is checked. */
const POLL_MS = 5000;

export function SummaryContent({ content }: { content: LessonSummary }) {
  return (
    <div className="stack summary-body" style={{ gap: '0.6rem' }}>
      <p style={{ margin: 0 }}>
        <InlineMarkdown>{content.overview}</InlineMarkdown>
      </p>
      {content.points.length > 0 && (
        <ul style={{ margin: 0, paddingInlineStart: '1.2rem' }}>
          {content.points.map((p) => (
            <li key={p}>
              <InlineMarkdown>{p}</InlineMarkdown>
            </li>
          ))}
        </ul>
      )}
      {content.vocabulary.length > 0 && (
        <div className="stack" style={{ gap: '0.3rem' }}>
          <strong style={{ fontSize: '0.95rem' }}>Neue Wörter</strong>
          <ul
            className="stack"
            style={{ listStyle: 'none', padding: 0, margin: 0, gap: '0.2rem' }}
          >
            {content.vocabulary.map((v) => (
              <li
                key={`${v.ar}|${v.de}`}
                className="row"
                style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}
              >
                <ArabicText>{v.ar}</ArabicText>
                <span className="muted">
                  <InlineMarkdown>{v.de}</InlineMarkdown>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {content.grammar.length > 0 && (
        <div className="stack" style={{ gap: '0.3rem' }}>
          <strong style={{ fontSize: '0.95rem' }}>Grammatik</strong>
          <ul style={{ margin: 0, paddingInlineStart: '1.2rem' }}>
            {content.grammar.map((g) => (
              <li key={g}>
                <InlineMarkdown>{g}</InlineMarkdown>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SummaryPanel({
  api,
  classId,
  mediaId,
  summary,
  teacher,
  canSummarize,
  hasTranscript,
  onChange,
}: {
  api: InteractiveApi;
  classId: string;
  mediaId: string;
  summary: SummaryState | null;
  teacher: boolean;
  canSummarize: boolean;
  hasTranscript: boolean;
  onChange: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const running = summary?.status === 'queued' || summary?.status === 'running';

  // While the model works, look again every few seconds. The callback sits in a ref so the
  // player's frequent re-renders (playback time) do not restart the timer.
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => changed.current(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!teacher) {
    if (!summary?.content) return null;
    return (
      <CollapsibleCard id="summary" title="Zusammenfassung">
        <SummaryContent content={summary.content} />
      </CollapsibleCard>
    );
  }
  if (!canSummarize && !summary) return null;

  const request = async () => {
    const result = await api.requestSummary(classId, mediaId);
    setMessage(result.ok ? null : result.message);
    if (result.ok) onChange();
  };
  const publish = async (published: boolean) => {
    const result = await api.publishSummary(classId, mediaId, published);
    setMessage(result.ok ? null : result.message);
    if (result.ok) onChange();
  };

  return (
    <CollapsibleCard id="summary" title="Zusammenfassung (KI)">
      {running && <span className="muted">Die Zusammenfassung wird erstellt …</span>}
      {summary?.status === 'failed' && (
        <span className="feedback-bad">
          Das hat nicht geklappt{summary.error ? `: ${summary.error}` : '.'}
        </span>
      )}
      {summary?.content && summary.status === 'ready' && (
        <>
          <span className="muted" style={{ fontSize: '0.9rem' }}>
            {summary.publishedAt
              ? '✓ Für die Klasse sichtbar.'
              : 'Entwurf – nur du siehst ihn. Lies ihn, bevor du ihn freigibst.'}
          </span>
          <SummaryContent content={summary.content} />
        </>
      )}
      <div className="row">
        {canSummarize && hasTranscript && !running && (
          <button className="btn" onClick={() => void request()}>
            {summary?.content ? 'Neu erstellen' : 'Zusammenfassung erstellen'}
          </button>
        )}
        {summary?.content && summary.status === 'ready' && (
          <button
            className={summary.publishedAt ? 'btn' : 'btn btn-primary'}
            onClick={() => void publish(!summary.publishedAt)}
          >
            {summary.publishedAt
              ? 'Für die Klasse verbergen'
              : 'Für die Klasse freigeben'}
          </button>
        )}
      </div>
      {canSummarize && !hasTranscript && (
        <span className="muted" style={{ fontSize: '0.9rem' }}>
          Für eine Zusammenfassung braucht die Aufnahme zuerst ein Transkript.
        </span>
      )}
      {message && <span className="feedback-bad">{message}</span>}
    </CollapsibleCard>
  );
}
