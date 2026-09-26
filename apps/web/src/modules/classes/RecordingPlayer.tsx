/**
 * Player for a class recording (stories 7.5, 8.1, 8.2, 8.4): video or audio from object
 * storage, the transcript with the current line, checkpoints that pause playback, and an
 * offline copy of the audio. Played time (not seeking) counts; at 85 % the recording is heard
 * (XP, synced). Teachers also edit checkpoints and the transcript here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { playableUrl } from '@/native/install';
import { dueCheckpoint, type Checkpoint, type Cue } from '@/services/media/checkpoints';
import { InteractiveApi, type Interactive } from '@/services/media/interactiveApi';
import { MediaApi } from '@/services/media/mediaApi';
import { useMediaSession } from '@/services/media/mediaSession';
import {
  offlineAudioUrl,
  offlineMeta,
  offlineSupported,
  removeOffline,
  saveOffline,
} from '@/services/media/offline';
import {
  useCelebrationStore,
  useEngagementStore,
  useListenStore,
  usePracticeStore,
} from '@/state';
import { formatDuration } from './ClassRecordings';
import { CheckpointDialog } from './player/CheckpointDialog';
import { CheckpointEditor, TranscriptEditor } from './player/RecordingEditors';
import { ChapterList } from './player/ChapterList';
import { SuggestionsEditor } from './player/SuggestionsEditor';
import { SummaryPanel } from './player/SummaryPanel';
import { TranscriptPanel } from './player/TranscriptPanel';

/** Save played time at least this often. */
const FLUSH_EVERY_SEC = 10;
const formatClock = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** A timeupdate step larger than this is a seek, not playing. */
const MAX_NATURAL_STEP_SEC = 2;

interface Loaded {
  title: string;
  durationSec: number | null;
  audio: string;
  video: string | null;
  offline: boolean;
  cues: Cue[];
  checkpoints: Checkpoint[];
  interactive: Interactive | null;
}

export function RecordingPlayer() {
  const { id = '', mediaId = '' } = useParams();
  const mediaApi = useMemo(() => new MediaApi(), []);
  const api = useMemo(() => new InteractiveApi(), []);
  const [media, setMedia] = useState<Loaded | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const tutorAvailable = useEngagementStore((s) => s.tutorAvailable);
  const [open, setOpen] = useState<Checkpoint | null>(null);
  const [saved, setSaved] = useState(false);
  const record = useListenStore((s) => s.record);
  const heard = useListenStore((s) => s.progress[`rec/${mediaId}`]);
  const practise = usePracticeStore((s) => s.practise);
  const practised = usePracticeStore((s) => s.records);
  const celebrate = useCelebrationStore((s) => s.show);
  const element = useRef<HTMLMediaElement | null>(null);
  const lastTime = useRef<number | null>(null);
  const pending = useRef(0);
  const shown = useRef(new Set<string>());

  const load = useCallback(async () => {
    const [play, interactive, cached] = await Promise.all([
      mediaApi.play(id, mediaId),
      api.get(id, mediaId),
      offlineMeta(mediaId),
    ]);
    setSaved(cached !== null);
    if (play.ok) {
      const data = interactive.ok ? interactive.value : null;
      setMedia({
        title: play.value.title,
        durationSec: play.value.durationSec,
        audio: play.value.audio,
        video: play.value.video,
        offline: false,
        cues: data?.transcript?.status === 'ready' ? data.transcript.cues : [],
        checkpoints: data?.checkpoints ?? [],
        interactive: data,
      });
      return;
    }
    // Offline (or the server is unreachable): the saved copy, if there is one.
    const audio = cached ? await offlineAudioUrl(mediaId) : null;
    if (cached && audio) {
      setMedia({
        title: cached.title,
        durationSec: cached.durationSec,
        audio,
        video: null,
        offline: true,
        cues: cached.cues,
        checkpoints: cached.checkpoints,
        interactive: null,
      });
      return;
    }
    setMessage(play.message);
  }, [api, id, mediaApi, mediaId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Transcript, checkpoints and summary only: the media URLs stay, so playback never
  // restarts while the page looks again for a running transcript or summary.
  // Polls and button refreshes may overlap: only the newest answer is applied.
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++latest.current;
    const result = await api.get(id, mediaId);
    if (!result.ok || request !== latest.current) return;
    const data = result.value;
    setMedia(
      (m) =>
        m && {
          ...m,
          cues: data.transcript?.status === 'ready' ? data.transcript.cues : [],
          checkpoints: data.checkpoints,
          interactive: data,
        }
    );
  }, [api, id, mediaId]);

  // Tell the teacher when an automatic transcript is done (they may be elsewhere on the page).
  const transcriptStatus = media?.interactive?.transcript?.status;
  const lastStatus = useRef(transcriptStatus);
  useEffect(() => {
    const before = lastStatus.current;
    lastStatus.current = transcriptStatus;
    if (
      (before === 'queued' || before === 'processing') &&
      transcriptStatus === 'ready'
    ) {
      celebrate({ title: 'Transkript ist fertig', xp: 0, big: false });
    }
  }, [transcriptStatus, celebrate]);

  const done = useMemo(() => {
    const ids = new Set(shown.current);
    for (const cp of media?.checkpoints ?? []) {
      if (practised[`0:checkpoint:${mediaId}/${cp.id}`]) ids.add(cp.id);
    }
    return ids;
  }, [media, practised, mediaId]);

  useMediaSession(media?.title, element);

  if (message) return <p className="feedback-bad">{message}</p>;
  if (!media) return <p className="muted">Lade Aufnahme …</p>;

  const flush = async (el: HTMLMediaElement) => {
    const played = pending.current;
    pending.current = 0;
    if (played <= 0) return;
    const outcome = await record(
      {
        id: `rec/${mediaId}`,
        url: `recording:${mediaId}`,
        lessonKey: `rec/${id}`,
        lessonSize: Number.MAX_SAFE_INTEGER,
        source: 'recording',
      },
      played,
      el.duration || media.durationSec || 0
    );
    if (outcome.trackHeard) {
      celebrate({ title: `Aufnahme gehört: ${media.title}`, xp: outcome.xp, big: false });
    }
  };

  const answered = async (cp: Checkpoint, correct: boolean) => {
    setOpen(null);
    shown.current.add(cp.id);
    if (correct) {
      const outcome = await practise(0, 'checkpoint', `${mediaId}/${cp.id}`, []);
      if (outcome.first)
        celebrate({ title: 'Checkpoint geschafft', xp: outcome.xp, big: false });
    }
    void element.current?.play();
  };

  const handlers = {
    ref: (el: HTMLMediaElement | null) => {
      element.current = el;
    },
    onPlay: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      lastTime.current = e.currentTarget.currentTime;
    },
    onSeeked: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      lastTime.current = e.currentTarget.currentTime;
    },
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      const now = el.currentTime;
      const previous = lastTime.current;
      if (previous !== null && !el.seeking) {
        const step = now - previous;
        if (step > 0 && step < MAX_NATURAL_STEP_SEC) pending.current += step;
        const due = dueCheckpoint(media.checkpoints, previous, now, done);
        if (due && !open) {
          el.pause();
          setOpen(due);
        }
      }
      lastTime.current = now;
      setTime(now);
      if (pending.current >= FLUSH_EVERY_SEC) void flush(el);
    },
    onPause: (e: React.SyntheticEvent<HTMLMediaElement>) => void flush(e.currentTarget),
    onEnded: (e: React.SyntheticEvent<HTMLMediaElement>) => void flush(e.currentTarget),
  };
  const seek = (seconds: number) => {
    if (element.current) {
      element.current.currentTime = seconds;
      lastTime.current = seconds;
    }
  };
  const percent = heard
    ? Math.round((heard.listenedSec / Math.max(1, heard.durationSec)) * 100)
    : 0;
  const teacher = media.interactive?.canEdit === true;

  const toggleOffline = async () => {
    if (saved) {
      await removeOffline(mediaId);
      setSaved(false);
      return;
    }
    const ok = await saveOffline(
      {
        mediaId,
        classId: id,
        title: media.title,
        durationSec: media.durationSec,
        cues: media.cues,
        checkpoints: media.checkpoints,
      },
      media.audio
    );
    setSaved(ok);
    if (!ok) setMessage('Offline speichern hat nicht geklappt.');
  };

  return (
    <div className="stack" style={{ gap: '1rem' }}>
      <Link to={`/classes/${id}`} className="muted">
        ← Zur Klasse
      </Link>
      <h1>{media.title}</h1>
      <span className="muted">
        {formatDuration(media.durationSec)}
        {heard?.completedAt ? ' · ✓ gehört' : percent > 0 ? ` · ${percent} % gehört` : ''}
        {media.offline && ' · offline gespeichert'}
      </span>
      {media.video ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={playableUrl(media.video)}
          style={{ width: '100%', borderRadius: 12, background: '#000' }}
          aria-label={media.title}
          {...handlers}
        />
      ) : (
        <audio
          controls
          preload="metadata"
          src={playableUrl(media.audio)}
          style={{ width: '100%' }}
          aria-label={media.title}
          {...handlers}
        />
      )}
      {open && (
        <CheckpointDialog checkpoint={open} onDone={(ok) => void answered(open, ok)} />
      )}
      {tutorAvailable && (
        <Link
          to={`/tutor?media=${encodeURIComponent(mediaId)}&t=${Math.floor(time)}`}
          className="btn"
          style={{ alignSelf: 'flex-start' }}
        >
          Frag al-Muʿallim zu dieser Minute ({formatClock(time)})
        </Link>
      )}
      {offlineSupported() && !media.offline && (
        <button
          className="btn"
          onClick={() => void toggleOffline()}
          style={{ alignSelf: 'flex-start' }}
        >
          {saved ? 'Offline-Kopie löschen' : 'Audio offline speichern'}
        </button>
      )}
      {media.checkpoints.length > 0 && (
        <span className="muted" style={{ fontSize: '0.9rem' }}>
          {media.checkpoints.length} Checkpoints · {done.size} erledigt
        </span>
      )}
      <ChapterList
        chapters={media.interactive?.chapters ?? []}
        time={time}
        onSeek={seek}
        onRemove={
          teacher
            ? (chapter) =>
                void api.removeChapter(id, mediaId, chapter.id).then(() => load())
            : undefined
        }
      />
      {media.interactive && (
        <SummaryPanel
          api={api}
          classId={id}
          mediaId={mediaId}
          summary={media.interactive.summary ?? null}
          teacher={teacher}
          canSummarize={media.interactive.canSummarize ?? false}
          hasTranscript={media.cues.length > 0}
          onChange={() => void refresh()}
        />
      )}
      <TranscriptPanel cues={media.cues} time={time} onSeek={seek} />
      {teacher && media.interactive && (
        <>
          <CheckpointEditor
            api={api}
            classId={id}
            mediaId={mediaId}
            checkpoints={media.checkpoints}
            currentTime={() => element.current?.currentTime ?? 0}
            onChange={() => void refresh()}
          />
          {media.interactive.canSuggest && media.cues.length > 0 && (
            <SuggestionsEditor
              api={api}
              classId={id}
              mediaId={mediaId}
              onChange={() => void refresh()}
            />
          )}
          <TranscriptEditor
            // New server cues (ready, saved) replace the draft; progress updates do not.
            key={
              media.interactive.transcript?.status === 'ready'
                ? media.interactive.transcript.updatedAt
                : (media.interactive.transcript?.status ?? 'none')
            }
            api={api}
            classId={id}
            mediaId={mediaId}
            transcript={media.interactive.transcript}
            canGenerate={media.interactive.canGenerate}
            currentTime={() => element.current?.currentTime ?? 0}
            onChange={() => void refresh()}
          />
        </>
      )}
    </div>
  );
}
