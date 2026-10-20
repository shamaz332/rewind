import { runInternal, type RealFetch, type Session, type Transport } from './context.js';
import { realNow, realRandom, realUUID, resolveFlags, seededRandom, type DeterminismFlags } from './determinism.js';
import { redactHeaders, redactText, redactUrl } from './redact.js';
import { describeRequest } from './request.js';
import { BlobStore, tryDecode } from './store.js';
import {
  FORMAT,
  type FetchStep,
  type RecordOptions,
  type RecordedChunk,
  type RecordedResponse,
  type Recording,
} from './types.js';

interface BodyCapture {
  done: boolean;
  finalize(truncatedReason?: string): void;
  promise: Promise<void>;
}

// The body handed to the caller is already decoded, so these would describe it wrongly.
const DECODED_BODY_DROP = ['content-encoding', 'content-length', 'transfer-encoding'];

export class Recorder implements Session {
  private readonly steps: FetchStep[] = [];
  private readonly blobs = new BlobStore();
  private readonly captures: BodyCapture[] = [];
  private readonly t0 = performance.now();
  private seq = 0;

  private readonly flags: DeterminismFlags;
  private readonly seed: number;
  private readonly rand: () => number;
  private readonly clockStart: number;
  private readonly clockDeltas: number[] = [];
  private readonly uuids: string[] = [];
  private fork: Recording['fork'];

  constructor(
    readonly name: string,
    private readonly opts: RecordOptions,
    /** A fork continues the original run's random sequence and clock baseline. */
    base?: { seed: number | null; clockStart: number | null },
  ) {
    this.flags = resolveFlags(opts.deterministic);
    this.seed = base?.seed ?? (realRandom() * 2 ** 32) >>> 0;
    this.rand = seededRandom(this.seed);
    this.clockStart = base?.clockStart ?? realNow();
  }

  now(): number {
    return this.observeNow(realNow());
  }

  /** Record a clock value obtained elsewhere (a fork replaying the original run). */
  observeNow(t: number): number {
    if (this.flags.clock) this.clockDeltas.push(t - this.clockStart);
    return t;
  }

  random(): number {
    return this.flags.random ? this.rand() : realRandom();
  }

  uuid(): string {
    return this.observeUuid(realUUID());
  }

  observeUuid(id: string): string {
    if (this.flags.uuid) this.uuids.push(id);
    return id;
  }

  /** The seq the next request will get. */
  get nextSeq(): number {
    return this.seq;
  }

  setFork(info: NonNullable<Recording['fork']>): void {
    this.fork = info;
  }

  async fetch(
    req: Request,
    realFetch: RealFetch,
    via: Transport,
    meta: Pick<FetchStep, 'source' | 'patched'> = {},
  ): Promise<Response> {
    const seq = this.seq++;
    const startedAt = this.elapsed();
    const { recorded } = await runInternal(() => describeRequest(req, this.opts, this.blobs));
    const step: FetchStep = { seq, kind: 'fetch', via, startedAt, durationMs: 0, request: recorded, ...meta };
    this.steps.push(step);

    let res: Response;
    try {
      res = await realFetch(req);
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      step.error = { name: e.name, message: e.message };
      const cause = e.cause?.code ?? e.cause?.message;
      if (cause) step.error.message += ` (${cause})`;
      step.durationMs = this.elapsed() - startedAt;
      throw err;
    }

    const response: RecordedResponse = {
      status: res.status,
      statusText: res.statusText,
      headers: redactHeaders(res.headers, this.opts.redactHeaders),
      url: redactUrl(res.url || req.url),
      body: null,
      chunks: [],
    };
    step.response = response;

    if (!res.body) {
      step.durationMs = this.elapsed() - startedAt;
      return rebuild(res, null);
    }

    // One branch goes back to the caller untouched; the other is drained eagerly so the
    // recording completes even if the caller never reads (or cancels) the body.
    const [mine, theirs] = res.body.tee();
    this.captures.push(runInternal(() => this.capture(mine, step, response, startedAt)));
    return rebuild(res, theirs);
  }

  /** Wait for in-flight bodies, marking any still streaming after the timeout as truncated. */
  async settle(): Promise<void> {
    const timeoutMs = this.opts.settleTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    });
    await Promise.race([Promise.allSettled(this.captures.map((c) => c.promise)), timeout]);
    clearTimeout(timer);
    for (const c of this.captures) if (!c.done) c.finalize('session ended before the response body finished');
  }

  toRecording(): Recording {
    return {
      format: FORMAT,
      name: this.name,
      createdAt: new Date(realNow()).toISOString(),
      runtime: { node: process.version },
      ...(this.fork ? { fork: this.fork } : {}),
      steps: [...this.steps].sort((a, b) => a.seq - b.seq),
      determinism: {
        seed: this.flags.random ? this.seed : null,
        clock: this.flags.clock ? { start: this.clockStart, deltas: this.clockDeltas } : null,
        uuids: this.flags.uuid ? this.uuids : null,
      },
      blobs: this.blobs.toJSON(),
    };
  }

  private capture(stream: ReadableStream<Uint8Array>, step: FetchStep, response: RecordedResponse, startedAt: number): BodyCapture {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    const headersAt = this.elapsed();

    const capture: BodyCapture = {
      done: false,
      finalize: (truncatedReason) => {
        if (capture.done) return;
        capture.done = true;
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        let body = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) {
          body.set(p, offset);
          offset += p.byteLength;
        }
        const text = tryDecode(body);
        if (text !== null) {
          const redacted = redactText(text);
          if (redacted !== text) {
            body = new TextEncoder().encode(redacted);
            resizeChunks(response.chunks, body.byteLength);
          }
        }
        response.body = this.blobs.put(body);
        if (truncatedReason) {
          response.truncated = { reason: truncatedReason };
          reader.cancel().catch(() => {});
        }
        step.durationMs = this.elapsed() - startedAt;
      },
      promise: Promise.resolve(),
    };

    capture.promise = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || capture.done) break;
          parts.push(value);
          response.chunks.push({ size: value.byteLength, at: round(this.elapsed() - headersAt) });
        }
        capture.finalize();
      } catch (err) {
        capture.finalize(`body stream errored: ${(err as Error).message}`);
      }
    })();
    return capture;
  }

  private elapsed(): number {
    return round(performance.now() - this.t0);
  }
}

function rebuild(res: Response, body: ReadableStream<Uint8Array> | null): Response {
  const headers = new Headers(res.headers);
  for (const h of DECODED_BODY_DROP) headers.delete(h);
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers });
  Object.defineProperty(out, 'url', { value: res.url });
  Object.defineProperty(out, 'redirected', { value: res.redirected });
  return out;
}

/** Keep chunk count and timing after redaction changed the body length; the last chunks absorb the difference. */
function resizeChunks(chunks: RecordedChunk[], total: number): void {
  let remaining = total;
  for (const [i, c] of chunks.entries()) {
    c.size = i === chunks.length - 1 ? remaining : Math.min(c.size, remaining);
    remaining -= c.size;
  }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
