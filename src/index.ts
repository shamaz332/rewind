import { existsSync } from 'node:fs';
import { runSession } from './context.js';
import { installDeterminism, uninstallDeterminism } from './determinism.js';
import { RewindError } from './errors.js';
import { Forker } from './fork.js';
import { install as installNetwork, rewindFetch, uninstall as uninstallNetwork } from './interceptor.js';
import { Recorder } from './recorder.js';
import { Replayer } from './replayer.js';
import { loadRecording, recordingPath, saveRecording } from './store.js';
import type { AutoOptions, ForkOptions, ForkResult, Mode, RecordOptions, ReplayOptions } from './types.js';

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
    replayer.finish();
    throw error;
  }
  replayer.finish();
  return value;
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

/** Load a recording to inspect it. */
export const load = loadRecording;

export const rewind = { record, replay, fork, auto, load, fetch: rewindFetch, install, uninstall };
export default rewind;

export { rewindFetch as fetch, recordingPath };
export { RewindError, RecordingNotFoundError, ReplayDivergenceError, UnusedStepsError } from './errors.js';
export { REDACTED } from './redact.js';
export type * from './types.js';
