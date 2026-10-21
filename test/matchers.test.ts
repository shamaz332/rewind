import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capture, load, record, recordingPath, replay, RecordingNotFoundError, ReplayDivergenceError } from '../src/index.js';
import { testRecordingTarget } from '../src/matchers.js';
import { recordTest } from '../src/vitest.js';

let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  // A fake Anthropic-style model that calls tools based on the prompt, and a flaky endpoint.
  server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/broken') return res.writeHead(503).end('{"error":"overloaded"}');
    const { messages } = JSON.parse(body);
    const prompt: string = messages.at(-1).content;
    const tools = [...prompt.matchAll(/call:(\w+)/g)].map((m) => m[1]);
    res.end(
      JSON.stringify({
        type: 'message',
        model: 'm-1',
        content: [{ type: 'text', text: 'ok' }, ...tools.map((name) => ({ type: 'tool_use', id: 't', name, input: {} }))],
        usage: { input_tokens: prompt.length, output_tokens: 10, cache_read_input_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rewind-match-'));
  delete process.env.REWIND_MODE;
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const ask = (content: string) =>
  fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm-1', messages: [{ role: 'user', content }] }) }).then((r) => r.json());

/** Prompt lengths are the input token counts: (20 + 5 cached) + (32 + 5 cached) = 62 in, 20 out. */
const agent = async () => {
  await ask('call:search_flights.'.padEnd(20, ' '));
  await ask('call:book_flight call:send_email');
  return 'booked';
};

describe('matchers', () => {
  it('toHaveCalledTool / toCallToolsInOrder', async () => {
    const run = await capture('tools', agent, { dir });
    expect(run).toHaveCalledTool('book_flight');
    expect(run).not.toHaveCalledTool('cancel_flight');
    expect(run).toCallToolsInOrder(['search_flights', 'send_email']);
    expect(run).not.toCallToolsInOrder(['send_email', 'search_flights']);
    expect(() => expect(run).toHaveCalledTool('refund')).toThrow(/tools called: search_flights, book_flight, send_email/);
    expect(() => expect(run).toCallToolsInOrder(['search_flights', 'refund'])).toThrow(/matched the first 1, then "refund" never came/);
  });

  it('toStayWithinTokens counts cached input and names the largest calls', async () => {
    const run = await capture('tokens', agent, { dir });
    expect(run).toStayWithinTokens(82); // 62 in + 20 out
    expect(run).toStayWithinTokens(62, { count: 'input' });
    expect(run).toStayWithinTokens(20, { count: 'output' });
    expect(() => expect(run).toStayWithinTokens(81)).toThrow(/at most 81 tokens, but it used 82 \(62 in \/ 20 out across 2 LLM calls\)\nlargest calls: #1 \(47\), #0 \(35\)/);
  });

  it('toHaveLLMCalls accepts an exact count or a range', async () => {
    const run = await capture('calls', agent, { dir });
    expect(run).toHaveLLMCalls(2);
    expect(run).toHaveLLMCalls({ max: 3 });
    expect(run).toHaveLLMCalls({ min: 1, max: 2 });
    expect(() => expect(run).toHaveLLMCalls({ max: 1 })).toThrow('expected at most 1 LLM calls, but the run made 2');
  });

  it('toHaveNoFailedRequests lists failures', async () => {
    const ok = await capture('ok', agent, { dir });
    expect(ok).toHaveNoFailedRequests();
    const bad = await capture('bad', () => fetch(`${base}/broken`).then((r) => r.status), { dir });
    expect(() => expect(bad).toHaveNoFailedRequests()).toThrow(/#0 GET .*\/broken → 503/);
  });

  it('accepts a Recording as well as a Run', async () => {
    await record('raw', agent, { dir });
    expect(await load('raw', dir)).toHaveCalledTool('search_flights');
    expect(() => expect({ nope: true }).toHaveCalledTool('x')).toThrow(/expected a rewind Run/);
  });
});

describe('capture', () => {
  it('records first, replays after, and returns the recording', async () => {
    const first = await capture('cap', agent, { dir });
    expect(first.mode).toBe('record');
    const second = await capture('cap', agent, { dir });
    expect(second.mode).toBe('replay');
    expect(second.recording.steps).toHaveLength(2);
  });

  it('refuses to record live in CI unless REWIND_MODE=record', async () => {
    const prev = process.env.CI;
    process.env.CI = 'true';
    try {
      await expect(capture('ci-missing', agent, { dir })).rejects.toBeInstanceOf(RecordingNotFoundError);
      process.env.REWIND_MODE = 'record';
      expect((await capture('ci-missing', agent, { dir })).mode).toBe('record');
    } finally {
      if (prev === undefined) delete process.env.CI;
      else process.env.CI = prev;
    }
  });
});

describe('recordTest', () => {
  it('names recordings after the test and stores them next to the test file', () => {
    const t = testRecordingTarget({ currentTestName: 'checkout > books the cheapest flight', testPath: '/repo/test/agent.test.ts' });
    expect(t).toEqual({ name: 'checkout-books-the-cheapest-flight', dir: '/repo/test/__recordings__/agent.test.ts' });
    // A second capture in the same test gets a suffix.
    expect(testRecordingTarget({ currentTestName: 'checkout > books the cheapest flight', testPath: '/repo/test/agent.test.ts' }).name).toBe(
      'checkout-books-the-cheapest-flight-2',
    );
    expect(testRecordingTarget({ currentTestName: 'x', testPath: '/r/a.test.ts' }, { name: 'custom', dir: '/d' })).toEqual({ name: 'custom', dir: '/d' });
    expect(() => testRecordingTarget({})).toThrow(/inside a running test/);
  });

  it('records and replays a real test', async () => {
    const target = join(__dirname, '__recordings__', 'matchers.test.ts');
    try {
      const first = await recordTest(agent);
      const second = await recordTest(agent, { name: first.recording.name });
      expect(second.mode).toBe('replay');
      expect(second).toHaveLLMCalls(2);
      expect(await readdir(target)).toContain('recordTest-records-and-replays-a-real-test.rewind.json');
    } finally {
      await rm(join(__dirname, '__recordings__'), { recursive: true, force: true });
    }
  });
});

describe('failed replays', () => {
  it('saves what the run did as <name>.failed and removes it once the replay passes', async () => {
    await record('flow', agent, { dir });
    const changed = async () => {
      await ask('call:search_flights.'.padEnd(20, ' '));
      await ask('call:refund'.padEnd(30, ' '));
    };
    await expect(replay('flow', changed, { dir })).rejects.toBeInstanceOf(ReplayDivergenceError);

    const failed = await load('flow.failed', dir);
    expect(failed.failure).toMatchObject({ from: 'flow', step: 1 });
    expect(failed.failure!.message).toContain('First difference at $.messages[0].content');
    expect(failed.steps).toHaveLength(2);
    expect(failed.steps[0]!.response?.status).toBe(200); // served from the recording
    expect(failed.steps[1]!.error?.name).toBe('ReplayDivergenceError'); // the request that diverged

    await replay('flow', agent, { dir });
    expect(existsSync(recordingPath('flow.failed', dir))).toBe(false);
  });

  it('can be switched off', async () => {
    await record('quiet', agent, { dir });
    await expect(replay('quiet', () => ask('different'), { dir, saveFailures: false })).rejects.toThrow();
    expect(existsSync(recordingPath('quiet.failed', dir))).toBe(false);
  });
});
