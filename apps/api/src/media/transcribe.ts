/**
 * Transcription (story 8.1) through an OpenAI-style speech-to-text endpoint: Mistral's
 * Voxtral (EU) in production, or any other OpenAI-compatible service. Long recordings are cut into 10-minute pieces (upload limits) and the cues are
 * shifted back into place.
 */
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { basename, join } from 'node:path';
import type { Cue } from './interactive.js';

/** Share of the work done, 0–1; called after each piece. */
export type TranscribeProgress = (done: number) => Promise<void> | void;

export interface Transcriber {
  transcribe(file: string, onProgress?: TranscribeProgress): Promise<Cue[]>;
}

/** Pieces sent at the same time: a lesson of 90 minutes is 9 pieces. */
export const PARALLEL_PIECES = 3;

export interface TranscriberSettings {
  url: string;
  token: string | null;
  model: string;
  /**
   * ISO-639-1 language of the recordings (e.g. "ar"), or null to let the model detect it
   * per piece: lessons that explain Arabic in German are mixed, and a fixed "ar" turns the
   * German parts into nonsense.
   */
  language: string | null;
}

/** Mistral asks for segment timestamps its own way and has no `response_format`. */
export function isMistral(url: string): boolean {
  return new URL(url).hostname === 'api.mistral.ai';
}

/** Length of one piece sent to the service. */
export const CHUNK_SECONDS = 600;

/** How long one piece may take: generous, so a busy or slow service does not fail a lesson. */
export const PIECE_TIMEOUT_MS = 60 * 60 * 1000;

type Fetch = typeof fetch;

/**
 * `fetch` for slow services. Node's built-in fetch gives up when no response headers
 * arrive within 5 minutes, which a slow or busy service can exceed for a
 * 10-minute piece; this sends the same request over node:http(s) with a longer idle
 * timeout.
 */
export function slowServiceFetch(timeoutMs = PIECE_TIMEOUT_MS): Fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = Buffer.from(await request.arrayBuffer());
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers);
    headers['content-length'] = String(body.length);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise<Response>((resolve, reject) => {
      const req = client.request(
        url,
        { method: request.method, headers, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined) {
                responseHeaders.set(
                  name,
                  Array.isArray(value) ? value.join(', ') : value
                );
              }
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 502,
                headers: responseHeaders,
              })
            );
          });
        }
      );
      req.on('timeout', () =>
        req.destroy(new Error(`transcription service silent for ${timeoutMs / 1000} s`))
      );
      req.on('error', reject);
      req.end(body);
    });
  };
}

/** One request: a file → cues from `verbose_json` segments. */
export async function transcribeFile(
  settings: TranscriberSettings,
  file: string,
  fetchImpl: Fetch = slowServiceFetch()
): Promise<Cue[]> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([await readFile(file)], { type: 'audio/mp4' }),
    basename(file)
  );
  form.append('model', settings.model);
  if (isMistral(settings.url)) {
    // Voxtral: segments come with `timestamp_granularities`; it does not take a language
    // together with timestamps, and detects the language itself.
    form.append('timestamp_granularities', 'segment');
  } else {
    if (settings.language) form.append('language', settings.language);
    form.append('response_format', 'verbose_json');
  }
  const response = await fetchImpl(settings.url, {
    method: 'POST',
    headers: settings.token ? { authorization: `Bearer ${settings.token}` } : undefined,
    body: form,
  });
  if (!response.ok) {
    throw new Error(
      `transcription failed: ${response.status} ${(await response.text()).slice(0, 300)}`
    );
  }
  const data = (await response.json()) as {
    text?: string;
    duration?: number;
    segments?: { start: number | null; end: number | null; text: string }[];
  };
  if (data.segments?.length) {
    // A segment without times (possible with Voxtral) keeps the previous segment's end.
    let last = 0;
    return data.segments
      .map((s) => {
        const start = s.start ?? last;
        const end = s.end ?? start;
        last = end;
        return { start, end, text: s.text.trim() };
      })
      .filter((c) => c.text);
  }
  const text = data.text?.trim();
  return text ? [{ start: 0, end: data.duration ?? 0, text }] : [];
}

/** Cuts audio into CHUNK_SECONDS pieces without re-encoding; returns them in order. */
export async function splitAudio(file: string, dir: string): Promise<string[]> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        file,
        '-f',
        'segment',
        '-segment_time',
        String(CHUNK_SECONDS),
        '-c',
        'copy',
        join(dir, 'part%03d.m4a'),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg split: ${err}`))
    );
  });
  return (await readdir(dir))
    .filter((f) => /^part\d{3}\.m4a$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

export class OpenAiCompatibleTranscriber implements Transcriber {
  constructor(
    private readonly settings: TranscriberSettings,
    private readonly workDir: (file: string) => string = (file) => `${file}.parts`,
    private readonly fetchImpl: Fetch = slowServiceFetch()
  ) {}

  async transcribe(file: string, onProgress?: TranscribeProgress): Promise<Cue[]> {
    const dir = this.workDir(file);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const parts = await splitAudio(file, dir);
    const results: Cue[][] = new Array(parts.length);
    let next = 0;
    let done = 0;
    // A few pieces at once; each lane takes the next piece until none is left. After a
    // failure no new piece starts, and the pieces already running finish before the error
    // goes up (the caller removes the files afterwards).
    let failed = false;
    const lane = async () => {
      while (!failed && next < parts.length) {
        const i = next++;
        const offset = i * CHUNK_SECONDS;
        const cues = await transcribeFile(this.settings, parts[i]!, this.fetchImpl);
        results[i] = cues.map((c) => ({
          ...c,
          start: c.start + offset,
          end: c.end + offset,
        }));
        done++;
        await onProgress?.(done / parts.length);
      }
    };
    const lanes = await Promise.allSettled(
      Array.from({ length: Math.min(PARALLEL_PIECES, parts.length) }, () =>
        lane().catch((error: unknown) => {
          failed = true;
          throw error;
        })
      )
    );
    const rejected = lanes.find((l) => l.status === 'rejected');
    if (rejected) throw rejected.reason;
    return results.flat();
  }
}
