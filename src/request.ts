import { canonicalJson, sha256 } from './hash.js';
import { redactHeaders, redactText, redactUrl } from './redact.js';
import { tryDecode, type BlobStore } from './store.js';
import type { BaseOptions, RecordedRequest } from './types.js';

export interface DescribedRequest {
  recorded: RecordedRequest;
  /** Normalized URL used for matching. */
  matchUrl: string;
  /** Redacted body text, when the body is text. */
  bodyText: string | null;
}

/**
 * Turn a live Request into its recorded form. Record and replay both go through here,
 * so redaction and normalization are applied identically on both sides of a match.
 */
export async function describeRequest(req: Request, opts: BaseOptions, blobs?: BlobStore): Promise<DescribedRequest> {
  const method = req.method.toUpperCase();
  const url = redactUrl(req.url);
  const matchUrl = redactUrl(req.url, true);

  let raw: Uint8Array | null = req.body ? new Uint8Array(await req.clone().arrayBuffer()) : null;
  if (raw && raw.byteLength === 0) raw = null;

  let stored: Uint8Array | null = null;
  let bodyKey = '';
  let bodyText: string | null = null;
  if (raw) {
    const text = tryDecode(raw);
    if (text === null) {
      stored = raw;
      bodyKey = sha256(raw);
    } else {
      bodyText = redactText(text);
      if (opts.redactBody) bodyText = opts.redactBody(bodyText, { url });
      stored = new TextEncoder().encode(bodyText);
      bodyKey = sha256(canonicalJson(bodyText) ?? bodyText);
    }
  }

  return {
    recorded: {
      method,
      url,
      headers: redactHeaders(req.headers, opts.redactHeaders),
      body: stored ? (blobs ? blobs.put(stored) : sha256(stored)) : null,
      matchKey: sha256(`${method}\n${matchUrl}\n${bodyKey}`),
    },
    matchUrl,
    bodyText,
  };
}
