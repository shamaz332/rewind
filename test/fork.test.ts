import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fork, load, record, replay } from '../src/index.js';

let server: Server;
let base: string;
let counter = 0;
let dir: string;

beforeAll(async () => {
  // A fake "model": echoes what it was sent, plus a call counter, so tests can tell live from replayed.
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const path = new URL(req.url!, 'http://x').pathname;
    res.setHeader('content-type', 'application/json');
    if (path === '/model') res.end(JSON.stringify({ n: ++counter, got: JSON.parse(body) }));
    else if (path === '/tool') res.end(JSON.stringify({ n: ++counter, ok: true, data: `tool result ${counter}` }));
    else res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rewind-fork-'));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const post = async (path: string, body: unknown): Promise<Json> =>
  (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

/** A tiny agent loop: each step sends the system prompt plus everything seen so far. */
function agent(system: string, steps = 3) {
  return async () => {
    const history: Json[] = [];
    for (let i = 0; i < steps; i++) history.push(await post('/model', { system, step: i, seen: history.map((h) => h.n) }));
    return history;
  };
}

describe('fork', () => {
  it('replays steps before `at` and runs the rest live', async () => {
    const recorded = await record('base', agent('v1'), { dir });
    const before = counter;
    const res = await fork('base', agent('v1'), { dir, at: 2 });

    expect(res.value.slice(0, 2)).toEqual(recorded.slice(0, 2));
    expect(res.value[2].n).toBe(before + 1); // the live call
    expect(counter).toBe(before + 1);
    expect(res).toMatchObject({ replayed: 2, live: 1, liveFrom: 2, reason: 'at', savedAs: 'base.fork-2' });
  });

  it('keeps the recorded history when the prompt changed', async () => {
    await record('prompt', agent('be terse'), { dir });
    const res = await fork('prompt', agent('be helpful'), { dir, at: 2 });
    // Steps 0-1 are what the model said under the old prompt; step 2 is live with the new one.
    expect(res.value.map((h: Json) => h.got.system)).toEqual(['be terse', 'be terse', 'be helpful']);
    expect(res.reason).toBe('at');
  });

  it('saves a fork recording that replay() reproduces exactly', async () => {
    const run = async () => {
      const id = crypto.randomUUID();
      const t = Date.now();
      const out = await agent('v1')();
      return { id, t, out, after: crypto.randomUUID() };
    };
    const recorded = await record('det', run, { dir });
    const forked = await fork('det', run, { dir, at: 1 });
    expect(forked.value.id).toBe(recorded.id); // read before going live: from the original run
    expect(forked.value.t).toBe(recorded.t);
    expect(forked.value.after).not.toBe(recorded.after); // read after going live: real

    const before = counter;
    expect(await replay('det.fork-1', run, { dir })).toEqual(forked.value);
    expect(counter).toBe(before);

    const rec = await load('det.fork-1', dir);
    expect(rec.fork).toEqual({ from: 'det', at: 1, liveFrom: 1, reason: 'at' });
    expect(rec.steps.map((s) => s.source)).toEqual(['replayed', 'live', 'live']);
  });

  it('patchRequest changes what goes out live, but the recording keeps the original request', async () => {
    await record('patch-req', agent('v1'), { dir });
    const res = await fork('patch-req', agent('v1'), {
      dir,
      at: 1,
      patchRequest: (req) => ({ ...(req.body as Json), system: 'patched' }),
    });
    expect(res.value.map((h: Json) => h.got.system)).toEqual(['v1', 'patched', 'patched']);

    // Unpatched code replays the fork recording, because requests are recorded before patching.
    expect(await replay('patch-req.fork-1', agent('v1'), { dir })).toEqual(res.value);
    expect((await load('patch-req.fork-1', dir)).steps.map((s) => s.patched ?? false)).toEqual([false, true, true]);
  });

  it('patchResponse changes what the agent sees from a replayed step', async () => {
    await record('patch-res', agent('v1'), { dir });
    const res = await fork('patch-res', agent('v1'), {
      dir,
      at: 2,
      patchResponse: (r, { step }) => (step === 1 ? { ...(r.body as Json), n: -1 } : undefined),
    });
    expect(res.value[1].n).toBe(-1);
    expect(res.value[2].got.seen[1]).toBe(-1); // the live step was built on the patched answer
  });

  it('goes live early, and says so, when the run stops matching the recording', async () => {
    await record('early', async () => [await post('/model', { a: 1 }), await post('/model', { a: 2 }), await post('/model', { a: 3 })], { dir });
    const res = await fork('early', async () => [await post('/model', { a: 1 }), await post('/tool', {}), await post('/model', { a: 3 })], { dir, at: 3 });
    expect(res).toMatchObject({ replayed: 1, live: 2, liveFrom: 1, reason: 'unmatched' });
    expect(res.value[1].ok).toBe(true);
  });

  it('without `at`, replays everything recorded and continues live', async () => {
    const recorded = await record('extend', agent('v1', 2), { dir });
    const res = await fork('extend', agent('v1', 4), { dir });
    expect(res.value.slice(0, 2)).toEqual(recorded);
    expect(res).toMatchObject({ replayed: 2, live: 2, liveFrom: 2, reason: 'at', savedAs: 'extend.fork-end' });
  });

  it('at: 0 runs everything live from the original seed', async () => {
    await record('zero', async () => [Math.random(), await post('/model', {})], { dir });
    const recorded = await load('zero', dir);
    const res = await fork('zero', async () => [Math.random(), await post('/model', {})], { dir, at: 0 });
    expect(res).toMatchObject({ replayed: 0, live: 1 });
    expect((await load('zero.fork-0', dir)).determinism.seed).toBe(recorded.determinism.seed);
  });

  it('saveAs names or disables the fork recording', async () => {
    await record('named', agent('v1', 1), { dir });
    expect((await fork('named', agent('v1', 1), { dir, saveAs: 'experiment-7' })).savedAs).toBe('experiment-7');
    await load('experiment-7', dir);
    const res = await fork('named', agent('v1', 1), { dir, saveAs: false });
    expect(res.savedAs).toBeNull();
    await expect(load('named.fork-end', dir)).rejects.toThrow(/No recording/);
  });

  it('saves the fork even when the run throws', async () => {
    await record('crash', agent('v1', 2), { dir });
    await expect(
      fork('crash', async () => {
        await agent('v1', 2)();
        throw new Error('still broken');
      }, { dir, at: 1 }),
    ).rejects.toThrow('still broken');
    expect((await load('crash.fork-1', dir)).steps).toHaveLength(2);
  });
});
