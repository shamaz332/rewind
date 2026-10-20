import type { FetchHandler } from './interceptor.js';
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

export class Recorder {
  private readonly steps: FetchStep[] = [];
  private readonly blobs = new BlobStore();
  private readonly captures: BodyCapture[] = [];
  private readonly t0 = performance.now();
  private seq = 0;

  constructor(private readonly opts: RecordOptions) {}

  readonly handle: FetchHandler = async (req, realFetch) => {
    const seq = this.seq++;
    const startedAt = this.elapsed();
    const { recorded } = await describeRequest(req, this.opts, this.blobs);
    const step: FetchStep = { seq, kind: 'fetch', startedAt, durationMs: 0, request: recorded };
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
      return res;
    }

    // One branch goes back to the caller untouched; the other is drained eagerly so the
    // recording completes even if the caller never reads (or cancels) the body.
    const [mine, theirs] = res.body.tee();
    this.captures.push(this.capture(mine, step, response, startedAt));
    return rebuild(res, theirs);
  };

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

  toRecording(name: string): Recording {
    return {
      format: FORMAT,
      name,
      createdAt: new Date().toISOString(),
      runtime: { node: process.version },
      steps: [...this.steps].sort((a, b) => a.seq - b.seq),
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

function rebuild(res: Response, body: ReadableStream<Uint8Array>): Response {
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
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
