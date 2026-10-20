import { RewindError } from './errors.js';

export type FetchHandler = (req: Request, realFetch: typeof fetch) => Promise<Response>;

let original: typeof fetch | null = null;
let handler: FetchHandler | null = null;

/**
 * Drop-in `fetch` that routes through the active rewind session, or straight to the network when idle.
 * Pass it explicitly to clients that capture `fetch` early: `new Anthropic({ fetch: rewind.fetch })`.
 */
export const rewindFetch: typeof fetch = (input, init) => {
  const real = original ?? globalThis.fetch;
  if (!handler) return real(input, init);
  return handler(new Request(input, init), real);
};

/**
 * Replace `globalThis.fetch` with the rewind wrapper. Runs automatically on import; idempotent.
 * Many SDKs capture `fetch` when a client is constructed, so import rewind before creating them.
 */
export function install(): void {
  if (original) return;
  if (typeof globalThis.fetch !== 'function') {
    throw new RewindError('rewind needs a global fetch (Node.js 18.17 or newer).');
  }
  original = globalThis.fetch;
  globalThis.fetch = rewindFetch;
}

/** Restore the original `globalThis.fetch`. */
export function uninstall(): void {
  if (!original) return;
  if (handler) throw new RewindError('Cannot uninstall while a rewind session is active.');
  globalThis.fetch = original;
  original = null;
}

export function activate(h: FetchHandler): void {
  install();
  if (handler) {
    throw new RewindError('A rewind session is already active. Sessions cannot be nested or run concurrently yet.');
  }
  handler = h;
}

export function deactivate(h: FetchHandler): void {
  if (handler === h) handler = null;
}
