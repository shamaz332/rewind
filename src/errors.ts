export class RewindError extends Error {
  override name = 'RewindError';
}

export class RecordingNotFoundError extends RewindError {
  override name = 'RecordingNotFoundError';
  constructor(
    readonly recordingName: string,
    readonly path: string,
    hint = 'Record it first with rewind.record(), or use rewind.auto().',
  ) {
    super(`No recording named "${recordingName}" at ${path}. ${hint}`);
  }
}

/** The replayed run made a request the recording has no answer for. */
export class ReplayDivergenceError extends RewindError {
  override name = 'ReplayDivergenceError';
  constructor(
    message: string,
    readonly request: { method: string; url: string },
    /** JSON path of the first body difference against the closest recorded request, when one was found. */
    readonly bodyDiffPath: string | null,
  ) {
    super(message);
  }
}

export class UnusedStepsError extends RewindError {
  override name = 'UnusedStepsError';
  constructor(readonly unused: { seq: number; method: string; url: string }[]) {
    super(
      `Replay finished with ${unused.length} unused recorded step(s):\n` +
        unused.map((s) => `  #${s.seq} ${s.method} ${s.url}`).join('\n'),
    );
  }
}
