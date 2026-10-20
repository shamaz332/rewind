import { existsSync } from 'node:fs';
import { RewindError } from './errors.js';
import { activate, deactivate, install, rewindFetch, uninstall } from './interceptor.js';
import { Recorder } from './recorder.js';
import { Replayer } from './replayer.js';
import { loadRecording, recordingPath, saveRecording } from './store.js';
import type { AutoOptions, Mode, RecordOptions, ReplayOptions } from './types.js';

install();

/**
 * Run `fn` against the real network and save every fetch it makes as the recording `name`.
 * The recording is saved even when `fn` throws, so failed runs can be replayed too.
 */
export async function record<T>(name: string, fn: () => T | Promise<T>, opts: RecordOptions = {}): Promise<T> {
  const path = recordingPath(name, opts.dir);
  const recorder = new Recorder(opts);
  activate(recorder.handle);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fn() };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    deactivate(recorder.handle);
  }
  await recorder.settle();
  await saveRecording(path, recorder.toRecording(name));
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Run `fn` with every fetch answered from the recording `name`. No network, no cost.
 * Throws `ReplayDivergenceError` if the run makes a request the recording has no answer for,
 * even if `fn` caught it (SDK retries often do).
 */
export async function replay<T>(name: string, fn: () => T | Promise<T>, opts: ReplayOptions = {}): Promise<T> {
  const recording = await loadRecording(name, opts.dir);
  const replayer = new Replayer(recording, opts);
  activate(replayer.handle);
  let value: T;
  try {
    value = await fn();
  } catch (error) {
    replayer.finish();
    throw error;
  } finally {
    deactivate(replayer.handle);
  }
  replayer.finish();
  return value;
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

export const rewind = { record, replay, auto, load, fetch: rewindFetch, install, uninstall };
export default rewind;

export { rewindFetch as fetch, install, uninstall, recordingPath };
export { RewindError, RecordingNotFoundError, ReplayDivergenceError, UnusedStepsError } from './errors.js';
export { REDACTED } from './redact.js';
export type * from './types.js';
