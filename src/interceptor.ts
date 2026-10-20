import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest';
import { networkSession, runInternal, type RealFetch } from './context.js';
import { RewindError } from './errors.js';

let original: typeof fetch | null = null;
let http: ClientRequestInterceptor | null = null;

function realFetch(): typeof fetch {
  return original ?? globalThis.fetch;
}

const fetchForFetch: RealFetch = (req) => runInternal(() => realFetch()(req));

// node:http clients expect redirects as-is and decode bodies themselves; rewind hands them
// the decoded body and drops content-encoding (see Recorder), so only redirects need care here.
const fetchForHttp: RealFetch = (req) =>
  runInternal(() => realFetch()(new Request(req, { redirect: 'manual', duplex: 'half' } as RequestInit)));

/**
 * Drop-in `fetch` that routes through the active rewind session, or straight to the network when idle.
 * Pass it explicitly to clients that capture `fetch` early: `new Anthropic({ fetch: rewind.fetch })`.
 */
export const rewindFetch: typeof fetch = async (input, init) => {
  const session = networkSession();
  if (!session) return realFetch()(input, init);
  return session.fetch(new Request(input, init), fetchForFetch, 'fetch');
};

/**
 * Patch `globalThis.fetch` and `node:http`/`node:https`. Runs automatically on import; idempotent.
 * Many SDKs capture `fetch` when a client is constructed, so import rewind before creating them.
 */
export function install(): void {
  if (!original) {
    if (typeof globalThis.fetch !== 'function') {
      throw new RewindError('rewind needs a global fetch (Node.js 18.17 or newer).');
    }
    original = globalThis.fetch;
    globalThis.fetch = rewindFetch;
  }
  if (!http) {
    http = new ClientRequestInterceptor();
    http.on('request', async ({ request, controller }) => {
      let session;
      try {
        session = networkSession();
      } catch (err) {
        controller.errorWith(err as Error);
        return;
      }
      if (!session) return; // no session: the request goes to the network untouched
      try {
        controller.respondWith(await session.fetch(request, fetchForHttp, 'node:http'));
      } catch (err) {
        controller.errorWith(err as Error);
      }
    });
    http.apply();
  }
}

/** Restore the original `globalThis.fetch` and `node:http`. */
export function uninstall(): void {
  if (original) {
    globalThis.fetch = original;
    original = null;
  }
  if (http) {
    http.dispose();
    http = null;
  }
}
