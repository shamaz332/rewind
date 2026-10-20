import { createHash } from 'node:crypto';

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON: object keys sorted recursively, so key order never affects matching. */
export function canonicalJson(text: string): string | null {
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    return null;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}

export interface Difference {
  path: string;
  left: unknown;
  right: unknown;
}

/** First JSON path at which two values differ, e.g. `$.messages[2].content`. Null if equal. */
export function firstDifference(a: unknown, b: unknown, path = '$'): Difference | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return { path, left: a, right: b };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()) {
    const seg = /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
    const d = firstDifference(ao[k], bo[k], path + seg);
    if (d) return d;
  }
  return null;
}
