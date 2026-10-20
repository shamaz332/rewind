export const REDACTED = '[REDACTED]';

const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
]);

const SECRET_QUERY = /^(key|api[-_]?key|access[-_]?token|token|secret|client[-_]?secret|signature|sig|password)$/i;

// Well-known credential shapes. Order matters: the Anthropic pattern must run before the generic `sk-` one.
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
];

export function redactHeaders(headers: Headers, extra: string[] = []): Record<string, string> {
  const extraSet = new Set(extra.map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    out[key] = SECRET_HEADERS.has(key) || extraSet.has(key) ? REDACTED : redactText(value);
  }
  return sortRecord(out);
}

/** Redacts secret-looking query params. With `normalize`, also sorts params so order never affects matching. */
export function redactUrl(raw: string, normalize = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return redactText(raw);
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY.test(key)) url.searchParams.set(key, REDACTED);
  }
  if (normalize) {
    url.searchParams.sort();
    url.hash = '';
  }
  return redactText(url.toString());
}

export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

function sortRecord(rec: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
