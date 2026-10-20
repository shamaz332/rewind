import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auto, load, record, recordingPath, replay, ReplayDivergenceError, UnusedStepsError } from '../src/index.js';

let server: Server;
let base: string;
let counter = 0;
let dir: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, 'http://x');

    if (url.pathname === '/count') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ n: ++counter, random: Math.random() }));
    } else if (url.pathname === '/echo') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'session=supersecret');
      res.end(JSON.stringify({ got: body ? JSON.parse(body) : null, n: ++counter }));
    } else if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const word of ['Hello', ' from', ' the', ' model']) {
        res.write(`data: ${JSON.stringify({ delta: word })}\n\n`);
        await new Promise((r) => setTimeout(r, 15));
      }
      res.end('data: [DONE]\n\n');
    } else if (url.pathname === '/empty') {
      res.writeHead(204).end();
    } else if (url.pathname === '/binary') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(Buffer.from([0xff, 0x00, 0xfe, 0x80, counter++]));
    } else {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rewind-test-'));
  delete process.env.REWIND_MODE;
});

afterEach(() => rm(dir, { recursive: true, force: true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJson = async (path: string, init?: RequestInit): Promise<any> => (await fetch(base + path, init)).json();
const postJson = (path: string, body: unknown) =>
  getJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function readSse(path: string): Promise<{ text: string; chunks: number }> {
  const res = await fetch(base + path);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    text += decoder.decode(value, { stream: true });
  }
  return { text, chunks };
}

describe('record and replay', () => {
  it('replays the exact responses of a run, offline', async () => {
    const run = async () => [await getJson('/count'), await getJson('/count'), await postJson('/echo', { q: 1 })];
    const recorded = await record('basic', run, { dir });
    const before = counter;
    const replayed = await replay('basic', run, { dir });
    expect(replayed).toEqual(recorded);
    expect(counter).toBe(before); // the server was never hit
  });

  it('works when the server is gone', async () => {
    const recorded = await record('offline', () => getJson('/count'), { dir });
    const offlineBase = base;
    await new Promise<void>((r) => server.close(() => r()));
    try {
      expect(await replay('offline', () => fetch(offlineBase + '/count').then((r) => r.json()), { dir })).toEqual(recorded);
    } finally {
      await new Promise<void>((r) => server.listen(Number(new URL(offlineBase).port), '127.0.0.1', r));
    }
  });

  it('replays identical requests in recorded order', async () => {
    const run = async () => Promise.all([getJson('/count'), getJson('/count'), getJson('/count')]);
    const recorded = await record('repeat', run, { dir });
    const sorted = (xs: { n: number }[]) => xs.map((x) => x.n).sort((a, b) => a - b);
    expect(sorted(await replay('repeat', run, { dir }))).toEqual(sorted(recorded));
  });

  it('redacts secrets in streamed responses without breaking replay', async () => {
    const key = 'sk-' + 'Z'.repeat(30);
    const run = () => fetch(`${base}/echo`, { method: 'POST', body: JSON.stringify({ key }) }).then((r) => r.text());
    await record('stream-redact', run, { dir });
    const replayed = await replay('stream-redact', run, { dir });
    expect(replayed).not.toContain(key);
    expect(JSON.parse(replayed).got.key).toBe('[REDACTED]');
  });

  it('preserves streamed bodies chunk by chunk', async () => {
    const recorded = await record('sse', () => readSse('/sse'), { dir });
    expect(recorded.text).toContain('Hello');
    const rec = await load('sse', dir);
    const chunks = rec.steps[0]!.response!.chunks;
    expect(chunks.length).toBeGreaterThan(1);

    const replayed = await replay('sse', () => readSse('/sse'), { dir });
    expect(replayed.text).toBe(recorded.text);
    expect(replayed.chunks).toBe(chunks.length);
  });

  it('reproduces original chunk timing when asked', async () => {
    await record('timing', () => readSse('/sse'), { dir });
    const t0 = performance.now();
    await replay('timing', () => readSse('/sse'), { dir, timing: 'original' });
    const original = performance.now() - t0;
    const t1 = performance.now();
    await replay('timing', () => readSse('/sse'), { dir });
    const instant = performance.now() - t1;
    expect(original).toBeGreaterThan(40);
    expect(instant).toBeLessThan(original);
  });

  it('records the body even when the caller never reads it', async () => {
    await record('unread', async () => {
      await fetch(base + '/sse');
    }, { dir });
    const rec = await load('unread', dir);
    expect(rec.steps[0]!.response!.truncated).toBeUndefined();
    const text = await replay('unread', () => fetch(base + '/sse').then((r) => r.text()), { dir });
    expect(text).toContain('[DONE]');
  });

  it('handles null-body and binary responses', async () => {
    const run = async () => {
      const empty = await fetch(base + '/empty');
      const bin = new Uint8Array(await (await fetch(base + '/binary')).arrayBuffer());
      return { status: empty.status, body: await empty.text(), bin: [...bin] };
    };
    const recorded = await record('misc', run, { dir });
    expect(await replay('misc', run, { dir })).toEqual(recorded);
    const rec = await load('misc', dir);
    expect(Object.values(rec.blobs).some((b) => 'base64' in b)).toBe(true);
  });

  it('replays network errors as fetch errors', async () => {
    const run = () => fetch('http://127.0.0.1:1/nothing-listens-here');
    await expect(record('neterr', run, { dir })).rejects.toThrow(TypeError);
    await expect(replay('neterr', run, { dir })).rejects.toThrow(/fetch failed/);
  });

  it('saves the recording when the run throws', async () => {
    await expect(
      record('failed', async () => {
        await getJson('/count');
        throw new Error('agent crashed at step 2');
      }, { dir }),
    ).rejects.toThrow('agent crashed');
    expect((await load('failed', dir)).steps).toHaveLength(1);
  });

  it('passes fetch straight through when no session is active', async () => {
    const a = await getJson('/count');
    const b = await getJson('/count');
    expect(b.n).toBe(a.n + 1);
  });

  it('dedupes identical bodies in storage', async () => {
    await record('dedupe', async () => {
      for (let i = 0; i < 3; i++) await postJson('/echo', { prompt: 'same long prompt '.repeat(50) });
    }, { dir });
    const rec = await load('dedupe', dir);
    const requestBodies = new Set(rec.steps.map((s) => s.request.body));
    expect(requestBodies.size).toBe(1);
  });
});

describe('matching', () => {
  it('ignores JSON key order and query param order', async () => {
    await record('order', async () => {
      await postJson('/echo', { a: 1, b: { c: 2, d: 3 } });
      await getJson('/count?x=1&y=2');
    }, { dir });
    await replay('order', async () => {
      await postJson('/echo', { b: { d: 3, c: 2 }, a: 1 });
      await getJson('/count?y=2&x=1');
    }, { dir });
  });

  it('reports the first body difference when a run diverges', async () => {
    await record('diverge', () => postJson('/echo', { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }), { dir });
    const err = await replay('diverge', () => postJson('/echo', { model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }), { dir }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReplayDivergenceError);
    const e = err as ReplayDivergenceError;
    expect(e.bodyDiffPath).toBe('$.messages[0].content');
    expect(e.message).toContain('recorded: "hi"');
    expect(e.message).toContain('now:      "hello"');
  });

  it('still fails when the run swallows the divergence (SDK retries)', async () => {
    await record('swallow', () => getJson('/count'), { dir });
    const run = async () => {
      await getJson('/count');
      try {
        await getJson('/count'); // one call more than recorded
      } catch {
        /* swallowed, like a retrying SDK would */
      }
      return 'ok';
    };
    await expect(replay('swallow', run, { dir })).rejects.toThrow(/more calls than the recorded one/);
  });

  it('strict mode flags unused recorded steps', async () => {
    await record('strict', async () => {
      await getJson('/count');
      await getJson('/count?page=2');
    }, { dir });
    await expect(replay('strict', () => getJson('/count'), { dir, strict: true })).rejects.toBeInstanceOf(UnusedStepsError);
    await replay('strict', () => getJson('/count'), { dir });
  });

  it('redactBody can strip values that change every run', async () => {
    const opts = { dir, redactBody: (t: string) => t.replace(/"ts":\d+/, '"ts":0') };
    await record('volatile', () => postJson('/echo', { ts: 1000, q: 'x' }), opts);
    await replay('volatile', () => postJson('/echo', { ts: 2000, q: 'x' }), opts);
  });

  it('passthrough sends chosen requests to the network', async () => {
    await record('pass', () => getJson('/count'), { dir });
    const before = counter;
    await replay('pass', async () => {
      await getJson('/count');
      await getJson('/echo');
    }, { dir, passthrough: (u) => u.pathname === '/echo' });
    expect(counter).toBe(before + 1);
  });
});

describe('redaction', () => {
  it('never writes credentials to disk', async () => {
    const key = 'sk-ant-api03-' + 'A'.repeat(40);
    await record('secrets', async () => {
      await fetch(`${base}/echo?key=AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY12&model=x`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: key, prompt: 'hi' }),
      }).then((r) => r.json());
    }, { dir });
    const file = await readFile(recordingPath('secrets', dir), 'utf8');
    expect(file).not.toContain(key);
    expect(file).not.toContain('AIzaSy');
    expect(file).not.toContain('supersecret');
    expect(file).toContain('[REDACTED]');

    // Replay still matches, because the live request is redacted the same way.
    await replay('secrets', () =>
      fetch(`${base}/echo?key=different-key&model=x`, {
        method: 'POST',
        headers: { authorization: 'Bearer other', 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'sk-ant-api03-' + 'B'.repeat(40), prompt: 'hi' }),
      }).then((r) => r.json()),
    { dir });
  });
});

describe('auto mode', () => {
  it('records on first run and replays afterwards', async () => {
    const first = await auto('auto', () => getJson('/count'), { dir });
    const before = counter;
    expect(await auto('auto', () => getJson('/count'), { dir })).toEqual(first);
    expect(counter).toBe(before);
  });

  it('REWIND_MODE=record forces a fresh recording', async () => {
    const first = await auto('refresh', () => getJson('/count'), { dir });
    process.env.REWIND_MODE = 'record';
    const second = await auto('refresh', () => getJson('/count'), { dir });
    expect(second.n).toBeGreaterThan(first.n);
  });

  it('refuses nested sessions', async () => {
    await expect(record('outer', () => record('inner', () => 1, { dir }), { dir })).rejects.toThrow(/cannot be nested/);
  });
});
