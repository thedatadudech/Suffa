/**
 * Interactive recordings (stories 8.1, 8.2): transcript cues and checkpoints per recording,
 * and the class's AI switch. The same model will serve YouTube lessons (ADR-0012).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';

export const Cue = z.object({
  start: z
    .number()
    .min(0)
    .max(24 * 3600),
  end: z
    .number()
    .min(0)
    .max(24 * 3600),
  text: z.string().trim().max(1000),
});
export type Cue = z.infer<typeof Cue>;
export const Cues = z.array(Cue).max(5000);

const shortText = z.string().trim().min(1).max(200);
export const CheckpointData = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mcq'),
    question: shortText,
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(6),
    answer: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal('dictation'),
    prompt: z.string().trim().max(200).default(''),
    answer: shortText,
  }),
  z.object({
    kind: z.literal('vocab_flash'),
    ar: shortText,
    de: shortText,
    /** Vocabulary id of the book, so learners can add the word to their cards. */
    contentRef: z.string().max(64).nullish(),
  }),
]);
export type CheckpointData = z.infer<typeof CheckpointData>;

export interface Checkpoint {
  id: string;
  atSec: number;
  data: CheckpointData;
}

export interface Transcript {
  status: 'queued' | 'processing' | 'ready' | 'failed';
  source: 'whisper' | 'manual';
  cues: Cue[];
  error: string | null;
  /** 0–100 while an automatic transcript is being made, otherwise null. */
  progress: number | null;
  updatedAt: string;
}

export interface InteractiveRepository {
  transcript(mediaId: string): Promise<Transcript | null>;
  saveTranscript(
    mediaId: string,
    change: Partial<
      Pick<Transcript, 'status' | 'source' | 'cues' | 'error' | 'progress'>
    >,
    editedBy?: string
  ): Promise<void>;
  checkpoints(mediaId: string): Promise<Checkpoint[]>;
  addCheckpoint(
    mediaId: string,
    atSec: number,
    data: CheckpointData,
    by: string
  ): Promise<Checkpoint>;
  removeCheckpoint(mediaId: string, id: string): Promise<boolean>;
  aiEnabled(classId: string): Promise<boolean>;
  setAiEnabled(classId: string, enabled: boolean): Promise<void>;
}

export class PgInteractiveRepository implements InteractiveRepository {
  constructor(private readonly pool: pg.Pool) {}

  async transcript(mediaId: string): Promise<Transcript | null> {
    const { rows } = await this.pool.query(
      'select * from media_transcripts where media_id = $1',
      [mediaId]
    );
    const r = rows[0];
    return r
      ? {
          status: r.status,
          source: r.source,
          cues: r.cues,
          error: r.error,
          progress: r.progress ?? null,
          updatedAt: r.updated_at.toISOString(),
        }
      : null;
  }

  async saveTranscript(
    mediaId: string,
    change: Partial<
      Pick<Transcript, 'status' | 'source' | 'cues' | 'error' | 'progress'>
    >,
    editedBy?: string
  ) {
    await this.pool.query(
      `insert into media_transcripts (media_id, status, source, cues, error, edited_by, progress)
       values ($1, coalesce($2, 'ready'), coalesce($3, 'manual'), coalesce($4::jsonb, '[]'::jsonb), $5, $6, $7)
       on conflict (media_id) do update set
         status = coalesce($2, media_transcripts.status),
         source = coalesce($3, media_transcripts.source),
         cues = coalesce($4::jsonb, media_transcripts.cues),
         error = $5,
         edited_by = coalesce($6, media_transcripts.edited_by),
         progress = $7,
         updated_at = now()`,
      [
        mediaId,
        change.status ?? null,
        change.source ?? null,
        change.cues ? JSON.stringify(change.cues) : null,
        change.error ?? null,
        editedBy ?? null,
        change.progress ?? null,
      ]
    );
  }

  async checkpoints(mediaId: string) {
    const { rows } = await this.pool.query(
      'select id, at_sec, data from media_checkpoints where media_id = $1 order by at_sec, created_at',
      [mediaId]
    );
    return rows.map((r) => ({ id: r.id, atSec: r.at_sec, data: r.data }));
  }

  async addCheckpoint(mediaId: string, atSec: number, data: CheckpointData, by: string) {
    const id = randomUUID();
    await this.pool.query(
      `insert into media_checkpoints (id, media_id, at_sec, kind, data, created_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, mediaId, atSec, data.kind, JSON.stringify(data), by]
    );
    return { id, atSec, data };
  }

  async removeCheckpoint(mediaId: string, id: string) {
    const { rowCount } = await this.pool.query(
      'delete from media_checkpoints where media_id = $1 and id = $2',
      [mediaId, id]
    );
    return (rowCount ?? 0) > 0;
  }

  async aiEnabled(classId: string) {
    const { rows } = await this.pool.query(
      'select ai_enabled from classes where id = $1',
      [classId]
    );
    return rows[0]?.ai_enabled === true;
  }

  async setAiEnabled(classId: string, enabled: boolean) {
    await this.pool.query('update classes set ai_enabled = $2 where id = $1', [
      classId,
      enabled,
    ]);
  }
}

/** How often a running transcript touches its row; well below the 10-minute restart limit. */
export const HEARTBEAT_MS = 2 * 60 * 1000;

/** Worker step (story 8.1): the recording's audio → transcript cues. */
export async function transcribeRecording(
  deps: {
    media: import('./repository.js').MediaRepository;
    interactive: InteractiveRepository;
    storage: import('../storage/objectStorage.js').ObjectStorage;
    transcriber: import('./transcribe.js').Transcriber;
    log: Pick<import('pino').Logger, 'info' | 'warn'>;
  },
  mediaId: string
): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const item = await deps.media.byId(mediaId);
  if (!item?.renditions.audio) return;
  // The class may have switched AI off after the job was queued.
  if (!(await deps.interactive.aiEnabled(item.classId))) {
    await deps.interactive.saveTranscript(mediaId, {
      status: 'failed',
      source: 'whisper',
      error: 'KI ist für diese Klasse ausgeschaltet.',
    });
    return;
  }
  await deps.interactive.saveTranscript(mediaId, {
    status: 'processing',
    source: 'whisper',
    progress: 0,
  });
  const dir = await mkdtemp(join(tmpdir(), 'suffa-transcribe-'));
  try {
    const audio = join(dir, 'audio.m4a');
    await deps.storage.download('media', item.renditions.audio, audio);
    // The download is the first 5 %, the pieces the rest.
    await deps.interactive.saveTranscript(mediaId, { progress: 5 });
    // Pieces finish in parallel: the updates go out one after another, so the bar never
    // steps back. A heartbeat keeps the row fresh during a long piece, so the teacher is
    // only offered a restart when the worker is really gone.
    let progress = 5;
    let saved = Promise.resolve();
    const write = () => {
      saved = saved.then(() => deps.interactive.saveTranscript(mediaId, { progress }));
      return saved;
    };
    const heartbeat = setInterval(() => void write().catch(() => {}), HEARTBEAT_MS);
    let cues: Cue[];
    try {
      cues = await deps.transcriber.transcribe(audio, (done) => {
        progress = 5 + Math.floor(done * 94);
        return write();
      });
    } finally {
      clearInterval(heartbeat);
      await saved.catch(() => {});
    }
    await deps.interactive.saveTranscript(mediaId, {
      status: 'ready',
      cues,
      error: null,
    });
    deps.log.info({ mediaId, cues: cues.length }, 'media.transcribed');
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
    await deps.interactive.saveTranscript(mediaId, { status: 'failed', error: message });
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
