import nodeCrypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { contextSession } from './context.js';

/** The real implementations, captured before any patching. */
export const RealDate = Date;
export const realNow = Date.now.bind(Date);
export const realRandom = Math.random.bind(Math);
const realNodeUUID = nodeCrypto.randomUUID;
const webcrypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
const realWebUUID = webcrypto?.randomUUID?.bind(webcrypto);
export const realUUID = (): string => realNodeUUID();

let installed = false;

/**
 * Patch `Date`, `Math.random` and `crypto.randomUUID` so code running inside a session gets
 * recorded/replayed values. Outside a session every call goes to the real implementation.
 */
export function installDeterminism(): void {
  if (installed) return;
  installed = true;

  const now = () => contextSession()?.now() ?? realNow();

  const DateProxy = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget);
    },
    // `Date()` called as a function returns the current time as a string.
    apply() {
      return new RealDate(now()).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return now;
      return Reflect.get(target, prop, receiver);
    },
  });
  globalThis.Date = DateProxy;
  // Keep `new Date().constructor === Date` true for code that checks it.
  Object.defineProperty(RealDate.prototype, 'constructor', { value: DateProxy, writable: true, configurable: true });

  Math.random = () => contextSession()?.random() ?? realRandom();

  const uuid = ((opts?: nodeCrypto.RandomUUIDOptions) => {
    const s = contextSession();
    return (s ? s.uuid() : realNodeUUID(opts)) as `${string}-${string}-${string}-${string}-${string}`;
  }) as typeof nodeCrypto.randomUUID;
  nodeCrypto.randomUUID = uuid;
  syncBuiltinESMExports(); // so `import { randomUUID } from 'node:crypto'` sees the patch too
  if (webcrypto && realWebUUID) {
    Object.defineProperty(webcrypto, 'randomUUID', { value: uuid, writable: true, configurable: true });
  }
}

export function uninstallDeterminism(): void {
  if (!installed) return;
  installed = false;
  globalThis.Date = RealDate;
  Object.defineProperty(RealDate.prototype, 'constructor', { value: RealDate, writable: true, configurable: true });
  Math.random = realRandom;
  nodeCrypto.randomUUID = realNodeUUID;
  syncBuiltinESMExports();
  if (webcrypto && realWebUUID) delete webcrypto.randomUUID;
}

/** Seeded PRNG (mulberry32), combined to 53 bits so it is a drop-in for `Math.random()`. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  const next32 = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return () => ((next32() >>> 5) * 67108864 + (next32() >>> 6)) / 9007199254740992;
}

/** A v4-format UUID drawn from a PRNG. */
export function uuidFrom(rand: () => number): string {
  const b = Array.from({ length: 16 }, () => Math.floor(rand() * 256));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface DeterminismFlags {
  clock: boolean;
  random: boolean;
  uuid: boolean;
}

export function resolveFlags(opt: boolean | Partial<DeterminismFlags> | undefined): DeterminismFlags {
  if (opt === false) return { clock: false, random: false, uuid: false };
  if (opt === true || opt === undefined) return { clock: true, random: true, uuid: true };
  return { clock: opt.clock ?? true, random: opt.random ?? true, uuid: opt.uuid ?? true };
}
