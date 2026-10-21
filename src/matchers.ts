import { createHash } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { summarize, type RecordingSummary } from './inspect.js';
import type { AutoOptions, Recording } from './types.js';

/**
 * Framework-agnostic matchers. `rewindjs/vitest` and `rewindjs/jest` register them with `expect.extend`.
 * Each accepts a `Run` from `capture()`/`recordTest()`, a `Recording`, or a `RecordingSummary`.
 */

interface MatcherContext {
  isNot: boolean;
}

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

export interface RewindMatchers<R = unknown> {
  /** The model asked to call this tool at least once. */
  toHaveCalledTool(name: string): R;
  /** The model asked to call these tools in this order (other calls may come in between). */
  toCallToolsInOrder(names: string[]): R;
  /** Total tokens (or just `input`/`output`) across all LLM calls is at most `max`. */
  toStayWithinTokens(max: number, options?: { count?: 'total' | 'input' | 'output' }): R;
  /** The run made exactly `n` LLM calls, or a number within `{ min, max }`. */
  toHaveLLMCalls(expected: number | { min?: number; max?: number }): R;
  /** No request failed: no network errors, no HTTP 4xx/5xx. */
  toHaveNoFailedRequests(): R;
}

function toSummary(received: unknown): RecordingSummary {
  const r = received as { recording?: unknown; steps?: unknown; totals?: unknown; format?: unknown; blobs?: unknown };
  if (r && typeof r === 'object') {
    if (r.recording && typeof r.recording === 'object') return summarize(r.recording as Recording);
    if (r.format && r.blobs && Array.isArray(r.steps)) return summarize(r as Recording);
    if (r.totals && Array.isArray(r.steps)) return r as RecordingSummary;
  }
  throw new TypeError('expected a rewind Run (from capture() or recordTest()), a Recording, or a RecordingSummary');
}

function toolSequence(s: RecordingSummary): { name: string; seq: number }[] {
  return s.steps.flatMap((st) => st.toolCalls.map((name) => ({ name, seq: st.seq })));
}

const list = (xs: string[]) => (xs.length ? xs.join(', ') : '(none)');

export const matchers = {
  toHaveCalledTool(this: MatcherContext, received: unknown, name: string): MatcherResult {
    const calls = toolSequence(toSummary(received));
    const hit = calls.find((c) => c.name === name);
    return {
      pass: Boolean(hit),
      message: () =>
        hit
          ? `expected the run not to call tool "${name}", but the model called it at step #${hit.seq}`
          : `expected the run to call tool "${name}"\ntools called: ${list(calls.map((c) => c.name))}`,
    };
  },

  toCallToolsInOrder(this: MatcherContext, received: unknown, names: string[]): MatcherResult {
    const calls = toolSequence(toSummary(received)).map((c) => c.name);
    let i = 0;
    for (const c of calls) if (c === names[i]) i++;
    const pass = i === names.length;
    return {
      pass,
      message: () =>
        pass
          ? `expected the run not to call ${list(names)} in that order, but it did\ntools called: ${list(calls)}`
          : `expected the run to call tools in order: ${list(names)}\n` +
            `matched the first ${i}, then "${names[i]}" never came\ntools called: ${list(calls)}`,
    };
  },

  toStayWithinTokens(this: MatcherContext, received: unknown, max: number, options: { count?: 'total' | 'input' | 'output' } = {}): MatcherResult {
    const s = toSummary(received);
    const u = s.totals.usage;
    const input = u.input + u.cacheRead + u.cacheWrite;
    const count = options.count ?? 'total';
    const used = count === 'input' ? input : count === 'output' ? u.output : input + u.output;
    const label = count === 'total' ? 'tokens' : `${count} tokens`;
    // Name the heaviest calls so a failed budget points at what to look at.
    const heaviest = s.steps
      .filter((st) => st.usage)
      .map((st) => ({ seq: st.seq, n: st.usage!.input + st.usage!.cacheRead + st.usage!.cacheWrite + st.usage!.output }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((x) => `#${x.seq} (${x.n.toLocaleString('en')})`);
    return {
      pass: used <= max,
      message: () =>
        used <= max
          ? `expected the run to use more than ${max.toLocaleString('en')} ${label}, but it used ${used.toLocaleString('en')}`
          : `expected the run to use at most ${max.toLocaleString('en')} ${label}, but it used ${used.toLocaleString('en')} ` +
            `(${input.toLocaleString('en')} in / ${u.output.toLocaleString('en')} out across ${s.totals.llmCalls} LLM calls)\n` +
            `largest calls: ${list(heaviest)}`,
    };
  },

  toHaveLLMCalls(this: MatcherContext, received: unknown, expected: number | { min?: number; max?: number }): MatcherResult {
    const n = toSummary(received).totals.llmCalls;
    const range = typeof expected === 'number' ? { min: expected, max: expected } : expected;
    const pass = n >= (range.min ?? 0) && n <= (range.max ?? Infinity);
    const want =
      typeof expected === 'number'
        ? `exactly ${expected}`
        : [range.min !== undefined ? `at least ${range.min}` : null, range.max !== undefined ? `at most ${range.max}` : null].filter(Boolean).join(' and ');
    return {
      pass,
      message: () => (pass ? `expected the run not to make ${want} LLM calls, but it made ${n}` : `expected ${want} LLM calls, but the run made ${n}`),
    };
  },

  toHaveNoFailedRequests(this: MatcherContext, received: unknown): MatcherResult {
    const failed = toSummary(received).steps.filter((st) => st.error || (st.status ?? 0) >= 400);
    return {
      pass: failed.length === 0,
      message: () =>
        failed.length === 0
          ? 'expected some requests to fail, but none did'
          : `expected no failed requests, but ${failed.length} failed:\n` +
            failed.map((st) => `  #${st.seq} ${st.method} ${st.url} → ${st.error ?? st.status}`).join('\n'),
    };
  },
};

// ─── recordTest ──────────────────────────────────────────────────────────────

export interface TestState {
  currentTestName?: string;
  testPath?: string;
}

export interface RecordTestOptions extends AutoOptions {
  /** Recording name. Default: derived from the test's name. */
  name?: string;
}

const callsPerTest = new Map<string, number>();

/**
 * Where a test's recording lives: `__recordings__/<test file>/<test name>.rewind.json` next to the
 * test file, like `__snapshots__`. A test that records several runs gets `-2`, `-3`, ... suffixes.
 */
export function testRecordingTarget(state: TestState, opts: RecordTestOptions = {}): { name: string; dir: string } {
  const { currentTestName, testPath } = state;
  if (!currentTestName || !testPath) {
    throw new Error('recordTest() must be called inside a running test (expect.getState() has no current test).');
  }
  const dir = opts.dir ?? join(dirname(testPath), '__recordings__', basename(testPath));
  if (opts.name) return { name: opts.name, dir };

  const key = `${testPath}\0${currentTestName}`;
  const n = (callsPerTest.get(key) ?? 0) + 1;
  callsPerTest.set(key, n);
  let base = currentTestName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'test';
  if (base.length > 100) base = `${base.slice(0, 90)}-${createHash('sha256').update(currentTestName).digest('hex').slice(0, 8)}`;
  return { name: n === 1 ? base : `${base}-${n}`, dir };
}
