/**
 * Transcript, checkpoints and the class AI switch (stories 8.1, 8.2), mounted at /api/v1:
 *
 *   GET    /classes/:id/media/:mediaId/interactive  → { transcript, checkpoints, chapters }
 *                                                                           (class:read)
 *   PUT    /classes/:id/media/:mediaId/transcript  { cues }  → 204          (class:manage)
 *   POST   /classes/:id/media/:mediaId/transcript/generate → 202            (class:manage)
 *   POST   /classes/:id/media/:mediaId/checkpoints { atSec, data } → 201    (class:manage)
 *   DELETE /classes/:id/media/:mediaId/checkpoints/:checkpointId → 204      (class:manage)
 *   GET    /classes/:id/settings  → { aiEnabled }                           (class:manage)
 *   PATCH  /classes/:id/settings  { aiEnabled }  → 204                      (class:manage)
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthResolver } from '../auth/resolver.js';
import { authorize, type ActorEnv, type AuthorizeLog } from '../authz/middleware.js';
import type { Actor as PolicyActor, ClassScope } from '../authz/policies.js';
import { CheckpointData, Cues, type InteractiveRepository } from './interactive.js';
import type { SummaryRepository } from './summary.js';
import type { MediaRepository } from './repository.js';

/** A transcript run without progress for this long is taken as lost (a piece takes about a minute). */
export const STALE_TRANSCRIPT_MS = 10 * 60 * 1000;
export interface InteractiveRouteDeps {
  classes: { scope(classId: string, userId: string): Promise<ClassScope> };
  media: MediaRepository;
  interactive: InteractiveRepository;
  /** Queues a transcription; absent when no service is configured. */
  transcribe?: (mediaId: string) => Promise<void>;
  /** Chapters accepted from AI suggestions (story 11.4). */
  chapters?: {
    chapters(mediaId: string): Promise<{ id: string; atSec: number; title: string }[]>;
  };
  /** Whether AI suggestions can be requested (a model is configured). */
  canSuggest?: () => Promise<boolean>;
  /** Lesson summaries; learners only see published ones. */
  summaries?: Pick<SummaryRepository, 'get'>;
  /** Whether a summary can be requested (an EU model is configured). */
  canSummarize?: () => Promise<boolean>;
  auth: AuthResolver;
  log: AuthorizeLog;
}

const Uuid = z.string().uuid();
const NewCheckpoint = z
  .object({
    atSec: z
      .number()
      .min(0)
      .max(24 * 3600),
    data: CheckpointData,
  })
  .strict();
const Settings = z.object({ aiEnabled: z.boolean() }).strict();

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function createInteractiveRoutes(deps: InteractiveRouteDeps): Hono<ActorEnv> {
  const app = new Hono<ActorEnv>();
  const scope = async (c: Context, actor: PolicyActor) => {
    const id = Uuid.safeParse(c.req.param('id'));
    return id.success ? deps.classes.scope(id.data, actor.id) : { classRole: null };
  };
  const manage = authorize(deps.auth, 'class:manage', deps.log, scope);
  const read = authorize(deps.auth, 'class:read', deps.log, scope);
  const itemOf = async (c: Context<ActorEnv>) => {
    const mediaId = Uuid.safeParse(c.req.param('mediaId'));
    return mediaId.success ? deps.media.get(c.req.param('id')!, mediaId.data) : null;
  };

  app.get('/classes/:id/media/:mediaId/interactive', read, async (c) => {
    const item = await itemOf(c);
    const actor = c.get('actor');
    const manager =
      actor.role === 'admin' ||
      (await deps.classes.scope(c.req.param('id'), actor.id)).classRole === 'teacher';
    if (!item || (!item.publishedAt && !manager))
      return c.json({ error: 'not_found' }, 404);
    const [transcript, checkpoints, chapters, canSuggest, summary, canSummarize] =
      await Promise.all([
        deps.interactive.transcript(item.id),
        deps.interactive.checkpoints(item.id),
        deps.chapters?.chapters(item.id) ?? [],
        manager && deps.canSuggest ? deps.canSuggest() : false,
        deps.summaries?.get(item.id) ?? null,
        manager && deps.canSummarize ? deps.canSummarize() : false,
      ]);
    c.header('Cache-Control', 'no-store');
    return c.json({
      transcript,
      checkpoints,
      chapters,
      canEdit: manager,
      canGenerate: manager && Boolean(deps.transcribe),
      canSuggest,
      canSummarize,
      // Teachers see the run and drafts; learners only a published summary.
      summary: manager
        ? summary && {
            status: summary.status,
            error: summary.error,
            content: summary.summary,
            publishedAt: summary.publishedAt,
          }
        : summary?.publishedAt && summary.summary
          ? {
              status: 'ready',
              error: null,
              content: summary.summary,
              publishedAt: summary.publishedAt,
            }
          : null,
    });
  });

  app.put('/classes/:id/media/:mediaId/transcript', manage, async (c) => {
    const item = await itemOf(c);
    if (!item) return c.json({ error: 'not_found' }, 404);
    const parsed = z
      .object({ cues: Cues })
      .strict()
      .safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const cues = [...parsed.data.cues]
      .filter((cue) => cue.text && cue.end >= cue.start)
      .sort((a, b) => a.start - b.start);
    await deps.interactive.saveTranscript(
      item.id,
      { status: 'ready', cues, error: null },
      c.get('actor').id
    );
    return c.body(null, 204);
  });

  app.post('/classes/:id/media/:mediaId/transcript/generate', manage, async (c) => {
    const item = await itemOf(c);
    if (!item || item.status !== 'ready') return c.json({ error: 'not_found' }, 404);
    if (!deps.transcribe) return c.json({ error: 'transcription_unavailable' }, 409);
    if (!(await deps.interactive.aiEnabled(item.classId))) {
      return c.json({ error: 'ai_disabled' }, 409);
    }
    // A run that is still moving is left alone; one without progress for a while lost
    // its worker and is queued again.
    const current = await deps.interactive.transcript(item.id);
    const active = current?.status === 'queued' || current?.status === 'processing';
    if (active && Date.now() - Date.parse(current.updatedAt) < STALE_TRANSCRIPT_MS) {
      return c.body(null, 202);
    }
    await deps.interactive.saveTranscript(item.id, {
      status: 'queued',
      source: 'whisper',
    });
    await deps.transcribe(item.id);
    return c.body(null, 202);
  });

  app.post('/classes/:id/media/:mediaId/checkpoints', manage, async (c) => {
    const item = await itemOf(c);
    if (!item) return c.json({ error: 'not_found' }, 404);
    const parsed = NewCheckpoint.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const { atSec, data } = parsed.data;
    if (data.kind === 'mcq' && data.answer >= data.options.length) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    if (item.durationSec !== null && atSec > item.durationSec) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    return c.json(
      await deps.interactive.addCheckpoint(item.id, atSec, data, c.get('actor').id),
      201
    );
  });

  app.delete(
    '/classes/:id/media/:mediaId/checkpoints/:checkpointId',
    manage,
    async (c) => {
      const item = await itemOf(c);
      const cp = Uuid.safeParse(c.req.param('checkpointId'));
      if (!item || !cp.success) return c.json({ error: 'not_found' }, 404);
      return (await deps.interactive.removeCheckpoint(item.id, cp.data))
        ? c.body(null, 204)
        : c.json({ error: 'not_found' }, 404);
    }
  );

  app.get('/classes/:id/settings', manage, async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ aiEnabled: await deps.interactive.aiEnabled(c.req.param('id')) });
  });

  app.patch('/classes/:id/settings', manage, async (c) => {
    const parsed = Settings.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    await deps.interactive.setAiEnabled(c.req.param('id'), parsed.data.aiEnabled);
    return c.body(null, 204);
  });

  return app;
}
