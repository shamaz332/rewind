import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { runSession } from './context.js';
import { installDeterminism, uninstallDeterminism } from './determinism.js';
import { RewindError } from './errors.js';
import { Forker } from './fork.js';
import { install as installNetwork, rewindFetch, uninstall as uninstallNetwork } from './interceptor.js';
import { Recorder } from './recorder.js';
import { Replayer } from './replayer.js';
import { loadRecording, recordingPath, saveRecording } from './store.js';
import type { AutoOptions, ForkOptions, ForkResult, Mode, RecordOptions, Recording, ReplayOptions } from './types.js';
import { RecordingNotFoundError } from './errors.js';

/**
 * Patch `fetch`, `node:http`/`node:https`, `Date`, `Math.random` and `crypto.randomUUID`.
 * Runs on import. Outside a session every patched API behaves exactly like the original.
 */
export function install(): void {
  installNetwork();
  installDeterminism();
}

/** Restore every patched global. */
export function uninstall(): void {
  uninstallNetwork();
  uninstallDeterminism();
}

install();

/**
 * Run `fn` against the real network and save every request it makes, plus the clock and
 * randomness it reads, as the recording `name`. The recording is saved even when `fn` throws,
 * so failed runs can be replayed too. Sessions may run concurrently.
 */
export async function record<T>(name: string, fn: () => T | Promise<T>, opts: RecordOptions = {}): Promise<T> {
  const path = recordingPath(name, opts.dir);
  const recorder = new Recorder(name, opts);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await runSession(recorder, fn) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  await recorder.settle();
  await saveRecording(path, recorder.toRecording());
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Run `fn` with every request answered from the recording `name`, and with `Date`, `Math.random`
 * and `crypto.randomUUID` returning the recorded values. No network, no cost.
 * Throws `ReplayDivergenceError` if the run makes a request the recording has no answer for,
 * even if `fn` caught it (SDK retries often do).
 */
export async function replay<T>(name: string, fn: () => T | Promise<T>, opts: ReplayOptions = {}): Promise<T> {
  const recording = await loadRecording(name, opts.dir);
  const replayer = new Replayer(recording, opts);
  let value: T;
  try {
    value = await runSession(replayer, fn);
  } catch (error) {
    await settleFailure(name, replayer, opts);
    replayer.finish();
    throw error;
  }
  await settleFailure(name, replayer, opts);
  replayer.finish();
  return value;
}

/** Save `<name>.failed` when the replay diverged; remove a stale one when it did not. */
async function settleFailure(name: string, replayer: Replayer, opts: ReplayOptions): Promise<void> {
  if (opts.saveFailures === false || name.endsWith('.failed')) return;
  const path = recordingPath(`${name}.failed`, opts.dir);
  const failed = replayer.failureRecording();
  if (failed) await saveRecording(path, failed);
  else await rm(path, { force: true });
}

/**
 * Replay the recording `name` up to step `at`, then run live from there, e.g. to try a fixed
 * prompt at step 31 without paying for steps 0–30 again. Before `at`, requests are matched by
 * method + URL in recorded order and their bodies are ignored, so a changed prompt still gets the
 * recorded history. Clock and UUIDs follow the original run until it goes live.
 *
 * The fork is saved as its own recording (`<name>.fork-<at>` unless `saveAs` says otherwise),
 * which `replay()` reproduces exactly.
 */
export async function fork<T>(name: string, fn: () => T | Promise<T>, opts: ForkOptions = {}): Promise<ForkResult<T>> {
  const original = await loadRecording(name, opts.dir);
  const saveAs = opts.saveAs === false ? null : (opts.saveAs ?? `${name}.fork-${opts.at ?? 'end'}`);
  const path = saveAs ? recordingPath(saveAs, opts.dir) : null;
  const forker = new Forker(original, saveAs ?? `${name}.fork`, opts);

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await runSession(forker, fn) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  await forker.recorder.settle();
  if (path) {
    forker.recorder.setFork(forker.forkInfo());
    await saveRecording(path, forker.recorder.toRecording());
  }
  if (!outcome.ok) throw outcome.error;
  return { value: outcome.value, savedAs: saveAs, ...forker.result };
}

/**
 * Replay `name` if it has been recorded, otherwise record it. Ideal for tests.
 * The `REWIND_MODE` environment variable (`record` | `replay` | `auto`) overrides the choice,
 * e.g. `REWIND_MODE=record npm test` refreshes every recording.
 */
export async function auto<T>(name: string, fn: () => T | Promise<T>, opts: AutoOptions = {}): Promise<T> {
  const mode = resolveMode(name, opts.dir);
  return mode === 'record' ? record(name, fn, opts) : replay(name, fn, opts);
}

function resolveMode(name: string, dir?: string): Exclude<Mode, 'auto'> {
  const env = process.env.REWIND_MODE?.toLowerCase();
  if (env && env !== 'auto' && env !== 'record' && env !== 'replay') {
    throw new RewindError(`REWIND_MODE must be "record", "replay" or "auto", got "${process.env.REWIND_MODE}"`);
  }
  if (env === 'record' || env === 'replay') return env;
  return existsSync(recordingPath(name, dir)) ? 'replay' : 'record';
}

/** The outcome of `capture()`: what the callback returned, plus the recording it ran against. */
export interface Run<T> {
  value: T;
  /** The recording made (record mode) or replayed (replay mode). */
  recording: Recording;
  mode: 'record' | 'replay';
}

/**
 * Like `auto()`, but also returns the recording, so tests can assert on what the agent did:
 * tools called, tokens used, requests made. In CI (the `CI` env var is set), a missing recording
 * is an error instead of a live run, unless `REWIND_MODE=record`.
 */
export async function capture<T>(name: string, fn: () => T | Promise<T>, opts: AutoOptions = {}): Promise<Run<T>> {
  const mode = resolveMode(name, opts.dir);
  if (mode === 'record' && isCI() && process.env.REWIND_MODE?.toLowerCase() !== 'record') {
    throw new RecordingNotFoundError(
      name,
      recordingPath(name, opts.dir),
      'This is a CI run (CI is set), so rewind will not call live APIs to create it. ' +
        'Run the test locally to record it and commit the recording, or set REWIND_MODE=record to record in CI on purpose.',
    );
  }
  const value = mode === 'record' ? await record(name, fn, opts) : await replay(name, fn, opts);
  return { value, recording: await loadRecording(name, opts.dir), mode };
}

function isCI(): boolean {
  const ci = process.env.CI;
  return ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false';
}

/** Load a recording to inspect it. */
export const load = loadRecording;

export const rewind = { record, replay, fork, auto, capture, load, fetch: rewindFetch, install, uninstall };
export default rewind;

export { rewindFetch as fetch, recordingPath };
export { summarize, type RecordingSummary, type StepSummary } from './inspect.js';
export { diffRecordings, type RecordingDiff, type StepDiff } from './diff.js';
export { extractUsage, extractText, extractToolCalls, parsePayloads, type Usage, type Pricing } from './llm.js';
export { RewindError, RecordingNotFoundError, ReplayDivergenceError, UnusedStepsError } from './errors.js';
export { REDACTED } from './redact.js';
export type * from './types.js';
