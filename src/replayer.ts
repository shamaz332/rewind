import { runInternal, type RealFetch, type Session, type Transport } from './context.js';
import { realNow, realRandom, realUUID, resolveFlags, seededRandom, uuidFrom } from './determinism.js';
import { ReplayDivergenceError, UnusedStepsError } from './errors.js';
import { firstDifference, type Difference } from './hash.js';
import { redactUrl } from './redact.js';
import { describeRequest } from './request.js';
import { BlobStore, tryDecode } from './store.js';
import type { FetchStep, RecordedResponse, Recording, ReplayOptions } from './types.js';

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
// The recorded body is already decoded, so these would describe it wrongly.
const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

export class Replayer implements Session {
  readonly name: string;
  private readonly blobs: BlobStore;
  /** Recorded steps per match key, in recorded order. Identical requests replay first-in, first-out. */
  private readonly queues = new Map<string, FetchStep[]>();
  private readonly sorted: FetchStep[];
  private readonly used = new Set<number>();
  readonly divergences: ReplayDivergenceError[] = [];
  /** What this run actually did, in order: served steps and diverging requests. Used for `.failed` recordings. */
  private readonly timeline: { step: FetchStep; divergence?: ReplayDivergenceError }[] = [];
  private readonly liveBlobs = new BlobStore();

  private readonly clock: { start: number; deltas: number[] } | null;
  private clockIndex = 0;
  /** Once recorded clock values run out, time moves on in real time from the last recorded value. */
  private clockOverflow: { base: number; realAt: number } | null = null;
  private readonly rand: (() => number) | null;
  private readonly uuids: string[] | null;
  private uuidIndex = 0;
  private readonly uuidRand: () => number;

  constructor(
    private readonly recording: Recording,
    private readonly opts: ReplayOptions,
  ) {
    this.name = recording.name;
    this.blobs = BlobStore.fromJSON(recording.blobs);
    this.sorted = [...recording.steps].sort((a, b) => a.seq - b.seq);
    for (const step of this.sorted) {
      const q = this.queues.get(step.request.matchKey);
      if (q) q.push(step);
      else this.queues.set(step.request.matchKey, [step]);
    }

    const flags = resolveFlags(opts.deterministic);
    const d = recording.determinism;
    this.clock = flags.clock ? (d?.clock ?? null) : null;
    this.rand = flags.random && d?.seed != null ? seededRandom(d.seed) : null;
    this.uuids = flags.uuid ? (d?.uuids ?? null) : null;
    this.uuidRand = seededRandom(((d?.seed ?? 0) ^ 0x9e3779b9) >>> 0);
  }

  now(): number {
    if (!this.clock) return realNow();
    if (this.clockOverflow) return this.clockOverflow.base + (realNow() - this.clockOverflow.realAt);
    const delta = this.clock.deltas[this.clockIndex++];
    const value = this.clock.start + (delta ?? 0);
    // Time keeps moving from the moment the last recorded value was handed out.
    if (this.clockIndex >= this.clock.deltas.length) this.clockOverflow = { base: value, realAt: realNow() };
    return value;
  }

  random(): number {
    return this.rand ? this.rand() : realRandom();
  }

  uuid(): string {
    if (!this.uuids) return realUUID();
    // Past the recorded values, keep producing deterministic UUIDs rather than random ones.
    return this.uuids[this.uuidIndex++] ?? uuidFrom(this.uuidRand);
  }

  async fetch(req: Request, realFetch: RealFetch, _via: Transport): Promise<Response> {
    // `_via` is only kept for failure recordings; replay answers fetch and node:http alike.
    if (this.opts.passthrough?.(new URL(req.url))) return realFetch(req);
    if (req.signal.aborted) throw req.signal.reason;

    const live = await runInternal(() => describeRequest(req, this.opts, this.liveBlobs));
    const step = this.queues.get(live.recorded.matchKey)?.shift();
    if (!step) {
      const err = this.divergence(live.recorded.method, live.recorded.url, live.matchUrl, live.bodyText);
      this.divergences.push(err);
      this.timeline.push({
        step: { seq: -1, kind: 'fetch', via: _via, startedAt: 0, durationMs: 0, request: live.recorded, error: { name: err.name, message: err.message } },
        divergence: err,
      });
      throw err;
    }
    this.used.add(step.seq);
    this.timeline.push({ step });

    if (step.error) throw new TypeError('fetch failed', { cause: new Error(step.error.message) });
    return this.answer(step, req.signal);
  }

  /** Serve one recorded step: its response, or the network error it recorded. */
  answer(step: FetchStep, signal: AbortSignal, bodyOverride?: Uint8Array): Response {
    if (step.error) throw new TypeError('fetch failed', { cause: new Error(step.error.message) });
    if (!step.response) {
      throw new TypeError('fetch failed', { cause: new Error('request had not completed when the recording ended') });
    }
    return this.respond(step.response, signal, bodyOverride);
  }

  /**
   * Order-based matching for forks: the first unused step below `below` with the same method and
   * URL, ignoring the body. A changed prompt alters every body, yet the agent's history is the same.
   */
  takeLoose(method: string, matchUrl: string, below: number): FetchStep | null {
    const step = this.sorted.find(
      (s) => s.seq < below && !this.used.has(s.seq) && s.request.method === method && redactUrl(s.request.url, true) === matchUrl,
    );
    if (!step) return null;
    this.used.add(step.seq);
    return step;
  }

  hasUnusedBelow(below: number): boolean {
    return this.sorted.some((s) => s.seq < below && !this.used.has(s.seq));
  }

  /** The recorded response body of a step, for patching. */
  responseBody(step: FetchStep): Uint8Array | null {
    return step.response?.body ? this.blobs.get(step.response.body) : null;
  }

  /** Clock reads and UUIDs left over from the recording, for a fork to hand out before it goes live. */
  takeRecordedNow(): number | null {
    if (!this.clock || this.clockIndex >= this.clock.deltas.length) return null;
    return this.clock.start + this.clock.deltas[this.clockIndex++]!;
  }

  takeRecordedUuid(): string | null {
    return this.uuids?.[this.uuidIndex++] ?? null;
  }

  /**
   * What the run actually did before (and where) it diverged, as a recording of its own,
   * or null if it never diverged.
   */
  failureRecording(): Recording | null {
    const firstFailure = this.timeline.findIndex((t) => t.divergence);
    if (firstFailure === -1) return null;
    const original = BlobStore.fromJSON(this.recording.blobs);
    const blobs = new BlobStore();
    const copy = (hash: string | null | undefined, from: BlobStore) => (hash ? blobs.put(from.get(hash)) : null);
    const steps: FetchStep[] = this.timeline.map(({ step, divergence }, seq) => {
      const from = divergence ? this.liveBlobs : original;
      const out: FetchStep = { ...step, seq, request: { ...step.request, body: copy(step.request.body, from) } };
      if (step.response) out.response = { ...step.response, body: copy(step.response.body, original) };
      if (step.sentBody) out.sentBody = copy(step.sentBody, original)!;
      return out;
    });
    return {
      format: this.recording.format,
      name: `${this.recording.name}.failed`,
      createdAt: new Date(realNow()).toISOString(),
      runtime: { node: process.version },
      failure: { from: this.recording.name, message: this.timeline[firstFailure]!.divergence!.message, step: firstFailure },
      steps,
      determinism: this.recording.determinism,
      blobs: blobs.toJSON(),
    };
  }

  /** Errors to raise once the replayed run has finished. */
  finish(): void {
    const first = this.divergences[0];
    if (first) throw first;
    if (this.opts.strict) {
      const unused = this.recording.steps
        .filter((s) => !this.used.has(s.seq))
        .map((s) => ({ seq: s.seq, method: s.request.method, url: s.request.url }));
      if (unused.length) throw new UnusedStepsError(unused);
    }
  }

  private respond(rec: RecordedResponse, signal: AbortSignal, bodyOverride?: Uint8Array): Response {
    const headers = new Headers();
    for (const [k, v] of Object.entries(rec.headers)) if (!DROP_HEADERS.has(k)) headers.append(k, v);

    let body: ReadableStream<Uint8Array> | null = null;
    if ((rec.body !== null || bodyOverride) && !NULL_BODY_STATUS.has(rec.status)) {
      const bytes = bodyOverride ?? this.blobs.get(rec.body!);
      // A patched body no longer lines up with the recorded chunk boundaries, so it is sent whole.
      const chunks = rec.chunks.length && !bodyOverride ? rec.chunks : [{ size: bytes.byteLength, at: 0 }];
      const original = this.opts.timing === 'original';
      const speed = this.opts.speed && this.opts.speed > 0 ? this.opts.speed : 1;
      let i = 0;
      let offset = 0;
      let prevAt = 0;
      body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = chunks[i];
          if (!chunk) {
            if (rec.truncated) controller.error(new TypeError('terminated', { cause: new Error(rec.truncated.reason) }));
            else controller.close();
            return;
          }
          if (original && chunk.at > prevAt) await sleep((chunk.at - prevAt) / speed, signal);
          prevAt = chunk.at;
          controller.enqueue(bytes.slice(offset, offset + chunk.size));
          offset += chunk.size;
          i++;
        },
      });
    }

    const res = new Response(body, { status: rec.status, statusText: rec.statusText, headers });
    Object.defineProperty(res, 'url', { value: rec.url });
    return res;
  }

  private divergence(method: string, url: string, matchUrl: string, bodyText: string | null): ReplayDivergenceError {
    const sameUrl = this.recording.steps.filter(
      (s) => s.request.method === method && redactUrl(s.request.url, true) === matchUrl,
    );
    const lines = [`Replay diverged: the recording has no response for ${method} ${url}`];
    let diff: Difference | null = null;

    const candidate = sameUrl.find((s) => !this.used.has(s.seq));
    if (candidate) {
      diff = bodyDiff(candidate.request.body ? this.textBlob(candidate.request.body) : null, bodyText);
      lines.push(`  Step #${candidate.seq} in the recording is a ${method} to this URL, but its body is different.`);
      if (diff) {
        lines.push(`  First difference at ${diff.path}:`);
        lines.push(`    recorded: ${preview(diff.left)}`);
        lines.push(`    now:      ${preview(diff.right)}`);
      }
    } else if (sameUrl.length) {
      lines.push(`  All ${sameUrl.length} recorded ${method} request(s) to this URL were already used; this run makes more calls than the recorded one.`);
    } else {
      const unused = this.recording.steps.filter((s) => !this.used.has(s.seq)).slice(0, 5);
      lines.push(unused.length ? '  Next unused recorded requests:' : '  Every recorded request has already been used.');
      for (const s of unused) lines.push(`    #${s.seq} ${s.request.method} ${s.request.url}`);
    }
    lines.push('  Re-record with REWIND_MODE=record if this change is intended.');
    return new ReplayDivergenceError(lines.join('\n'), { method, url }, diff?.path ?? null);
  }

  private textBlob(hash: string): string | null {
    return tryDecode(this.blobs.get(hash));
  }
}

function bodyDiff(recorded: string | null, live: string | null): Difference | null {
  const parse = (t: string | null) => {
    if (t === null) return undefined;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return t;
    }
  };
  return firstDifference(parse(recorded), parse(live));
}

function preview(value: unknown): string {
  const s = value === undefined ? '(missing)' : JSON.stringify(value);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
