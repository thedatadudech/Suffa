/**
 * Transcripts, checkpoints, the class AI switch and assignments against Postgres and S3
 * (stories 8.1, 8.2, 8.5). Needs SUFFA_TEST_DATABASE_URL and SUFFA_TEST_S3_ENDPOINT.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthResolver } from '../src/auth/resolver.js';
import type { Role } from '../src/authz/policies.js';
import { PgAssignmentRepository } from '../src/classes/assignments.js';
import { PgClassRepository } from '../src/classes/repository.js';
import {
  PgInteractiveRepository,
  transcribeRecording,
} from '../src/media/interactive.js';
import { PgMediaRepository } from '../src/media/repository.js';
import { loadMigrations, migrate } from '../src/migrate.js';
import { S3ObjectStorage } from '../src/storage/s3Storage.js';
import { PgSyncRepository } from '../src/sync/repository.js';

const dbUrl = process.env.SUFFA_TEST_DATABASE_URL;
const s3 = process.env.SUFFA_TEST_S3_ENDPOINT;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe.skipIf(!dbUrl || !s3)(
  'Interactive recordings and assignments (Postgres + S3)',
  () => {
    let pool: pg.Pool;
    let app: ReturnType<typeof createApp>;
    let media: PgMediaRepository;
    let interactive: PgInteractiveRepository;
    let storage: S3ObjectStorage;
    const queued: string[] = [];
    const classId = randomUUID();
    const mediaId = randomUUID();
    const draftId = randomUUID();
    const users: Record<string, { id: string; role: Role }> = {};
    const settings = {
      endpoint: s3!,
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      buckets: {
        media: 'suffa-media',
        uploads: 'suffa-uploads',
        content: 'suffa-content',
      },
    };

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
      await pool.query('drop schema public cascade; create schema public');
      await migrate(
        pool,
        await loadMigrations(join(import.meta.dirname, '..', 'migrations')),
        quiet
      );
      const client = new S3Client({
        ...settings,
        forcePathStyle: true,
        credentials: settings,
      });
      await client
        .send(new CreateBucketCommand({ Bucket: 'suffa-media' }))
        .catch(() => undefined);
      for (const [name, role] of [
        ['teacher', 'teacher'],
        ['amina', 'student'],
        ['bilal', 'student'],
      ] as const) {
        const id = randomUUID();
        await pool.query('insert into users (id, email, role) values ($1, $2, $3)', [
          id,
          `${name}@example.org`,
          role,
        ]);
        users[name] = { id, role };
      }
      await pool.query("insert into classes (id, name) values ($1, 'Arabisch 1a')", [
        classId,
      ]);
      await pool.query(
        `insert into class_members (class_id, user_id, class_role, status)
       values ($1, $2, 'teacher', 'active'), ($1, $3, 'student', 'active'), ($1, $4, 'student', 'active')`,
        [classId, users.teacher!.id, users.amina!.id, users.bilal!.id]
      );
      media = new PgMediaRepository(pool);
      interactive = new PgInteractiveRepository(pool);
      storage = new S3ObjectStorage(settings);
      for (const [id, published] of [
        [mediaId, true],
        [draftId, false],
      ] as const) {
        await media.create({
          id,
          classId,
          createdBy: users.teacher!.id,
          title: published ? 'Stunde 1' : 'Entwurf',
          source: 'upload',
          status: 'ready',
          originalKey: `recordings/${classId}/${id}/original.m4a`,
          originalName: 'a.m4a',
          originalSize: 10,
          contentType: 'audio/mp4',
          uploadId: null,
          driveFileId: null,
        });
        await media.update(id, {
          durationSec: 120,
          renditions: { audio: `recordings/${classId}/${id}/audio.m4a` },
        });
        if (published) await media.publish(id, users.teacher!.id);
      }
      await storage.put(
        'media',
        `recordings/${classId}/${mediaId}/audio.m4a`,
        new Uint8Array([1, 2]),
        'audio/mp4'
      );
      const classes = new PgClassRepository(pool);
      const auth: AuthResolver = {
        actor: async (h) => users[h.get('x-test-user') ?? ''] ?? null,
      };
      app = createApp({
        version: 'test',
        expectedRevision: null,
        health: {
          schemaRevision: async () => null,
          queueDepth: async () => ({ waiting: 0, active: 0, failed: 0, deadLetter: 0 }),
        },
        interactive: {
          classes,
          media,
          interactive,
          transcribe: async (id) => {
            queued.push(id);
          },
          auth,
          log: quiet,
        },
        assignments: {
          classes,
          repo: new PgAssignmentRepository(pool),
          auth,
          log: quiet,
        },
      });
    });

    afterAll(async () => {
      await pool?.end();
    });

    const call = (who: string, method: string, path: string, body?: unknown) =>
      app.request(`/api/v1/classes/${classId}${path}`, {
        method,
        headers: { 'x-test-user': who, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    it('adds and validates checkpoints; learners see them on published recordings only', async () => {
      const add = (body: unknown) =>
        call('teacher', 'POST', `/media/${mediaId}/checkpoints`, body);
      const mcq = await add({
        atSec: 30,
        data: {
          kind: 'mcq',
          question: 'Was heißt كتاب?',
          options: ['Buch', 'Haus'],
          answer: 0,
        },
      });
      expect(mcq.status).toBe(201);
      expect(
        (await add({ atSec: 60, data: { kind: 'dictation', answer: 'مرحبا' } })).status
      ).toBe(201);
      expect(
        (
          await add({
            atSec: 10,
            data: { kind: 'mcq', question: 'x', options: ['a', 'b'], answer: 5 },
          })
        ).status
      ).toBe(400);
      expect(
        (await add({ atSec: 999, data: { kind: 'dictation', answer: 'x' } })).status
      ).toBe(400);
      expect(
        (
          await call('amina', 'POST', `/media/${mediaId}/checkpoints`, {
            atSec: 1,
            data: { kind: 'dictation', answer: 'x' },
          })
        ).status
      ).toBe(403);

      const seen = (await (
        await call('amina', 'GET', `/media/${mediaId}/interactive`)
      ).json()) as {
        checkpoints: { atSec: number; data: { kind: string } }[];
        canGenerate: boolean;
      };
      expect(seen.checkpoints.map((c) => [c.atSec, c.data.kind])).toEqual([
        [30, 'mcq'],
        [60, 'dictation'],
      ]);
      expect(seen.canGenerate).toBe(false);
      expect((await call('amina', 'GET', `/media/${draftId}/interactive`)).status).toBe(
        404
      );
      const { id } = (await mcq.json()) as { id: string };
      expect(
        (await call('teacher', 'DELETE', `/media/${mediaId}/checkpoints/${id}`)).status
      ).toBe(204);
    });

    it('edits transcripts and respects the class AI switch', async () => {
      expect(
        (
          await call('teacher', 'PUT', `/media/${mediaId}/transcript`, {
            cues: [
              { start: 5, end: 8, text: 'مرحبا' },
              { start: 0, end: 4, text: 'السلام عليكم' },
              { start: 9, end: 9, text: '' },
            ],
          })
        ).status
      ).toBe(204);
      const view = (await (
        await call('amina', 'GET', `/media/${mediaId}/interactive`)
      ).json()) as {
        transcript: { cues: { text: string }[]; source: string };
      };
      expect(view.transcript.cues.map((c) => c.text)).toEqual(['السلام عليكم', 'مرحبا']);

      expect(
        (await call('teacher', 'POST', `/media/${mediaId}/transcript/generate`)).status
      ).toBe(202);
      expect(queued).toEqual([mediaId]);
      // Pressed again while it waits: no second job; after 10 minutes without news, yes.
      await call('teacher', 'POST', `/media/${mediaId}/transcript/generate`);
      expect(queued).toEqual([mediaId]);
      await pool.query(
        `update media_transcripts set updated_at = now() - interval '11 minutes' where media_id = $1`,
        [mediaId]
      );
      await call('teacher', 'POST', `/media/${mediaId}/transcript/generate`);
      expect(queued).toEqual([mediaId, mediaId]);
      expect(
        (await call('teacher', 'PATCH', '/settings', { aiEnabled: false })).status
      ).toBe(204);
      expect(await (await call('teacher', 'GET', '/settings')).json()).toEqual({
        aiEnabled: false,
      });
      expect(
        (await call('teacher', 'POST', `/media/${mediaId}/transcript/generate`)).status
      ).toBe(409);
      // A job queued before the switch does not send the audio anywhere.
      let called = false;
      await transcribeRecording(
        {
          media,
          interactive,
          storage,
          transcriber: { transcribe: async () => ((called = true), []) },
          log: quiet,
        },
        mediaId
      );
      expect(called).toBe(false);
      expect(await interactive.transcript(mediaId)).toMatchObject({ status: 'failed' });

      await call('teacher', 'PATCH', '/settings', { aiEnabled: true });
      const seen: (number | null)[] = [];
      await transcribeRecording(
        {
          media,
          interactive,
          storage,
          transcriber: {
            transcribe: async (_file, onProgress) => {
              seen.push((await interactive.transcript(mediaId))!.progress);
              await onProgress?.(0.5);
              seen.push((await interactive.transcript(mediaId))!.progress);
              return [{ start: 0, end: 2, text: 'أهلا' }];
            },
          },
          log: quiet,
        },
        mediaId
      );
      // The teacher sees how far it has come: 5 % after the download, then per piece.
      expect(seen).toEqual([5, 52]);
      expect(await interactive.transcript(mediaId)).toMatchObject({
        status: 'ready',
        progress: null,
        cues: [{ start: 0, end: 2, text: 'أهلا' }],
      });
    });

    it('sets assignments and derives who is done', async () => {
      const due = '2026-10-10T20:00:00.000Z';
      const add = (body: unknown) => call('teacher', 'POST', '/assignments', body);
      expect(
        (
          await add({
            kind: 'unit',
            ref: '3',
            title: 'Einheit 3 abschließen',
            dueAt: due,
          })
        ).status
      ).toBe(201);
      expect(
        (
          await add({
            kind: 'recording',
            ref: mediaId,
            title: 'Stunde 1 anhören',
            dueAt: due,
          })
        ).status
      ).toBe(201);
      expect(
        (await add({ kind: 'recording', ref: draftId, title: 'Entwurf', dueAt: due }))
          .status
      ).toBe(404);
      expect(
        (await add({ kind: 'unit', ref: '17', title: 'x', dueAt: due })).status
      ).toBe(400);

      // Amina passed unit 3 and heard the recording; Bilal did nothing.
      const sync = new PgSyncRepository(pool);
      await sync.upsert(users.amina!.id, 'exam_results', [
        {
          id: 'e1',
          format: 'mixed_chapter',
          units: [3],
          score: 9,
          total: 10,
          items: [],
          startedAt: due,
          finishedAt: due,
          updated_at: due,
          deleted: false,
        },
      ]);
      await sync.upsert(users.amina!.id, 'media_progress', [
        {
          id: `rec/${mediaId}`,
          source: 'recording',
          ref: `recording:${mediaId}`,
          lessonKey: `rec/${classId}`,
          durationSec: 120,
          listenedSec: 110,
          completedAt: due,
          updated_at: due,
          deleted: false,
        },
      ]);

      const mine = (await (await call('amina', 'GET', '/assignments')).json()) as {
        assignments: { title: string; done: boolean; doneCount: number | null }[];
      };
      expect(mine.assignments.map((a) => [a.title, a.done, a.doneCount])).toEqual([
        ['Einheit 3 abschließen', true, null],
        ['Stunde 1 anhören', true, null],
      ]);
      const bilal = (await (await call('bilal', 'GET', '/assignments')).json()) as {
        assignments: { done: boolean }[];
      };
      expect(bilal.assignments.map((a) => a.done)).toEqual([false, false]);
      const teacher = (await (await call('teacher', 'GET', '/assignments')).json()) as {
        assignments: { id: string; doneCount: number; learners: number; done: null }[];
      };
      expect(teacher.assignments.map((a) => [a.doneCount, a.learners, a.done])).toEqual([
        [1, 2, null],
        [1, 2, null],
      ]);
      expect(
        (await call('amina', 'DELETE', `/assignments/${teacher.assignments[0]!.id}`))
          .status
      ).toBe(403);
      expect(
        (await call('teacher', 'DELETE', `/assignments/${teacher.assignments[0]!.id}`))
          .status
      ).toBe(204);
    });
  }
);
