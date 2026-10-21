import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fork, load, record } from '../src/index.js';
import { startUi, type UiServer } from '../src/ui/server.js';

let model: Server;
let base: string;
let dir: string;
let ui: UiServer;
let calls = 0;
const TOKEN = 'test-token';

beforeAll(async () => {
  model = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls++;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/tool') return res.end(JSON.stringify({ items: calls }));
    const { system, model: m } = JSON.parse(body);
    res.end(JSON.stringify({ type: 'message', model: m, content: [{ type: 'text', text: `[${system}] answer` }], usage: { input_tokens: 10, output_tokens: 3 } }));
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => model.close(() => r())));

const ask = (system: string) =>
  fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm-1', system, messages: [] }) }).then((r) => r.json());
const agent = async () => {
  await ask('v1');
  await fetch(`${base}/tool`).then((r) => r.json());
  return ask('v1');
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rewind-ui-'));
  ui = await startUi({
    dir,
    port: 0,
    token: TOKEN,
    agents: { 'weather*': agent },
    loadFork: async () => fork,
  });
});

afterEach(async () => {
  await ui.close();
  await rm(dir, { recursive: true, force: true });
});

const origin = () => new URL(ui.url).origin;
const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin()}/api/${path}`, {
    ...init,
    headers: { 'x-rewind-token': TOKEN, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as object) },
  });
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe('rewind ui server', () => {
  it('serves the app with a strict content security policy', async () => {
    const res = await fetch(origin() + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await res.text()).toContain('<title>rewind</title>');
    expect(ui.url).toContain(`token=${TOKEN}`);
  });

  it('requires the launch token for every API call', async () => {
    expect((await fetch(`${origin()}/api/recordings`)).status).toBe(401);
    expect((await fetch(`${origin()}/api/recordings`, { headers: { 'x-rewind-token': 'nope' } })).status).toBe(401);
    expect((await api('recordings')).status).toBe(200);
  });

  it('rejects requests whose Host is not this machine (DNS rebinding)', async () => {
    const port = new URL(ui.url).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/recordings', headers: { host: 'evil.example:' + port, 'x-rewind-token': TOKEN } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('lists recordings and marks which ones can be forked', async () => {
    await record('weather', agent, { dir });
    await record('other', agent, { dir });
    const { body } = await api('recordings');
    expect(body.map((r: { name: string }) => r.name).sort()).toEqual(['other', 'weather']);
    expect(body.find((r: { name: string }) => r.name === 'weather').runnable).toBe(true);
    expect(body.find((r: { name: string }) => r.name === 'other').runnable).toBe(false);
  });

  it('returns a recording with bodies, headers and LLM details', async () => {
    await record('weather', agent, { dir });
    const { status, body } = await api('recordings/weather');
    expect(status).toBe(200);
    expect(body.steps).toHaveLength(3);
    expect(body.steps[0]).toMatchObject({ model: 'm-1', output: '[v1] answer', requestBody: { system: 'v1' } });
    expect(body.steps[0].requestHeaders).toBeTypeOf('object');
    expect(body.runnable).toBe(true);
    expect((await api('recordings/missing')).status).toBe(404);
  });

  it('diffs two recordings', async () => {
    await record('weather', agent, { dir });
    await fork('weather', async () => {
      await ask('v2');
      await fetch(`${base}/tool`).then((r) => r.json());
      return ask('v2');
    }, { dir, at: 2, saveAs: 'weather-v2' });
    const { body } = await api('diff?a=weather&b=weather-v2');
    expect(body.counts).toMatchObject({ same: 1, changed: 2 });
    expect(body.steps[0].request[0]).toMatchObject({ path: '$.system', left: 'v1', right: 'v2' });
  });

  it('forks from a step, applying an edited request body', async () => {
    await record('weather', agent, { dir });
    const before = calls;
    const edited = JSON.stringify({ model: 'm-1', system: 'edited in the browser', messages: [] });
    const { status, body } = await api('fork', { method: 'POST', body: JSON.stringify({ name: 'weather', at: 2, body: edited }) });
    expect(status).toBe(200);
    expect(body).toMatchObject({ replayed: 2, live: 1, liveFrom: 2, reason: 'at' });
    expect(body.value.content[0].text).toBe('[edited in the browser] answer');
    expect(calls).toBe(before + 1);

    const forked = await load(body.savedAs, dir);
    expect(forked.fork).toMatchObject({ from: 'weather', at: 2 });
    expect(forked.steps[2]!.patched).toBe(true);
    expect(forked.steps[2]!.sentBody).toBeTruthy();

    // The diff shows the edit itself, not just its effect on the output.
    const d = (await api(`diff?a=weather&b=${encodeURIComponent(body.savedAs)}`)).body;
    expect(d.steps[2].kind).toBe('changed');
    expect(d.steps[2].request[0]).toMatchObject({ path: '$.system', left: 'v1', right: 'edited in the browser' });
  });

  it('forks a fork, finding the agent through the original recording', async () => {
    await record('weather', agent, { dir });
    const first = await api('fork', { method: 'POST', body: JSON.stringify({ name: 'weather', at: 1 }) });
    const second = await api('fork', { method: 'POST', body: JSON.stringify({ name: first.body.savedAs, at: 2 }) });
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(2);
  });

  it('refuses to fork without a configured agent, or with bad input', async () => {
    await record('other', agent, { dir });
    expect((await api('fork', { method: 'POST', body: JSON.stringify({ name: 'other', at: 1 }) })).status).toBe(409);
    expect((await api('fork', { method: 'POST', body: JSON.stringify({ name: 'other' }) })).status).toBe(400);
    const wrongType = await fetch(`${origin()}/api/fork`, {
      method: 'POST',
      headers: { 'x-rewind-token': TOKEN, 'content-type': 'text/plain' },
      body: '{"name":"other","at":1}',
    });
    expect(wrongType.status).toBe(415);
  });
});
