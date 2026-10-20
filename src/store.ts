import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { RecordingNotFoundError, RewindError } from './errors.js';
import { sha256 } from './hash.js';
import { FORMAT, type BlobEntry, type Recording } from './types.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Content-addressed blob storage: identical bodies are stored once per recording. */
export class BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes);
    return hash;
  }

  get(hash: string): Uint8Array {
    const bytes = this.blobs.get(hash);
    if (!bytes) throw new RewindError(`Recording is corrupt: missing blob ${hash}`);
    return bytes;
  }

  toJSON(): Record<string, BlobEntry> {
    const out: Record<string, BlobEntry> = {};
    for (const [hash, bytes] of this.blobs) {
      const text = tryDecode(bytes);
      out[hash] = text === null ? { base64: Buffer.from(bytes).toString('base64') } : { utf8: text };
    }
    return out;
  }

  static fromJSON(entries: Record<string, BlobEntry>): BlobStore {
    const store = new BlobStore();
    for (const [hash, entry] of Object.entries(entries)) {
      const bytes = 'utf8' in entry ? new TextEncoder().encode(entry.utf8) : new Uint8Array(Buffer.from(entry.base64, 'base64'));
      store.blobs.set(hash, bytes);
    }
    return store;
  }
}

export function tryDecode(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export function recordingPath(name: string, dir = '.rewind'): string {
  if (!name || name.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) {
    throw new RewindError(`Invalid recording name "${name}"`);
  }
  const safe = name.replace(/[^A-Za-z0-9._/-]/g, '_');
  return join(resolve(dir), `${safe}.rewind.json`);
}

export async function saveRecording(path: string, rec: Recording): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rec, null, 2) + '\n');
  await rename(tmp, path);
}

export async function loadRecording(name: string, dir?: string): Promise<Recording> {
  const path = recordingPath(name, dir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new RecordingNotFoundError(name, path);
    throw err;
  }
  const rec = JSON.parse(raw) as Recording;
  if (rec.format !== FORMAT) {
    throw new RewindError(`${path} has format "${String(rec.format)}"; this version of rewind reads "${FORMAT}".`);
  }
  return rec;
}
