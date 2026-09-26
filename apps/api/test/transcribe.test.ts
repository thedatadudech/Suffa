import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  CHUNK_SECONDS,
  OpenAiCompatibleTranscriber,
  slowServiceFetch,
  transcribeFile,
} from '../src/media/transcribe.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const settings = {
  url: 'https://stt.example/v1/audio/transcriptions',
  token: 'tok',
  model: 'whisper-1',
  language: 'ar' as string | null,
};

describe('transcription client', () => {
  it('sends Arabic audio and reads verbose_json segments or plain text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suffa-stt-'));
    const file = join(dir, 'a.m4a');
    await writeFile(file, 'audio');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          segments: [
            { start: 0, end: 1.5, text: ' مرحبا ' },
            { start: 2, end: 3, text: ' ' },
          ],
        })
      )
      .mockResolvedValueOnce(Response.json({ text: 'أهلا', duration: 4 }))
      .mockResolvedValueOnce(new Response('quota', { status: 429 }));
    const fetchFn = fetchImpl as unknown as typeof fetch;
    expect(await transcribeFile(settings, file, fetchFn)).toEqual([
      { start: 0, end: 1.5, text: 'مرحبا' },
    ]);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const form = init.body as FormData;
    expect(form.get('language')).toBe('ar');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(await transcribeFile(settings, file, fetchFn)).toEqual([
      { start: 0, end: 4, text: 'أهلا' },
    ]);
    await expect(transcribeFile(settings, file, fetchFn)).rejects.toThrow(/429/);
    await rm(dir, { recursive: true });
  });

  it('lets the model detect the language when none is set (mixed lessons)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suffa-stt-'));
    const file = join(dir, 'a.m4a');
    await writeFile(file, 'audio');
    const fetchImpl = vi.fn(async () => Response.json({ segments: [] }));
    await transcribeFile(
      { ...settings, language: null },
      file,
      fetchImpl as unknown as typeof fetch
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as FormData).has('language')).toBe(false);
    await rm(dir, { recursive: true });
  });

  it('asks Voxtral (Mistral) for segment timestamps and fills segments without times', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suffa-stt-'));
    const file = join(dir, 'a.m4a');
    await writeFile(file, 'audio');
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: 'voxtral-mini-latest',
        text: 'مرحبا يا طلاب',
        language: 'ar',
        segments: [
          { text: ' مرحبا ', start: 0.5, end: 1.5 },
          { text: 'يا طلاب', start: null, end: null },
        ],
      })
    );
    const cues = await transcribeFile(
      {
        ...settings,
        url: 'https://api.mistral.ai/v1/audio/transcriptions',
        model: 'voxtral-mini-latest',
      },
      file,
      fetchImpl as unknown as typeof fetch
    );
    expect(cues).toEqual([
      { start: 0.5, end: 1.5, text: 'مرحبا' },
      { start: 1.5, end: 1.5, text: 'يا طلاب' },
    ]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.getAll('timestamp_granularities')).toEqual(['segment']);
    expect(form.has('response_format')).toBe(false);
    expect(form.has('language')).toBe(false);
    await rm(dir, { recursive: true });
  });

  it('posts the form over node:http and reads the answer (no 5-minute limit)', async () => {
    let received = '';
    const server = createServer((req, res) => {
      req.on('data', (chunk: Buffer) => (received += chunk.toString('latin1')));
      req.on('end', () => {
        expect(req.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
        expect(req.headers.authorization).toBe('Bearer tok');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ segments: [{ start: 0, end: 1, text: 'سلام' }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const dir = await mkdtemp(join(tmpdir(), 'suffa-stt-'));
    const file = join(dir, 'a.m4a');
    await writeFile(file, 'audio-bytes');
    try {
      const cues = await transcribeFile(
        { ...settings, url: `http://127.0.0.1:${port}/v1/audio/transcriptions` },
        file,
        slowServiceFetch(5_000)
      );
      expect(cues).toEqual([{ start: 0, end: 1, text: 'سلام' }]);
      expect(received).toContain('audio-bytes');
      expect(received).toContain('whisper-1');
    } finally {
      server.close();
      await rm(dir, { recursive: true });
    }
  });

  it('gives up on a service that stays silent past the timeout', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        slowServiceFetch(200)(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x' })
      ).rejects.toThrow(/silent/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it.skipIf(!hasFfmpeg)(
    'cuts long audio into pieces and shifts their cues',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'suffa-stt-'));
      const file = join(dir, 'long.m4a');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=300:duration=${CHUNK_SECONDS + 30}`,
        '-c:a',
        'aac',
        '-b:a',
        '16k',
        file,
      ]);
      // The first piece answers last: the cues must still come back in order.
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        const name = ((init.body as FormData).get('file') as File).name;
        const first = name.includes('000');
        await new Promise((r) => setTimeout(r, first ? 50 : 0));
        return Response.json({
          segments: [{ start: 1, end: 2, text: first ? 'a' : 'b' }],
        });
      }) as unknown as typeof fetch;
      const progress: number[] = [];
      const cues = await new OpenAiCompatibleTranscriber(
        settings,
        () => join(dir, 'parts'),
        fetchImpl
      ).transcribe(file, (done) => {
        progress.push(done);
      });
      expect(cues.map((c) => [c.start, c.text])).toEqual([
        [1, 'a'],
        [CHUNK_SECONDS + 1, 'b'],
      ]);
      expect(progress).toEqual([0.5, 1]);
      await rm(dir, { recursive: true });
    },
    60_000
  );

  it.skipIf(!hasFfmpeg)(
    'after a failed piece starts no new one and waits for the running ones',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'suffa-stt-'));
      const file = join(dir, 'long.m4a');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=300:duration=${CHUNK_SECONDS * 4 + 30}`,
        '-c:a',
        'aac',
        '-b:a',
        '16k',
        file,
      ]);
      let slowDone = false;
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        const name = ((init.body as FormData).get('file') as File).name;
        if (name.includes('000')) return new Response('boom', { status: 500 });
        await new Promise((r) => setTimeout(r, 80));
        slowDone = true;
        return Response.json({ segments: [] });
      }) as unknown as typeof fetch;
      await expect(
        new OpenAiCompatibleTranscriber(
          settings,
          () => join(dir, 'parts'),
          fetchImpl
        ).transcribe(file)
      ).rejects.toThrow(/500/);
      // 5 pieces, 3 lanes: the failure stops the queue; the two running pieces finished first.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(slowDone).toBe(true);
      await rm(dir, { recursive: true });
    },
    120_000
  );
});
