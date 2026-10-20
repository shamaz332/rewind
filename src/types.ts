export const FORMAT = 'rewind/v1' as const;

/** A stored blob. Text stays readable in git diffs; binary falls back to base64. */
export type BlobEntry = { utf8: string } | { base64: string };

export interface RecordedRequest {
  method: string;
  /** URL with secret query params redacted. */
  url: string;
  /** Lowercased header names, secrets redacted. Not used for matching. */
  headers: Record<string, string>;
  /** Blob hash of the (redacted) request body, or null when there is no body. */
  body: string | null;
  /** Hash of method + normalized URL + canonical body. Replay matches on this. */
  matchKey: string;
}

export interface RecordedChunk {
  /** Byte length of this chunk. Chunks are consecutive slices of the body blob. */
  size: number;
  /** Milliseconds after the response headers arrived. */
  at: number;
}

export interface RecordedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
  /** Blob hash of the full response body, or null when there is no body. */
  body: string | null;
  chunks: RecordedChunk[];
  /** Set when the body stream errored or did not finish before the session ended. */
  truncated?: { reason: string };
}

export interface FetchStep {
  seq: number;
  kind: 'fetch';
  /** Milliseconds after the session started. */
  startedAt: number;
  durationMs: number;
  request: RecordedRequest;
  response?: RecordedResponse;
  /** Set when fetch itself rejected (DNS failure, connection refused, ...). */
  error?: { name: string; message: string };
}

export type Step = FetchStep;

export interface Recording {
  format: typeof FORMAT;
  name: string;
  createdAt: string;
  runtime: { node: string };
  steps: Step[];
  blobs: Record<string, BlobEntry>;
}

export interface BaseOptions {
  /** Directory recordings are stored in. Default: `.rewind` in the current working directory. */
  dir?: string;
  /** Extra header names to redact, in addition to the built-in list (authorization, x-api-key, cookie, ...). */
  redactHeaders?: string[];
  /**
   * Transform request body text before it is matched and stored.
   * Runs after built-in secret scrubbing. Use it to strip values that change every run (timestamps, nonces).
   */
  redactBody?: (text: string, ctx: { url: string }) => string;
}

export interface RecordOptions extends BaseOptions {
  /** How long to wait for in-flight response bodies after the callback finishes. Default: 10000 ms. */
  settleTimeoutMs?: number;
}

export interface ReplayOptions extends BaseOptions {
  /** `instant` (default) streams recorded chunks immediately; `original` reproduces the recorded chunk timing. */
  timing?: 'instant' | 'original';
  /** Playback speed multiplier for `timing: 'original'`. Default: 1. */
  speed?: number;
  /** Throw if the run finishes without using every recorded step. Default: false. */
  strict?: boolean;
  /** Requests for which this returns true go to the real network instead of the recording. */
  passthrough?: (url: URL) => boolean;
}

export type AutoOptions = RecordOptions & ReplayOptions;

export type Mode = 'record' | 'replay' | 'auto';
