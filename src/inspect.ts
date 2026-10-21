import { canonicalJson } from './hash.js';
import { costOf, extractModel, extractText, extractUsage, parsePayloads, type Pricing, type Usage } from './llm.js';
import { BlobStore, tryDecode } from './store.js';
import type { FetchStep, Recording } from './types.js';

export interface StepSummary {
  seq: number;
  via: FetchStep['via'];
  source: FetchStep['source'];
  patched: boolean;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  error: string | null;
  truncated: boolean;
  startedAt: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  /** Set when the request looks like an LLM call. */
  model: string | null;
  usage: Usage | null;
  cost: number | null;
  /** The model's output text (LLM calls) or null. */
  output: string | null;
  /** Parsed request body: JSON value, text, or null. */
  requestBody: unknown;
  /** Response body as text, or null for binary/no body. */
  responseText: string | null;
  /** Identity of the request for diffing: method, host and path. */
  signature: string;
  matchKey: string;
  /** Blob hash of the body actually sent (differs from the matched one for patched fork steps). */
  sentHash: string | null;
  responseHash: string | null;
}

export interface RecordingSummary {
  name: string;
  createdAt: string;
  fork: Recording['fork'] | null;
  steps: StepSummary[];
  totals: {
    steps: number;
    llmCalls: number;
    errors: number;
    durationMs: number;
    usage: Usage;
    /** Null unless pricing was given and covered at least one call. */
    cost: number | null;
  };
}

export function summarize(rec: Recording, pricing: Pricing | null = null): RecordingSummary {
  const blobs = BlobStore.fromJSON(rec.blobs);
  const text = (hash: string | null) => (hash ? tryDecode(blobs.get(hash)) : null);
  const size = (hash: string | null) => (hash ? blobs.get(hash).byteLength : 0);

  const steps = [...rec.steps]
    .sort((a, b) => a.seq - b.seq)
    .map((s): StepSummary => {
      const reqText = text(s.sentBody ?? s.request.body);
      const requestBody = parseMaybeJson(reqText);
      const responseText = text(s.response?.body ?? null);
      const payloads = parsePayloads(responseText);
      const usage = extractUsage(payloads);
      const model = usage || isObjWithModel(requestBody) ? extractModel(requestBody, payloads, s.request.url) : null;
      let host = '';
      let path = s.request.url;
      try {
        const u = new URL(s.request.url);
        host = u.host;
        path = u.pathname + u.search;
      } catch {
        /* keep raw */
      }
      return {
        seq: s.seq,
        via: s.via ?? 'fetch',
        source: s.source,
        patched: s.patched === true,
        method: s.request.method,
        url: s.request.url,
        host,
        path,
        status: s.response?.status ?? null,
        error: s.error ? s.error.message : null,
        truncated: Boolean(s.response?.truncated),
        startedAt: s.startedAt,
        durationMs: s.durationMs,
        requestBytes: size(s.request.body),
        responseBytes: size(s.response?.body ?? null),
        model,
        usage,
        cost: costOf(model, usage, pricing),
        output: model ? extractText(payloads) : null,
        requestBody,
        responseText,
        signature: `${s.request.method} ${host}${path.split('?')[0]}`,
        matchKey: s.request.matchKey,
        sentHash: s.sentBody ?? s.request.body,
        responseHash: s.response?.body ?? null,
      };
    });

  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost: number | null = null;
  for (const s of steps) {
    if (s.usage) for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += s.usage[k];
    if (s.cost !== null) cost = (cost ?? 0) + s.cost;
  }
  const last = steps.reduce((m, s) => Math.max(m, s.startedAt + s.durationMs), 0);

  return {
    name: rec.name,
    createdAt: rec.createdAt,
    fork: rec.fork ?? null,
    steps,
    totals: {
      steps: steps.length,
      llmCalls: steps.filter((s) => s.model).length,
      errors: steps.filter((s) => s.error || (s.status !== null && s.status >= 400)).length,
      durationMs: Math.round(last),
      usage,
      cost,
    },
  };
}

export function parseMaybeJson(text: string | null): unknown {
  if (text === null) return null;
  if (canonicalJson(text) === null) return text;
  return JSON.parse(text) as unknown;
}

function isObjWithModel(v: unknown): boolean {
  return v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>).model === 'string';
}
