import { randomUUID as importedUUID } from 'node:crypto';
import http, { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { load, record, replay } from '../src/index.js';

let server: Server;
let base: string;
let counter = 0;
let dir: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const path = new URL(req.url!, 'http://x').pathname;
    if (path === '/count') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ n: ++counter }));
    } else if (path === '/echo') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ got: body ? JSON.parse(body) : null, n: ++counter }));
    } else if (path === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of ['one', 'two', 'three']) {
        res.write(`data: ${w}\n\n`);
        await new Promise((r) => setTimeout(r, 15));
      }
      res.end();
    } else if (path === '/redirect') {
      res.writeHead(302, { location: '/count' }).end();
    } else if (path === '/gz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync(`compressed #${++counter}`));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rewind-p2-'));
  delete process.env.REWIND_MODE;
});

afterEach(() => rm(dir, { recursive: true, force: true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJson = async (path: string, init?: RequestInit): Promise<any> => (await fetch(base + path, init)).json();
const postJson = (path: string, body: unknown) =>
  getJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  chunks: number;
}

/** A plain node:http client, the way axios/got/older SDKs talk to the network. Decodes gzip itself. */
function httpRequest(path: string, opts: { method?: string; body?: string } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: opts.method ?? 'GET', headers: { 'content-type': 'application/json' } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('error', reject);
      res.on('end', () => {
        let buf = Buffer.concat(parts);
        if (res.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf);
        resolve({ status: res.statusCode!, headers: res.headers, text: buf.toString(), chunks: parts.length });
      });
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('determinism', () => {
  it('replays clock, randomness and UUIDs exactly', async () => {
    const run = async () => {
      const a = { now: Date.now(), iso: new Date().toISOString(), rand: Math.random(), web: crypto.randomUUID(), node: importedUUID() };
      await getJson('/count');
      return { ...a, later: Date.now(), dateFn: Date(), rand2: Math.random() };
    };
    const recorded = await record('determinism', run, { dir });
    await new Promise((r) => setTimeout(r, 20));
    expect(await replay('determinism', run, { dir })).toEqual(recorded);
  });

  it('lets UUIDs and timestamps inside request bodies match on replay', async () => {
    const run = () => postJson('/echo', { idempotencyKey: crypto.randomUUID(), sentAt: new Date().toISOString(), nonce: Math.random() });
    const recorded = await record('ids-in-body', run, { dir });
    await new Promise((r) => setTimeout(r, 5));
    expect(await replay('ids-in-body', run, { dir })).toEqual(recorded);
  });

  it('leaves Date, Math.random and UUIDs untouched outside sessions', () => {
    expect(Math.abs(Date.now() - performance.timeOrigin - performance.now())).toBeLessThan(1000);
    expect(new Date(0).getTime()).toBe(0);
    expect(new Date(2020, 0, 1).getFullYear()).toBe(2020);
    expect(new Date()).toBeInstanceOf(Date);
    expect(new Date().constructor).toBe(Date);
    expect(typeof Date()).toBe('string');
    expect(Date.UTC(2000, 0, 1)).toBe(946684800000);
    class MyDate extends Date {}
    expect(new MyDate(5).getTime()).toBe(5);
    expect(Math.random()).not.toBe(Math.random());
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps time moving once recorded clock values run out', async () => {
    const recorded = await record('clock-overflow', () => Date.now(), { dir });
    const values = await replay('clock-overflow', async () => {
      const a = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      return [a, Date.now(), Date.now()];
    }, { dir });
    expect(values[0]).toBe(recorded);
    expect(values[1]!).toBeGreaterThanOrEqual(recorded + 10);
    expect(values[2]!).toBeGreaterThanOrEqual(values[1]!);
  });

  it('can be switched off', async () => {
    await record('nondeterministic', () => Math.random(), { dir, deterministic: false });
    const rec = await load('nondeterministic', dir);
    expect(rec.determinism).toEqual({ seed: null, clock: null, uuids: null });
    const a = await replay('nondeterministic', () => Math.random(), { dir });
    const b = await replay('nondeterministic', () => Math.random(), { dir });
    expect(a).not.toBe(b);
  });

  it('can control sources individually', async () => {
    await record('partial', () => [Date.now(), Math.random()], { dir, deterministic: { clock: false } });
    const rec = await load('partial', dir);
    expect(rec.determinism.clock).toBeNull();
    expect(rec.determinism.seed).not.toBeNull();
  });

  it('does not record clock reads from outside the session context', async () => {
    const gate = deferred();
    const outside = gate.promise.then(() => Date.now()); // continuation belongs to the outer context
    await record('outside-clock', async () => {
      Date.now();
      gate.resolve();
      await outside;
      Date.now();
    }, { dir });
    expect((await load('outside-clock', dir)).determinism.clock!.deltas).toHaveLength(2);
  });
});

describe('concurrent sessions', () => {
  it('keeps parallel recordings separate', async () => {
    const run = (tag: string) => async () => {
      const out = [];
      for (let i = 0; i < 3; i++) {
        out.push(await postJson('/echo', { tag, i, id: crypto.randomUUID() }));
        await new Promise((r) => setTimeout(r, Math.random() * 5));
      }
      return out;
    };
    const [a, b] = await Promise.all([record('par-a', run('a'), { dir }), record('par-b', run('b'), { dir })]);
    const [recA, recB] = await Promise.all([load('par-a', dir), load('par-b', dir)]);
    expect(recA.steps).toHaveLength(3);
    expect(recB.steps).toHaveLength(3);
    expect(recA.determinism.uuids).not.toEqual(recB.determinism.uuids);

    const before = counter;
    const [ra, rb] = await Promise.all([replay('par-a', run('a'), { dir }), replay('par-b', run('b'), { dir })]);
    expect(ra).toEqual(a);
    expect(rb).toEqual(b);
    expect(counter).toBe(before);
  });

  it('refuses requests it cannot attribute when several sessions are active', async () => {
    const gate = deferred();
    const orphan = gate.promise.then(() => fetch(base + '/count'));
    const bothStarted = deferred();
    let started = 0;
    const session = (name: string) =>
      record(name, async () => {
        if (++started === 2) bothStarted.resolve();
        await bothStarted.promise;
        gate.resolve();
        await orphan.catch(() => {});
      }, { dir });
    await Promise.all([session('amb-a'), session('amb-b')]);
    await expect(orphan).rejects.toThrow(/outside any rewind session's async context/);
  });

  it('attributes context-less requests to the only active session', async () => {
    const gate = deferred();
    const orphan = gate.promise.then(() => getJson('/count'));
    await record('fallback', async () => {
      gate.resolve();
      return orphan;
    }, { dir });
    expect((await load('fallback', dir)).steps).toHaveLength(1);
  });
});

describe('node:http', () => {
  it('records and replays plain http requests', async () => {
    const run = async () => [await httpRequest('/count'), await httpRequest('/echo', { method: 'POST', body: '{"q":1}' })];
    const recorded = await record('http-basic', run, { dir });
    const before = counter;
    const replayed = await replay('http-basic', run, { dir });
    expect(replayed.map((r) => [r.status, r.text])).toEqual(recorded.map((r) => [r.status, r.text]));
    expect(counter).toBe(before);
    expect((await load('http-basic', dir)).steps.map((s) => s.via)).toEqual(['node:http', 'node:http']);
  });

  it('streams responses chunk by chunk', async () => {
    const recorded = await record('http-sse', () => httpRequest('/sse'), { dir });
    const replayed = await replay('http-sse', () => httpRequest('/sse'), { dir });
    expect(replayed.text).toBe(recorded.text);
    expect(replayed.text).toContain('data: three');
    expect((await load('http-sse', dir)).steps[0]!.response!.chunks.length).toBeGreaterThan(1);
  });

  it('does not follow redirects for http clients', async () => {
    const recorded = await record('http-redirect', () => httpRequest('/redirect'), { dir });
    expect(recorded.status).toBe(302);
    expect(recorded.headers.location).toBe('/count');
    const replayed = await replay('http-redirect', () => httpRequest('/redirect'), { dir });
    expect(replayed.status).toBe(302);
  });

  it('hands http clients a body they can read when the server compressed it', async () => {
    const recorded = await record('http-gzip', () => httpRequest('/gz'), { dir });
    expect(recorded.text).toMatch(/^compressed #\d+$/);
    const replayed = await replay('http-gzip', () => httpRequest('/gz'), { dir });
    expect(replayed.text).toBe(recorded.text);
  });

  it('replays a fetch recording through node:http and back', async () => {
    const recorded = await record('cross', () => getJson('/count'), { dir });
    const viaHttp = await replay('cross', () => httpRequest('/count'), { dir });
    expect(JSON.parse(viaHttp.text)).toEqual(recorded);
  });

  it('surfaces divergence as a request error', async () => {
    await record('http-diverge', () => httpRequest('/echo', { method: 'POST', body: '{"q":1}' }), { dir });
    await expect(
      replay('http-diverge', () => httpRequest('/echo', { method: 'POST', body: '{"q":2}' }), { dir }),
    ).rejects.toThrow(/First difference at \$\.q/);
  });

  it('passes http straight through when no session is active', async () => {
    const a = JSON.parse((await httpRequest('/count')).text);
    const b = JSON.parse((await httpRequest('/count')).text);
    expect(b.n).toBe(a.n + 1);
  });
});
