import { runInternal, type RealFetch, type Session, type Transport } from './context.js';
import { redactHeaders, redactUrl } from './redact.js';
import { Recorder } from './recorder.js';
import { Replayer } from './replayer.js';
import { tryDecode } from './store.js';
import type { FetchStep, ForkOptions, PatchableRequest, Recording } from './types.js';

/**
 * Replays the original recording until the run reaches step `at` (or stops matching it),
 * then goes live. Everything it hands out, replayed or live, is recorded into a new recording
 * that plain `replay()` can reproduce.
 */
export class Forker implements Session {
  readonly name: string;
  readonly recorder: Recorder;
  private readonly replayer: Replayer;
  private readonly at: number;
  private liveFrom: number | null = null;
  private reason: 'at' | 'unmatched' | null = null;
  replayed = 0;
  live = 0;

  constructor(
    private readonly original: Recording,
    saveAs: string,
    private readonly opts: ForkOptions,
  ) {
    this.name = saveAs;
    this.at = opts.at ?? Number.POSITIVE_INFINITY;
    this.replayer = new Replayer(original, { ...opts, strict: false });
    this.recorder = new Recorder(saveAs, opts, {
      seed: original.determinism?.seed ?? null,
      clockStart: original.determinism?.clock?.start ?? null,
    });
  }

  get isLive(): boolean {
    return this.liveFrom !== null;
  }

  get result() {
    return { replayed: this.replayed, live: this.live, liveFrom: this.liveFrom, reason: this.reason };
  }

  // Before the fork point the clock and UUIDs come from the original run; afterwards they are real.
  now(): number {
    const recorded = this.isLive ? null : this.replayer.takeRecordedNow();
    return recorded === null ? this.recorder.now() : this.recorder.observeNow(recorded);
  }

  random(): number {
    return this.recorder.random(); // same seed as the original, so the sequence continues unchanged
  }

  uuid(): string {
    const recorded = this.isLive ? null : this.replayer.takeRecordedUuid();
    return recorded === null ? this.recorder.uuid() : this.recorder.observeUuid(recorded);
  }

  async fetch(req: Request, realFetch: RealFetch, via: Transport): Promise<Response> {
    if (!this.isLive) {
      const step = this.replayer.takeLoose(req.method.toUpperCase(), redactUrl(req.url, true), this.at);
      if (step) {
        this.replayed++;
        return this.recorder.fetch(req, () => this.serve(req, step), via, { source: 'replayed' });
      }
      this.liveFrom = this.recorder.nextSeq;
      // Reaching `at`, or running out of recording, is the planned hand-over; anything else is a divergence.
      this.reason = this.replayer.hasUnusedBelow(this.at) ? 'unmatched' : 'at';
    }

    this.live++;
    const step = this.recorder.nextSeq;
    const patched = this.opts.patchRequest ? await runInternal(() => patchRequest(req, this.opts.patchRequest!, step)) : null;
    return this.recorder.fetch(req, () => realFetch(patched ?? req), via, {
      source: 'live',
      ...(patched ? { patched: true as const, sentRequest: patched } : {}),
    });
  }

  forkInfo(): NonNullable<Recording['fork']> {
    return {
      from: this.original.name,
      at: Number.isFinite(this.at) ? this.at : null,
      liveFrom: this.liveFrom,
      reason: this.reason,
    };
  }

  private async serve(req: Request, step: FetchStep): Promise<Response> {
    const patch = this.opts.patchResponse;
    if (!patch || !step.response) return this.replayer.answer(step, req.signal);

    const bytes = this.replayer.responseBody(step);
    const out = await patch(
      { status: step.response.status, headers: { ...step.response.headers }, body: parseBody(bytes) },
      { step: this.recorder.nextSeq - 1, request: await describeForPatch(req) },
    );
    if (out === undefined) return this.replayer.answer(step, req.signal);
    return this.replayer.answer(step, req.signal, encodeBody(out));
  }
}

async function patchRequest(
  req: Request,
  patch: NonNullable<ForkOptions['patchRequest']>,
  step: number,
): Promise<Request | null> {
  const out = await patch(await describeForPatch(req), { step });
  if (out === undefined) return null;
  const headers = new Headers(req.headers);
  headers.delete('content-length');
  if (typeof out !== 'string' && !(out instanceof Uint8Array) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(req.url, {
    method: req.method,
    headers,
    body: encodeBody(out),
    signal: req.signal,
    redirect: req.redirect,
  });
}

async function describeForPatch(req: Request): Promise<PatchableRequest> {
  const bytes = req.body ? new Uint8Array(await req.clone().arrayBuffer()) : null;
  return {
    method: req.method.toUpperCase(),
    url: req.url,
    headers: redactHeaders(req.headers),
    body: parseBody(bytes),
  };
}

function parseBody(bytes: Uint8Array | null): unknown {
  if (!bytes || bytes.byteLength === 0) return null;
  const text = tryDecode(bytes);
  if (text === null) return bytes;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function encodeBody(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
}
