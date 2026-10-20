import { AsyncLocalStorage } from 'node:async_hooks';
import { RewindError } from './errors.js';

export type Transport = 'fetch' | 'node:http';
export type RealFetch = (req: Request) => Promise<Response>;

/** What the interceptors and determinism patches talk to. Implemented by Recorder and Replayer. */
export interface Session {
  readonly name: string;
  fetch(req: Request, realFetch: RealFetch, via: Transport): Promise<Response>;
  now(): number;
  random(): number;
  uuid(): string;
}

/** Marks rewind's own work (real network calls, body draining) so it is never recorded or replayed. */
const INTERNAL = Symbol('rewind.internal');

const storage = new AsyncLocalStorage<Session | typeof INTERNAL>();
const active = new Set<Session>();

export function runInternal<T>(fn: () => T): T {
  return storage.run(INTERNAL, fn);
}

export async function runSession<T>(session: Session, fn: () => T | Promise<T>): Promise<T> {
  const outer = storage.getStore();
  if (outer && outer !== INTERNAL && active.has(outer)) {
    throw new RewindError(`Cannot start session "${session.name}" inside session "${outer.name}". Sessions cannot be nested.`);
  }
  active.add(session);
  try {
    return await storage.run(session, fn);
  } finally {
    active.delete(session);
  }
}

/**
 * The session for the current async context.
 *
 * Network calls whose async context was lost (e.g. queued by a pool created before the session
 * started) fall back to the only active session; with several active they are ambiguous and throw.
 * Clock and randomness calls never fall back: test runners and loggers call `Date.now()` from
 * outside any session constantly, and those calls must not consume recorded values.
 */
export function networkSession(): Session | null {
  const store = storage.getStore();
  if (store === INTERNAL) return null;
  if (store) return active.has(store) ? store : null;
  if (active.size === 0) return null;
  if (active.size === 1) return active.values().next().value!;
  throw new RewindError(
    `A request was made outside any rewind session's async context while ${active.size} sessions ` +
      `(${[...active].map((s) => `"${s.name}"`).join(', ')}) are active, so rewind cannot tell which one it belongs to. ` +
      'Run the sessions one at a time, or make sure the request starts inside the session callback.',
  );
}

export function contextSession(): Session | null {
  const store = storage.getStore();
  return store && store !== INTERNAL && active.has(store) ? store : null;
}
