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
  /** Which API made the request. Recordings replay through either. */
  via: 'fetch' | 'node:http';
  /** In a fork recording: whether this step was served from the original recording or the live network. */
  source?: 'replayed' | 'live';
  /** In a fork recording: the request was changed by `patchRequest` before it was sent. */
  patched?: true;
  /**
   * Blob hash of the body that was actually sent, when `patchRequest` changed it. `request` keeps the
   * original so unpatched code still replays the recording; this is what tools display and diff.
   */
  sentBody?: string;
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
  /** Present when this recording was produced by `fork()`. */
  fork?: ForkInfo;
  steps: Step[];
  /** Recorded clock and randomness, so replays see the same values. */
  determinism: RecordedDeterminism;
  blobs: Record<string, BlobEntry>;
}

export interface RecordedDeterminism {
  /** Seed for `Math.random()`, or null when randomness was not controlled. */
  seed: number | null;
  /** Every `Date.now()` / `new Date()` value read, as offsets from `start`. Null when the clock was not controlled. */
  clock: { start: number; deltas: number[] } | null;
  /** Every `crypto.randomUUID()` value returned. Null when UUIDs were not controlled. */
  uuids: string[] | null;
}

export interface DeterminismOptions {
  /** Record and replay `Date.now()` and `new Date()`. Default: true. */
  clock?: boolean;
  /** Make `Math.random()` a seeded generator whose seed is saved. Default: true. */
  random?: boolean;
  /** Record and replay `crypto.randomUUID()`. Default: true. */
  uuid?: boolean;
}

export interface BaseOptions {
  /**
   * Control time and randomness inside the session so replays see identical values.
   * `false` disables all of it; an object picks individual sources. Default: true.
   */
  deterministic?: boolean | DeterminismOptions;
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

export interface ForkInfo {
  /** The recording this fork started from. */
  from: string;
  /** The step the fork was asked to go live at (null: after the recording ran out). */
  at: number | null;
  /** Seq in this recording of the first live step, or null if the run never went live. */
  liveFrom: number | null;
  /** Why it went live: it reached `at`, or the run made a request the original recording has no counterpart for. */
  reason: 'at' | 'unmatched' | null;
}

export interface PatchableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, the raw text otherwise, null when there is no body. */
  body: unknown;
}

export interface PatchableResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, the raw text otherwise, null when there is no body. */
  body: unknown;
}

export interface ForkOptions extends RecordOptions, Omit<ReplayOptions, 'strict' | 'passthrough'> {
  /**
   * Seq of the first step to run live. Steps before it are replayed from the recording.
   * Default: replay every recorded step, go live once the recording runs out.
   */
  at?: number;
  /** Name for the fork's own recording. Default: `<name>.fork-<at>`. Pass `false` to not save it. */
  saveAs?: string | false;
  /**
   * Change a live request before it is sent, e.g. swap the system prompt.
   * Return the new body (an object is sent as JSON), or undefined to send it unchanged.
   */
  patchRequest?: (req: PatchableRequest, ctx: { step: number }) => unknown;
  /**
   * Change a replayed response before the agent sees it, e.g. make a tool call fail.
   * Return the new body, or undefined to keep the recorded one.
   */
  patchResponse?: (res: PatchableResponse, ctx: { step: number; request: PatchableRequest }) => unknown;
}

export interface ForkResult<T> {
  /** What the callback returned. */
  value: T;
  /** Name of the saved fork recording, or null when `saveAs: false`. */
  savedAs: string | null;
  /** Steps answered from the original recording. */
  replayed: number;
  /** Steps sent to the live network. */
  live: number;
  /** Seq of the first live step, or null if the run never went live. */
  liveFrom: number | null;
  /** Why the run went live: it reached `at`, or diverged from the recording before `at`. */
  reason: 'at' | 'unmatched' | null;
}

export type Mode = 'record' | 'replay' | 'auto';
