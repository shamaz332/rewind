import type { Difference } from './hash.js';
import { parseMaybeJson, summarize, type RecordingSummary, type StepSummary } from './inspect.js';
import type { Pricing, Usage } from './llm.js';
import type { Recording } from './types.js';

export type StepDiff =
  | { kind: 'same'; a: StepSummary; b: StepSummary }
  | {
      kind: 'changed';
      a: StepSummary;
      b: StepSummary;
      /** Where the request bodies differ (first few JSON paths). Empty when only the response changed. */
      request: Difference[];
      responseChanged: boolean;
      /** Where the response bodies differ, when both are JSON. */
      response: Difference[];
    }
  | { kind: 'removed'; a: StepSummary }
  | { kind: 'added'; b: StepSummary };

export interface RecordingDiff {
  a: RecordingSummary;
  b: RecordingSummary;
  steps: StepDiff[];
  /** Index into `steps` of the first entry that is not `same`, or null when the runs are identical. */
  firstDivergence: number | null;
  counts: { same: number; changed: number; added: number; removed: number };
  delta: { usage: Usage; cost: number | null; durationMs: number };
}

/**
 * Compare two runs step by step. Steps are aligned by method + host + path with a longest common
 * subsequence, so an inserted or dropped call shows up as one added/removed step instead of
 * shifting everything after it.
 */
export function diffRecordings(ra: Recording, rb: Recording, pricing: Pricing | null = null, maxPaths = 3): RecordingDiff {
  const a = summarize(ra, pricing);
  const b = summarize(rb, pricing);
  const steps: StepDiff[] = [];

  for (const [i, j] of align(a.steps.map((s) => s.signature), b.steps.map((s) => s.signature))) {
    const sa = i === null ? null : a.steps[i]!;
    const sb = j === null ? null : b.steps[j]!;
    if (sa && sb) {
      const sameRequest = sa.matchKey === sb.matchKey && sa.sentHash === sb.sentHash;
      const sameResponse = sa.responseHash === sb.responseHash && sa.status === sb.status && sa.error === sb.error;
      if (sameRequest && sameResponse) steps.push({ kind: 'same', a: sa, b: sb });
      else
        steps.push({
          kind: 'changed',
          a: sa,
          b: sb,
          request: sameRequest ? [] : differences(sa.requestBody, sb.requestBody, maxPaths),
          responseChanged: !sameResponse,
          response: sameResponse ? [] : jsonDifferences(sa.responseText, sb.responseText, maxPaths),
        });
    } else if (sa) steps.push({ kind: 'removed', a: sa });
    else if (sb) steps.push({ kind: 'added', b: sb });
  }

  const counts = { same: 0, changed: 0, added: 0, removed: 0 };
  for (const s of steps) counts[s.kind]++;
  const firstDivergence = steps.findIndex((s) => s.kind !== 'same');
  const ua = a.totals.usage;
  const ub = b.totals.usage;

  return {
    a,
    b,
    steps,
    firstDivergence: firstDivergence === -1 ? null : firstDivergence,
    counts,
    delta: {
      usage: { input: ub.input - ua.input, output: ub.output - ua.output, cacheRead: ub.cacheRead - ua.cacheRead, cacheWrite: ub.cacheWrite - ua.cacheWrite },
      cost: a.totals.cost !== null || b.totals.cost !== null ? (b.totals.cost ?? 0) - (a.totals.cost ?? 0) : null,
      durationMs: b.totals.durationMs - a.totals.durationMs,
    },
  };
}

/** LCS alignment. Returns index pairs in order; null on one side marks an insertion or deletion. */
export function align(xs: string[], ys: string[]): [number | null, number | null][] {
  const n = xs.length;
  const m = ys.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = xs[i] === ys[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: [number | null, number | null][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (xs[i] === ys[j]) out.push([i++, j++]);
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) out.push([i++, null]);
    else out.push([null, j++]);
  }
  while (i < n) out.push([i++, null]);
  while (j < m) out.push([null, j++]);
  return out;
}

function jsonDifferences(a: string | null, b: string | null, limit: number): Difference[] {
  const pa = parseMaybeJson(a);
  const pb = parseMaybeJson(b);
  // Only meaningful for structured bodies; text and SSE bodies are compared through the model output instead.
  if (typeof pa !== 'object' || typeof pb !== 'object' || pa === null || pb === null) return [];
  return differences(pa, pb, limit);
}

/** Up to `limit` JSON paths where two values differ, depth first. */
export function differences(a: unknown, b: unknown, limit = 3, path = '$', out: Difference[] = []): Difference[] {
  if (out.length >= limit || Object.is(a, b)) return out;
  const bothObjects = a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) {
    out.push({ path, left: a, right: b });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length) && out.length < limit; i++) differences(a[i], b[i], limit, `${path}[${i}]`, out);
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()) {
    if (out.length >= limit) break;
    const seg = /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
    differences(ao[k], bo[k], limit, path + seg, out);
  }
  return out;
}
