import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, utimes, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main, parseDuration } from '../src/cli/main.js';
import { diffRecordings } from '../src/diff.js';
import { align } from '../src/diff.js';
import { extractText, extractUsage, parsePayloads } from '../src/llm.js';
import { fork, load, record, recordingPath } from '../src/index.js';

// ─── LLM payload parsing ─────────────────────────────────────────────────────

describe('llm parsing', () => {
  it('reads Anthropic messages', () => {
    const p = parsePayloads(
      JSON.stringify({
        type: 'message',
        model: 'claude-x',
        content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', name: 'search', input: {} }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      }),
    );
    expect(extractUsage(p)).toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20 });
    expect(extractText(p)).toBe('Hi[tool: search]');
  });

  it('reads Anthropic streams', () => {
    const sse = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 42, output_tokens: 1 } } })}`,
      '',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } })}`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } })}`,
      `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'book' } })}`,
      `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 17 } })}`,
      '',
    ].join('\n');
    const p = parsePayloads(sse);
    expect(extractUsage(p)).toEqual({ input: 42, output: 17, cacheRead: 0, cacheWrite: 0 });
    expect(extractText(p)).toBe('Hello[tool: book]');
  });

  it('reads OpenAI chat completions, normalizing cached tokens out of input', () => {
    const p = parsePayloads(
      JSON.stringify({
        object: 'chat.completion',
        choices: [{ message: { content: 'Sure', tool_calls: [{ function: { name: 'lookup' } }] } }],
        usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
      }),
    );
    expect(extractUsage(p)).toEqual({ input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
    expect(extractText(p)).toBe('Sure[tool: lookup]');
  });

  it('reads OpenAI chat streams with a usage chunk', () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'B' } }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}`,
      'data: [DONE]',
    ].join('\n\n');
    const p = parsePayloads(sse);
    expect(extractText(p)).toBe('AB');
    expect(extractUsage(p)).toMatchObject({ input: 9, output: 2 });
  });

  it('reads the OpenAI Responses API, JSON and streamed', () => {
    const json = parsePayloads(
      JSON.stringify({
        object: 'response',
        output: [{ type: 'function_call', name: 'f' }, { type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
        usage: { input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 10 } },
      }),
    );
    expect(extractText(json)).toBe('[tool: f]Done');
    expect(extractUsage(json)).toEqual({ input: 20, output: 4, cacheRead: 10, cacheWrite: 0 });

    const sse = parsePayloads(
      [
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hi ' })}`,
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'there' })}`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } })}`,
      ].join('\n\n'),
    );
    expect(extractText(sse)).toBe('Hi there');
    expect(extractUsage(sse)).toMatchObject({ input: 5, output: 2 });
  });

  it('reads Gemini', () => {
    const p = parsePayloads(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Bonjour' }, { functionCall: { name: 'translate' } }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
      }),
    );
    expect(extractText(p)).toBe('Bonjour[tool: translate]');
    expect(extractUsage(p)).toMatchObject({ input: 12, output: 3 });
  });

  it('returns null for non-LLM traffic', () => {
    const p = parsePayloads('{"weather":"sunny"}');
    expect(extractUsage(p)).toBeNull();
    expect(extractText(p)).toBeNull();
  });
});

describe('align', () => {
  it('pairs common steps and isolates insertions and deletions', () => {
    expect(align(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd'])).toEqual([
      [0, 0],
      [1, null],
      [2, 1],
      [null, 2],
      [3, 3],
    ]);
  });
});

describe('parseDuration', () => {
  it('parses units', () => {
    expect(parseDuration('30d')).toBe(30 * 86_400_000);
    expect(parseDuration('12h')).toBe(12 * 3_600_000);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
  });
});

// ─── CLI against real recordings ─────────────────────────────────────────────

let server: Server;
let base: string;
let dir: string;
let calls = 0;

beforeAll(async () => {
  // Fake Anthropic-style model: answers depend on the system prompt.
  server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/tool') return res.end(JSON.stringify({ temp: 20 + (++calls % 3) }));
    const { system, model } = JSON.parse(body);
    calls++;
    res.end(
      JSON.stringify({
        type: 'message',
        model,
        content: [{ type: 'text', text: system === 'v2' ? 'Bring a light jacket.' : 'Wear shorts.' }],
        usage: { input_tokens: system.length * 10, output_tokens: 7 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rewind-cli-'));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const ask = (system: string) =>
  fetch(`${base}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-test', system, messages: [{ role: 'user', content: 'hi' }] }) }).then((r) =>
    r.json(),
  );
const tool = () => fetch(`${base}/tool`).then((r) => r.json());
const agent = (system: string, extraCall = false) => async () => {
  await ask(system);
  await tool();
  if (extraCall) await tool();
  return ask(system);
};

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--dir', dir], { out: (l) => out.push(l), err: (l) => err.push(l), color: false, width: 140 });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cli', () => {
  it('ls lists recordings, newest first, with forks marked', async () => {
    await record('weather', agent('v1'), { dir });
    await fork('weather', agent('v2'), { dir, at: 2 });
    const { code, out } = await cli('ls');
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/NAME\s+STEPS\s+LLM\s+TOKENS/);
    expect(lines[1]).toMatch(/^weather\.fork-2\s+3\s+2 .*fork of weather @2/);
    expect(lines[2]).toMatch(/^weather\s+3\s+2/);
  });

  it('ls --json is machine readable', async () => {
    await record('weather', agent('v1'), { dir });
    const rows = JSON.parse((await cli('ls', '--json')).out);
    expect(rows[0]).toMatchObject({ name: 'weather', totals: { steps: 3, llmCalls: 2 } });
  });

  it('show prints a timeline with model, tokens and output', async () => {
    await record('weather', agent('v1'), { dir });
    const { out } = await cli('show', 'weather');
    expect(out).toMatch(/weather\s+· 3 steps · 2 LLM calls · 40 in \/ 14 out tokens/);
    expect(out).toMatch(/0\s+POST\s+127\.0\.0\.1:\d+\/v1\/messages\s+200\s+\d+ ms\s+claude-test\s+20 in \/ 7 out\s+Wear shorts\./);
    expect(out).toMatch(/1\s+GET\s+127\.0\.0\.1:\d+\/tool\s+200/);
  });

  it('show --step prints request, output and response', async () => {
    await record('weather', agent('v1'), { dir });
    const { out } = await cli('show', 'weather', '--step', '2', '--headers');
    expect(out).toContain('#2 POST');
    expect(out).toContain('model claude-test · 20 in / 7 out');
    expect(out).toContain('Request headers');
    expect(out).toContain('"system": "v1"');
    expect(out).toContain('Model output\n  Wear shorts.');
  });

  it('show accepts a file path', async () => {
    await record('weather', agent('v1'), { dir });
    const out: string[] = [];
    const code = await main(['show', recordingPath('weather', dir)], { out: (l) => out.push(l), err: () => {}, color: false, width: 120 });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^weather/);
  });

  it('diff shows what changed and what it did to the output', async () => {
    await record('weather', agent('v1'), { dir });
    await fork('weather', agent('v2'), { dir, at: 2, saveAs: 'weather-v2' });
    const { code, out } = await cli('diff', 'weather', 'weather-v2');
    expect(code).toBe(0);
    expect(out).toMatch(/#0\s+#0\s+~\s+POST/);
    expect(out).toContain('request  $.system: "v1" → "v2"');
    expect(out).toMatch(/#1\s+#1\s+=\s+GET/);
    expect(out).toContain('output   Wear shorts.');
    expect(out).toContain('Bring a light jacket.');
    expect(out).toContain('First divergence at a#0 / b#0');
    expect(out).toContain('1 same · 2 changed · 0 added · 0 removed');
  });

  it('diff aligns runs with an extra step', async () => {
    await record('short', agent('v1'), { dir });
    await record('long', agent('v1', true), { dir });
    const { out } = await cli('diff', 'short', 'long');
    expect(out).toMatch(/-?\s+#2\s+\+\s+GET .*\/tool/);
    expect(out).toMatch(/\d+ added/);
  });

  it('diff --exit-code fails only when runs differ', async () => {
    await record('weather', agent('v1'), { dir });
    expect((await cli('diff', 'weather', 'weather', '--exit-code')).code).toBe(0);
    expect((await cli('diff', 'weather', 'weather')).out).toContain('Runs are identical.');
    await fork('weather', agent('v2'), { dir, at: 2, saveAs: 'other' });
    expect((await cli('diff', 'weather', 'other', '--exit-code')).code).toBe(1);
  });

  it('diff --json exposes the structured diff', async () => {
    await record('weather', agent('v1'), { dir });
    await fork('weather', agent('v2'), { dir, at: 0, saveAs: 'other' });
    const d = JSON.parse((await cli('diff', 'weather', 'other', '--json')).out);
    expect(d.counts.changed).toBeGreaterThan(0);
    expect(d.steps[0].request[0]).toMatchObject({ path: '$.system', left: 'v1', right: 'v2' });
  });

  it('shows costs only when pricing is provided', async () => {
    await record('weather', agent('v1'), { dir });
    expect((await cli('show', 'weather')).out).not.toContain('$');
    await writeFile(join(dir, 'pricing.json'), JSON.stringify({ 'claude-': { input: 1000, output: 2000 } }));
    // 40 input tokens * $1000/M + 14 output * $2000/M = $0.068
    expect((await cli('show', 'weather')).out).toContain('$0.07');
  });

  it('prune deletes only old recordings, and --dry-run deletes nothing', async () => {
    await record('old', agent('v1'), { dir });
    await record('new', agent('v1'), { dir });
    const oldPath = recordingPath('old', dir);
    const rec = JSON.parse(await readFile(oldPath, 'utf8'));
    rec.createdAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await writeFile(oldPath, JSON.stringify(rec));
    await utimes(oldPath, new Date(), new Date());

    const dry = await cli('prune', '--older-than', '30d', '--dry-run');
    expect(dry.out).toContain('would delete');
    expect(existsSync(oldPath)).toBe(true);

    await cli('prune', '--older-than', '30d');
    expect(existsSync(oldPath)).toBe(false);
    await load('new', dir);
  });

  it('reports usage errors with exit code 2', async () => {
    expect((await cli('show')).code).toBe(2);
    expect((await cli('frobnicate')).code).toBe(2);
    expect((await cli('prune')).err).toContain('--older-than');
    expect((await cli('show', 'missing')).code).toBe(1);
  });

  it('diffRecordings is usable as a library', async () => {
    await record('weather', agent('v1'), { dir });
    const rec = await load('weather', dir);
    expect(diffRecordings(rec, rec).firstDivergence).toBeNull();
  });
});
