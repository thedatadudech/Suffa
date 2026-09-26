/** Client for transcripts, checkpoints, the class AI switch and assignments (Sprint 8). */
import { apiRequest, type Fetch } from '@/services/api/request';
import type { Checkpoint, CheckpointData, Cue } from './checkpoints';

export interface Transcript {
  status: 'queued' | 'processing' | 'ready' | 'failed';
  source: 'whisper' | 'manual';
  cues: Cue[];
  error: string | null;
  /** 0–100 while an automatic transcript is being made. */
  progress?: number | null;
  updatedAt: string;
}

export interface Chapter {
  id: string;
  atSec: number;
  title: string;
}

export interface Interactive {
  transcript: Transcript | null;
  checkpoints: Checkpoint[];
  /** Parts of the lesson (accepted from AI suggestions, story 11.4). */
  chapters: Chapter[];
  /** The viewer teaches this class (edits checkpoints and the transcript). */
  canEdit: boolean;
  canGenerate: boolean;
  /** AI suggestions can be requested (a model is configured). */
  canSuggest: boolean;
  /** A lesson summary can be requested (an EU model is configured; teachers only). */
  canSummarize?: boolean;
  /** Teachers: the latest run or draft; learners: the published summary or null. */
  summary?: SummaryState | null;
}

/** A lesson summary written by the EU model from the transcript. */
export interface LessonSummary {
  overview: string;
  points: string[];
  vocabulary: { ar: string; de: string }[];
  grammar: string[];
}

export interface SummaryState {
  status: 'queued' | 'running' | 'ready' | 'failed';
  error: string | null;
  content: LessonSummary | null;
  /** Set once the teacher has published it for the class. */
  publishedAt: string | null;
}

export type Suggestion =
  | { id: string; kind: 'chapter'; atSec: number; data: { title: string } }
  | { id: string; kind: 'checkpoint'; atSec: number; data: CheckpointData };

export interface SuggestionState {
  run: { status: 'queued' | 'running' | 'ready' | 'failed'; error: string | null } | null;
  suggestions: Suggestion[];
}

export interface Assignment {
  id: string;
  kind: 'unit' | 'recording';
  ref: string;
  title: string;
  dueAt: string;
  done: boolean | null;
  doneCount: number | null;
  learners: number | null;
}

const MESSAGES: Record<string, string> = {
  transcription_unavailable:
    'Automatische Transkripte sind auf diesem Server nicht eingerichtet.',
  ai_disabled: 'KI ist für diese Klasse ausgeschaltet (Klassen-Einstellungen).',
  no_transcript: 'Dafür braucht die Aufnahme zuerst ein Transkript.',
  ai_unavailable: 'Auf diesem Server ist kein KI-Modell eingerichtet.',
  no_summary: 'Es gibt noch keine fertige Zusammenfassung.',
};

export class InteractiveApi {
  constructor(private readonly fetchImpl: Fetch = (...args) => fetch(...args)) {}

  get(classId: string, mediaId: string) {
    return this.call<Interactive>(`${this.media(classId, mediaId)}/interactive`);
  }

  saveTranscript(classId: string, mediaId: string, cues: Cue[]) {
    return this.call<void>(`${this.media(classId, mediaId)}/transcript`, {
      method: 'PUT',
      body: JSON.stringify({ cues }),
    });
  }

  generateTranscript(classId: string, mediaId: string) {
    return this.call<void>(`${this.media(classId, mediaId)}/transcript/generate`, {
      method: 'POST',
    });
  }

  addCheckpoint(classId: string, mediaId: string, atSec: number, data: CheckpointData) {
    return this.call<Checkpoint>(`${this.media(classId, mediaId)}/checkpoints`, {
      method: 'POST',
      body: JSON.stringify({ atSec, data }),
    });
  }

  removeCheckpoint(classId: string, mediaId: string, id: string) {
    return this.call<void>(
      `${this.media(classId, mediaId)}/checkpoints/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  }

  requestSummary(classId: string, mediaId: string) {
    return this.call<void>(`${this.media(classId, mediaId)}/summary`, { method: 'POST' });
  }

  publishSummary(classId: string, mediaId: string, published: boolean) {
    return this.call<void>(`${this.media(classId, mediaId)}/summary`, {
      method: 'PUT',
      body: JSON.stringify({ published }),
    });
  }

  requestSuggestions(classId: string, mediaId: string) {
    return this.call<void>(`${this.media(classId, mediaId)}/suggestions`, {
      method: 'POST',
    });
  }

  suggestions(classId: string, mediaId: string) {
    return this.call<SuggestionState>(`${this.media(classId, mediaId)}/suggestions`);
  }

  decide(classId: string, mediaId: string, id: string, decision: 'accept' | 'dismiss') {
    return this.call<void>(
      `${this.media(classId, mediaId)}/suggestions/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify({ decision }) }
    );
  }

  removeChapter(classId: string, mediaId: string, id: string) {
    return this.call<void>(
      `${this.media(classId, mediaId)}/chapters/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  }

  settings(classId: string) {
    return this.call<{ aiEnabled: boolean }>(`${this.klass(classId)}/settings`);
  }

  setAiEnabled(classId: string, aiEnabled: boolean) {
    return this.call<void>(`${this.klass(classId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ aiEnabled }),
    });
  }

  assignments(classId: string) {
    return this.call<{ assignments: Assignment[] }>(`${this.klass(classId)}/assignments`);
  }

  addAssignment(
    classId: string,
    a: { kind: 'unit' | 'recording'; ref: string; title: string; dueAt: string }
  ) {
    return this.call<{ id: string }>(`${this.klass(classId)}/assignments`, {
      method: 'POST',
      body: JSON.stringify(a),
    });
  }

  removeAssignment(classId: string, id: string) {
    return this.call<void>(
      `${this.klass(classId)}/assignments/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      }
    );
  }

  private klass(classId: string) {
    return `/api/v1/classes/${encodeURIComponent(classId)}`;
  }

  private media(classId: string, mediaId: string) {
    return `${this.klass(classId)}/media/${encodeURIComponent(mediaId)}`;
  }

  private call<T>(path: string, init: RequestInit = {}) {
    return apiRequest<T>(this.fetchImpl, path, init, MESSAGES);
  }
}
