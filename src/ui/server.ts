import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diffRecordings } from '../diff.js';
import { summarize } from '../inspect.js';
import type { Pricing } from '../llm.js';
import { loadRecording } from '../store.js';
import { FORMAT, type ForkOptions, type ForkResult, type Recording } from '../types.js';

/** Maps recording names to the agent that produced them, so the UI can fork. Keys ending in `*` match by prefix. */
export type AgentMap = Record<string, () => unknown>;

type ForkFn = <T>(name: string, fn: () => T | Promise<T>, opts?: ForkOptions) => Promise<ForkResult<T>>;

export interface UiOptions {
  dir: string;
  port?: number;
  host?: string;
  pricing?: Pricing | null;
  /** Path to a config module exporting `{ agents }`. Default: rewind.config.mjs / .js in the cwd. */
  configPath?: string;
  /** For tests: agents to use instead of loading a config file. */
  agents?: AgentMap;
  /** For tests: where to get `fork` from. Default: the llm-rewind build next to this CLI. */
  loadFork?: () => Promise<ForkFn>;
  /** Fixed token, for tests. Default: random per launch. */
  token?: string;
}

export interface UiServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;

export async function startUi(opts: UiOptions): Promise<UiServer> {
  const dir = resolve(opts.dir);
  const token = opts.token ?? randomBytes(18).toString('base64url');
  const html = await loadAppHtml();
  const config = opts.agents ? { agents: opts.agents, path: null } : await loadConfig(opts.configPath);
  let forking = false;

  const server = createServer(async (req, res) => {
    try {
      // Reject other sites reaching us through DNS rebinding: the Host must be this machine.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 403, { error: 'forbidden host' });

      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
          'referrer-policy': 'no-referrer',
        });
        return res.end(html);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      // The API can run agents (and spend money), so every call needs the launch token.
      if (req.headers['x-rewind-token'] !== token) return send(res, 401, { error: 'missing or invalid token' });

      const route = url.pathname.slice(5);
      if (req.method === 'GET' && route === 'meta') {
        return send(res, 200, {
          dir,
          cwd: process.cwd(),
          config: config.path,
          agents: Object.keys(config.agents),
          pricing: Boolean(opts.pricing),
        });
      }
      if (req.method === 'GET' && route === 'recordings') return send(res, 200, await listRecordings(dir, opts.pricing ?? null, config.agents));
      if (req.method === 'GET' && route.startsWith('recordings/')) {
        const name = decodeURIComponent(route.slice('recordings/'.length));
        const rec = await loadRecording(name, dir);
        return send(res, 200, detail(rec, opts.pricing ?? null, await runnerFor(rec, dir, config.agents) !== null));
      }
      if (req.method === 'GET' && route === 'diff') {
        const a = url.searchParams.get('a');
        const b = url.searchParams.get('b');
        if (!a || !b) return send(res, 400, { error: 'diff needs ?a=&b=' });
        const [ra, rb] = await Promise.all([loadRecording(a, dir), loadRecording(b, dir)]);
        return send(res, 200, diffRecordings(ra, rb, opts.pricing ?? null, 5));
      }
      if (req.method === 'POST' && route === 'fork') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, { error: 'expected JSON' });
        const body = JSON.parse(await readBody(req)) as { name?: string; at?: number; body?: string | null };
        if (!body.name || !Number.isInteger(body.at) || body.at! < 0) return send(res, 400, { error: 'fork needs { name, at }' });
        const rec = await loadRecording(body.name, dir);
        const agent = await runnerFor(rec, dir, config.agents);
        if (!agent) return send(res, 409, { error: `No agent configured for "${body.name}". Add it to rewind.config.mjs.` });
        if (forking) return send(res, 409, { error: 'A fork is already running.' });
        forking = true;
        try {
          const fork = await (opts.loadFork ?? defaultLoadFork)();
          const at = body.at!;
          const edited = body.body;
          const saveAs = `${body.name}.ui-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
          const result = await fork(body.name, agent, {
            dir,
            at,
            saveAs,
            // An edited body replaces the request of the step the fork goes live at; later steps are built by the agent.
            ...(typeof edited === 'string' ? { patchRequest: (_req, ctx) => (ctx.step === at ? parseEdited(edited) : undefined) } : {}),
          });
          const { value, ...rest } = result;
          return send(res, 200, { ...rest, value: safeValue(value) });
        } catch (err) {
          return send(res, 500, { error: (err as Error).message });
        } finally {
          forking = false;
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const e = err as Error;
      return send(res, e.name === 'RecordingNotFoundError' ? 404 : 500, { error: e.message });
    }
  });

  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(opts.port ?? 4242, opts.host ?? '127.0.0.1', () => r());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    token,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections(); // browsers hold keep-alive connections open
      }),
  };
}

// ─── data ────────────────────────────────────────────────────────────────────

async function listRecordings(dir: string, pricing: Pricing | null, agents: AgentMap) {
  const out = [];
  for (const file of await findFiles(dir)) {
    try {
      const rec = JSON.parse(await readFile(file, 'utf8')) as Recording;
      if (rec.format !== FORMAT) continue;
      const s = summarize(rec, pricing);
      out.push({
        name: rec.name,
        createdAt: rec.createdAt,
        bytes: (await stat(file)).size,
        fork: rec.fork ?? null,
        totals: s.totals,
        runnable: (await runnerFor(rec, dir, agents)) !== null,
      });
    } catch {
      /* skip unreadable files */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function detail(rec: Recording, pricing: Pricing | null, runnable: boolean) {
  const s = summarize(rec, pricing);
  const raw = new Map(rec.steps.map((st) => [st.seq, st]));
  return {
    ...s,
    runnable,
    determinism: {
      clockReads: rec.determinism?.clock?.deltas.length ?? null,
      uuids: rec.determinism?.uuids?.length ?? null,
      seeded: rec.determinism?.seed != null,
    },
    steps: s.steps.map((st) => {
      const r = raw.get(st.seq)!;
      return {
        ...st,
        requestBody: cap(st.requestBody),
        responseText: cap(st.responseText),
        requestHeaders: r.request.headers,
        responseHeaders: r.response?.headers ?? null,
        chunks: r.response?.chunks.length ?? 0,
        truncatedReason: r.response?.truncated?.reason ?? null,
      };
    }),
  };
}

function cap(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_BODY) return `${v.slice(0, MAX_BODY)}\n… (truncated by rewind ui)`;
  return v;
}

/** The configured agent for a recording, following fork recordings back to the run they came from. */
async function runnerFor(rec: Recording, dir: string, agents: AgentMap): Promise<(() => unknown) | null> {
  const names = [rec.name];
  let cur: Recording | null = rec;
  for (let i = 0; cur?.fork && i < 20; i++) {
    names.push(cur.fork.from);
    cur = await loadRecording(cur.fork.from, dir).catch(() => null);
  }
  for (const n of names) {
    if (agents[n]) return agents[n]!;
    const prefix = Object.keys(agents)
      .filter((k) => k.endsWith('*') && n.startsWith(k.slice(0, -1)))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) return agents[prefix]!;
  }
  return null;
}

async function findFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.rewind.json')) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

async function loadConfig(path?: string): Promise<{ agents: AgentMap; path: string | null }> {
  const candidates = path ? [resolve(path)] : ['rewind.config.mjs', 'rewind.config.js'].map((p) => resolve(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    if (path) throw new Error(`config file ${path} not found`);
    return { agents: {}, path: null };
  }
  const mod = (await import(pathToFileURL(found).href)) as { default?: { agents?: AgentMap }; agents?: AgentMap };
  const agents = mod.default?.agents ?? mod.agents ?? {};
  for (const [k, v] of Object.entries(agents)) {
    if (typeof v !== 'function') throw new Error(`${found}: agents["${k}"] must be a function`);
  }
  return { agents, path: found };
}

/**
 * Fork through the llm-rewind build next to this CLI. When the CLI runs from a project's
 * node_modules, that is the same module instance the project's own code imports, so both
 * share one set of patches and one session context.
 */
async function defaultLoadFork(): Promise<ForkFn> {
  const indexUrl = new URL('./index.js', import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ indexUrl)) as { fork: ForkFn };
  return mod.fork;
}

async function loadAppHtml(): Promise<string> {
  // dist/cli.js → dist/ui/app.html; src/ui/server.ts → src/ui/app.html
  for (const rel of ['./ui/app.html', './app.html']) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(url)) return readFile(url, 'utf8');
  }
  throw new Error('rewind ui: app.html is missing from this installation');
}

function parseEdited(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function safeValue(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return null;
    return s.length > 200_000 ? `${s.slice(0, 200_000)}…` : (JSON.parse(s) as unknown);
  } catch {
    return String(v);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
