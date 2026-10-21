import { expect } from 'vitest';
import { capture, type Run } from './index.js';
import { matchers, testRecordingTarget, type RecordTestOptions, type RewindMatchers } from './matchers.js';

expect.extend(matchers);

/**
 * Run `fn` against this test's recording: record it on the first run, replay it afterwards.
 * The recording is named after the test and stored in `__recordings__/` next to the test file.
 * Refresh with `REWIND_MODE=record`. In CI a missing recording fails the test instead of going live.
 */
export function recordTest<T>(fn: () => T | Promise<T>, opts: RecordTestOptions = {}): Promise<Run<T>> {
  const { name, dir } = testRecordingTarget(expect.getState(), opts);
  return capture(name, fn, { ...opts, dir });
}

export { matchers };
export type { RecordTestOptions, RewindMatchers };

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends RewindMatchers<T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends RewindMatchers {}
}
