import { capture, type Run } from './index.js';
import { matchers, testRecordingTarget, type RecordTestOptions, type RewindMatchers } from './matchers.js';

interface JestExpect {
  extend(m: object): void;
  getState(): { currentTestName?: string; testPath?: string };
}

/** Jest's `expect` is a global in the test environment; this module must be loaded from a test or setup file. */
function jestExpect(): JestExpect {
  const e = (globalThis as { expect?: JestExpect }).expect;
  if (!e || typeof e.extend !== 'function') {
    throw new Error('llm-rewind/jest must be imported inside Jest (e.g. from setupFilesAfterEach or a test file).');
  }
  return e;
}

jestExpect().extend(matchers);

/**
 * Run `fn` against this test's recording: record it on the first run, replay it afterwards.
 * The recording is named after the test and stored in `__recordings__/` next to the test file.
 * Refresh with `REWIND_MODE=record`. In CI a missing recording fails the test instead of going live.
 */
export function recordTest<T>(fn: () => T | Promise<T>, opts: RecordTestOptions = {}): Promise<Run<T>> {
  const { name, dir } = testRecordingTarget(jestExpect().getState(), opts);
  return capture(name, fn, { ...opts, dir });
}

export { matchers };
export type { RecordTestOptions, RewindMatchers };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Matchers<R> extends RewindMatchers<R> {}
  }
}
