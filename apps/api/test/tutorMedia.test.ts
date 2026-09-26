/** Recording access for the tutor (story 10.2): membership, drafts and transcript window. */
import { describe, expect, it } from 'vitest';
import type { MediaItem } from '../src/media/repository.js';
import { ClassMediaAccess } from '../src/tutor/media.js';

const CLASS = '11111111-1111-4111-8111-111111111111';
const MEDIA = '22222222-2222-4222-8222-222222222222';
const actor = { id: 'u1', role: 'student' as const };

function access(opts: {
  role: 'teacher' | 'student' | null;
  published?: boolean;
  status?: string;
  transcript?: boolean;
}) {
  const item = {
    id: MEDIA,
    classId: CLASS,
    title: 'Stunde 3',
    status: opts.status ?? 'ready',
    publishedAt: opts.published === false ? null : '2026-09-20T10:00:00.000Z',
  } as unknown as MediaItem;
  return new ClassMediaAccess(
    { byId: async (id) => (id === MEDIA ? item : null) },
    { scope: async () => ({ classRole: opts.role }) },
    {
      transcript: async () =>
        opts.transcript === false
          ? null
          : {
              status: 'ready' as const,
              source: 'whisper' as const,
              error: null,
              progress: null,
              updatedAt: '',
              cues: [
                { start: 5, end: 9, text: 'بِسْمِ اللهِ' },
                { start: 100, end: 104, text: 'الدَّرْسُ الثّالِثُ' },
                { start: 300, end: 305, text: 'مَعَ السَّلامَة' },
              ],
            },
    }
  );
}

describe('ClassMediaAccess', () => {
  it('gives members the lines around the moment', async () => {
    const segment = await access({ role: 'student' }).segment(actor, MEDIA, 120);
    expect(segment).toEqual({
      title: 'Stunde 3',
      fromSec: 75,
      toSec: 165,
      text: '[100s] الدَّرْسُ الثّالِثُ',
    });
  });

  it('refuses non-members and students on drafts; teachers see drafts', async () => {
    expect(await access({ role: null }).segment(actor, MEDIA, 10)).toBe('forbidden');
    expect(
      await access({ role: 'student', published: false }).segment(actor, MEDIA, 10)
    ).toBe('forbidden');
    const draft = await access({ role: 'teacher', published: false }).segment(
      actor,
      MEDIA,
      10
    );
    expect(draft).toMatchObject({ text: '[5s] بِسْمِ اللهِ' });
  });

  it('reports unknown and unfinished recordings, and a missing transcript', async () => {
    expect(await access({ role: 'student' }).segment(actor, CLASS, 10)).toBe('not_found');
    expect(
      await access({ role: 'student', status: 'processing' }).segment(actor, MEDIA, 10)
    ).toBe('not_found');
    const bare = await access({ role: 'student', transcript: false }).segment(
      actor,
      MEDIA,
      10
    );
    expect(bare).toMatchObject({ text: '(no transcript for this part yet)', fromSec: 0 });
  });
});
