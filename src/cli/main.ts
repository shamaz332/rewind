import { existsSync } from 'node:fs';
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { diffRecordings, type StepDiff } from '../diff.js';
import { summarize, type StepSummary } from '../inspect.js';
import type { Pricing, Usage } from '../llm.js';
import { loadRecording } from '../store.js';
import { FORMAT, type Recording } from '../types.js';

export interface IO {
  out(line: string): void;
  err(line: string): void;
  color: boolean;
  width: number;
}

const defaultIO = (): IO => ({
  out: (l) => process.stdout.write(l + '\n'),
  err: (l) => process.stderr.write(l + '\n'),
  color: Boolean(process.env.FORCE_COLOR) || (process.stdout.isTTY === true && !process.env.NO_COLOR),
  width: process.stdout.columns || 120,
});

const HELP = `rewind: inspect and compare agent recordings

Usage
  rewind ls                         List recordings
  rewind show <name> [--step N]     Timeline of a run, or one step in detail
  rewind diff <a> <b>               Compare two runs step by step
  rewind prune --older-than 30d     Delete old recordings

Options
  --dir <path>        Recordings directory (default: .rewind)
  --pricing <file>    Model prices in USD per million tokens (default: <dir>/pricing.json if present)
  --json              Machine-readable output
  --full              (show) Do not truncate bodies
  --headers           (show --step) Include headers
  --exit-code         (diff) Exit with 1 when the runs differ
  --dry-run           (prune) List what would be deleted
  -h, --help          Show this help

<name> is a recording name (e.g. checkout-bug) or a path to a .rewind.json file.`;

export async function main(argv: string[], io: IO = defaultIO()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: 'string', default: '.rewind' },
        pricing: { type: 'string' },
        json: { type: 'boolean', default: false },
        full: { type: 'boolean', default: false },
        headers: { type: 'boolean', default: false },
        step: { type: 'string' },
        'exit-code': { type: 'boolean', default: false },
        'older-than': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    io.err(`rewind: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: o, positionals: [cmd, ...args] } = parsed;
  if (o.version) {
    io.out(await version());
    return 0;
  }
  if (o.help || !cmd || cmd === 'help') {
    io.out(HELP);
    return cmd || o.help ? 0 : 2;
  }

  const c = colors(io.color);
  try {
    const pricing = await loadPricing(o.pricing, o.dir);
    switch (cmd) {
      case 'ls':
        return await ls(o.dir, pricing, o.json, io, c);
      case 'show': {
        if (!args[0]) throw new UsageError('show needs a recording name');
        const rec = await open(args[0], o.dir);
        if (o.step !== undefined) return showStep(rec, parseStep(o.step), pricing, o, io, c);
        return show(rec, pricing, o.json, io, c);
      }
      case 'diff': {
        if (!args[0] || !args[1]) throw new UsageError('diff needs two recording names');
        const [a, b] = await Promise.all([open(args[0], o.dir), open(args[1], o.dir)]);
        return diff(a, b, pricing, o, io, c);
      }
      case 'prune':
        return await prune(o.dir, o['older-than'], o['dry-run'], io, c);
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`rewind: ${err.message}\n\n${HELP}`);
      return 2;
    }
    io.err(`rewind: ${(err as Error).message}`);
    return 1;
  }
}

class UsageError extends Error {}

// ─── commands ────────────────────────────────────────────────────────────────

async function ls(dir: string, pricing: Pricing | null, json: boolean, io: IO, c: Colors): Promise<number> {
  const files = await findRecordings(dir);
  const rows = [];
  for (const file of files) {
    let rec: Recording;
    try {
      rec = JSON.parse(await readFile(file, 'utf8')) as Recording;
      if (rec.format !== FORMAT) throw new Error(`unknown format ${String(rec.format)}`);
    } catch (err) {
      io.err(c.yellow(`skipping ${relative(process.cwd(), file)}: ${(err as Error).message}`));
      continue;
    }
    const s = summarize(rec, pricing);
    rows.push({ name: rec.name, file, bytes: (await stat(file)).size, createdAt: rec.createdAt, fork: rec.fork ?? null, totals: s.totals });
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (json) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    io.out(`No recordings in ${resolve(dir)}`);
    return 0;
  }
  const showCost = rows.some((r) => r.totals.cost !== null);
  const table = rows.map((r) => [
    r.name,
    String(r.totals.steps),
    String(r.totals.llmCalls),
    tokens(r.totals.usage) || '-',
    ...(showCost ? [money(r.totals.cost)] : []),
    ago(r.createdAt),
    bytes(r.bytes),
    r.fork ? `fork of ${r.fork.from}${r.fork.at !== null ? ` @${r.fork.at}` : ''}` : '',
  ]);
  printTable(io, c, ['NAME', 'STEPS', 'LLM', 'TOKENS', ...(showCost ? ['COST'] : []), 'RECORDED', 'SIZE', ''], table, [1, 2, 3, ...(showCost ? [4] : [])]);
  return 0;
}

function show(rec: Recording, pricing: Pricing | null, json: boolean, io: IO, c: Colors): number {
  const s = summarize(rec, pricing);
  if (json) {
    io.out(JSON.stringify({ ...s, steps: s.steps.map(({ requestBody, responseText, ...rest }) => rest) }, null, 2));
    return 0;
  }
  const t = s.totals;
  io.out(
    `${c.bold(s.name)}  ${c.dim('·')} ${t.steps} steps ${c.dim('·')} ${t.llmCalls} LLM calls` +
      `${tokens(t.usage) ? ` ${c.dim('·')} ${tokens(t.usage)} tokens` : ''}` +
      `${t.cost !== null ? ` ${c.dim('·')} ${money(t.cost)}` : ''} ${c.dim('·')} ${ms(t.durationMs)} ${c.dim('·')} recorded ${ago(s.createdAt)}`,
  );
  if (s.fork) io.out(c.dim(forkLine(s.fork)));
  if (t.errors) io.out(c.red(`${t.errors} failed step(s)`));
  io.out('');

  const isFork = s.steps.some((st) => st.source);
  const head = ['#', ...(isFork ? [''] : []), 'METHOD', 'TARGET', 'STATUS', 'TIME', 'MODEL', 'TOKENS', 'OUTPUT'];
  const rows = s.steps.map((st) => [
    String(st.seq),
    ...(isFork ? [st.source === 'live' ? (st.patched ? 'L*' : 'L') : 'R'] : []),
    st.method,
    truncate(st.host + st.path, 44),
    status(st),
    ms(st.durationMs),
    st.model ? truncate(st.model, 24) : '',
    st.usage ? tokens(st.usage) : '',
    st.output ? oneLine(st.output) : '',
  ]);
  printTable(io, c, head, rows, [0, isFork ? 5 : 4, isFork ? 7 : 6], (row, i) => {
    const st = s.steps[i]!;
    return st.error || (st.status ?? 0) >= 400 ? row.map((cell) => c.red(cell)) : row;
  });
  if (isFork) io.out(c.dim('\nR = replayed from the original recording, L = live, L* = live with patchRequest'));
  return 0;
}

function showStep(
  rec: Recording,
  seq: number,
  pricing: Pricing | null,
  o: { json: boolean; full: boolean; headers: boolean },
  io: IO,
  c: Colors,
): number {
  const s = summarize(rec, pricing);
  const st = s.steps.find((x) => x.seq === seq);
  const raw = rec.steps.find((x) => x.seq === seq);
  if (!st || !raw) throw new Error(`"${rec.name}" has no step ${seq} (steps 0-${s.steps.length - 1})`);
  if (o.json) {
    io.out(JSON.stringify({ ...st, request: raw.request, response: raw.response ?? null, error: raw.error ?? null }, null, 2));
    return 0;
  }
  const max = o.full ? Infinity : 4000;
  const origin = st.source ? ` ${c.dim('·')} ${st.source}${st.patched ? ' (patched)' : ''}` : '';
  io.out(`${c.bold(`#${st.seq} ${st.method} ${st.url}`)}`);
  io.out(`${status(st, c)} ${c.dim('·')} ${ms(st.durationMs)} ${c.dim('·')} via ${st.via}${origin}`);
  if (st.model) {
    const u = st.usage;
    io.out(
      `model ${c.cyan(st.model)}` +
        (u ? ` ${c.dim('·')} ${u.input.toLocaleString('en')} in / ${u.output.toLocaleString('en')} out` : '') +
        (u && (u.cacheRead || u.cacheWrite) ? ` ${c.dim(`(cache read ${u.cacheRead.toLocaleString('en')}, write ${u.cacheWrite.toLocaleString('en')})`)}` : '') +
        (st.cost !== null ? ` ${c.dim('·')} ${money(st.cost)}` : ''),
    );
  }
  if (raw.error) io.out(c.red(`error: ${raw.error.name}: ${raw.error.message}`));
  if (raw.response?.truncated) io.out(c.yellow(`truncated: ${raw.response.truncated.reason}`));

  if (o.headers) {
    section(io, c, 'Request headers', formatHeaders(raw.request.headers));
    if (raw.response) section(io, c, 'Response headers', formatHeaders(raw.response.headers));
  }
  section(io, c, 'Request body', st.requestBody === null ? c.dim('(none)') : clip(pretty(st.requestBody), max));
  if (st.output !== null) section(io, c, 'Model output', clip(st.output, max));
  const chunks = raw.response?.chunks.length ?? 0;
  const label = `Response body${chunks > 1 ? c.dim(` (${chunks} chunks)`) : ''}`;
  section(
    io,
    c,
    label,
    raw.response?.body == null ? c.dim('(none)') : st.responseText === null ? c.dim(`(${bytes(st.responseBytes)} binary)`) : clip(pretty(st.responseText), max),
  );
  return 0;
}

function diff(
  a: Recording,
  b: Recording,
  pricing: Pricing | null,
  o: { json: boolean; 'exit-code': boolean },
  io: IO,
  c: Colors,
): number {
  const d = diffRecordings(a, b, pricing);
  const differs = d.firstDivergence !== null;
  if (o.json) {
    const lite = (s: StepSummary) => ({ seq: s.seq, signature: s.signature, status: s.status, model: s.model, usage: s.usage, output: s.output });
    io.out(
      JSON.stringify(
        {
          a: { name: d.a.name, totals: d.a.totals },
          b: { name: d.b.name, totals: d.b.totals },
          firstDivergence: d.firstDivergence,
          counts: d.counts,
          delta: d.delta,
          steps: d.steps.map((s) => ({
            kind: s.kind,
            ...('a' in s ? { a: lite(s.a) } : {}),
            ...('b' in s ? { b: lite(s.b) } : {}),
            ...(s.kind === 'changed' ? { request: s.request, responseChanged: s.responseChanged } : {}),
          })),
        },
        null,
        2,
      ),
    );
    return differs && o['exit-code'] ? 1 : 0;
  }

  io.out(`${c.red('a')} ${c.bold(d.a.name)} ${c.dim(`(${d.a.totals.steps} steps)`)}    ${c.green('b')} ${c.bold(d.b.name)} ${c.dim(`(${d.b.totals.steps} steps)`)}`);
  io.out('');
  const marks: Record<StepDiff['kind'], string> = { same: c.dim('='), changed: c.yellow('~'), added: c.green('+'), removed: c.red('-') };
  const indent = ' '.repeat(16);
  const outputWidth = Math.max(30, Math.floor((io.width - 30) / 2));

  for (const s of d.steps) {
    const sa = 'a' in s ? s.a : null;
    const sb = 'b' in s ? s.b : null;
    const sig = (sa ?? sb)!.signature;
    const line = `${pad(sa ? `#${sa.seq}` : '', 5, true)} ${pad(sb ? `#${sb.seq}` : '', 5, true)}  ${marks[s.kind]}  ${sig}`;
    io.out(s.kind === 'same' ? c.dim(line) : line);
    if (s.kind === 'changed') {
      for (const r of s.request) {
        const [l, rr] = previewPair(r.left, r.right);
        io.out(`${indent}${c.dim('request')}  ${r.path}: ${c.red(l)} → ${c.green(rr)}`);
      }
      if (s.a.status !== s.b.status) io.out(`${indent}${c.dim('status')}   ${c.red(String(s.a.status ?? s.a.error))} → ${c.green(String(s.b.status ?? s.b.error))}`);
      if (s.responseChanged && (s.a.output || s.b.output) && s.a.output !== s.b.output) {
        io.out(`${indent}${c.dim('output')}   ${c.red(truncate(oneLine(s.a.output ?? ''), outputWidth))}`);
        io.out(`${indent}         ${c.green(truncate(oneLine(s.b.output ?? ''), outputWidth))}`);
      } else if (s.response.length) {
        for (const r of s.response) {
          const [l, rr] = previewPair(r.left, r.right);
          io.out(`${indent}${c.dim('response')} ${r.path}: ${c.red(l)} → ${c.green(rr)}`);
        }
      } else if (s.responseChanged && s.a.status === s.b.status) {
        io.out(`${indent}${c.dim('response body changed')}`);
      }
      if (s.a.usage && s.b.usage) {
        const du = usageDelta(s.a.usage, s.b.usage);
        if (du) io.out(`${indent}${c.dim('tokens')}  ${du}`);
      }
    } else if (s.kind !== 'same') {
      const st = (sa ?? sb)!;
      if (st.output) io.out(`${indent}${c.dim('output')}  ${truncate(oneLine(st.output), outputWidth)}`);
    }
  }

  io.out('');
  if (!differs) {
    io.out(c.green('Runs are identical.'));
    return 0;
  }
  const first = d.steps[d.firstDivergence!]!;
  const where = [('a' in first ? `a#${first.a.seq}` : null), ('b' in first ? `b#${first.b.seq}` : null)].filter(Boolean).join(' / ');
  io.out(`First divergence at ${c.bold(where)}`);
  io.out(`${d.counts.same} same ${c.dim('·')} ${d.counts.changed} changed ${c.dim('·')} ${d.counts.added} added ${c.dim('·')} ${d.counts.removed} removed`);
  const ua = d.a.totals.usage;
  const ub = d.b.totals.usage;
  const totals: string[] = [];
  if (tokens(ua) || tokens(ub)) totals.push(`tokens ${tokens(ua) || '0'} → ${tokens(ub) || '0'}`);
  if (d.delta.cost !== null) totals.push(`cost ${money(d.a.totals.cost)} → ${money(d.b.totals.cost)} (${signed(d.delta.cost, money)})`);
  totals.push(`time ${ms(d.a.totals.durationMs)} → ${ms(d.b.totals.durationMs)}`);
  io.out(totals.join(c.dim('  ·  ')));
  return o['exit-code'] ? 1 : 0;
}

async function prune(dir: string, olderThan: string | undefined, dryRun: boolean, io: IO, c: Colors): Promise<number> {
  if (!olderThan) throw new UsageError('prune needs --older-than (e.g. 30d, 12h)');
  const maxAge = parseDuration(olderThan);
  const cutoff = Date.now() - maxAge;
  let count = 0;
  let freed = 0;
  for (const file of await findRecordings(dir)) {
    let createdAt: number;
    try {
      createdAt = Date.parse((JSON.parse(await readFile(file, 'utf8')) as Recording).createdAt);
    } catch {
      continue;
    }
    if (!(createdAt < cutoff)) continue;
    const size = (await stat(file)).size;
    if (!dryRun) await unlink(file);
    count++;
    freed += size;
    io.out(`${dryRun ? c.dim('would delete') : c.red('deleted')} ${relative(process.cwd(), file)} ${c.dim(`(${ago(new Date(createdAt).toISOString())})`)}`);
  }
  io.out(count ? `${dryRun ? 'Would free' : 'Freed'} ${bytes(freed)} in ${count} recording(s).` : `No recordings older than ${olderThan}.`);
  return 0;
}

// ─── loading ─────────────────────────────────────────────────────────────────

async function open(nameOrPath: string, dir: string): Promise<Recording> {
  if (nameOrPath.endsWith('.rewind.json') && existsSync(nameOrPath)) {
    const rec = JSON.parse(await readFile(nameOrPath, 'utf8')) as Recording;
    if (rec.format !== FORMAT) throw new Error(`${nameOrPath} is not a ${FORMAT} recording`);
    return rec;
  }
  return loadRecording(nameOrPath, dir);
}

async function findRecordings(dir: string): Promise<string[]> {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.rewind.json')) out.push(p);
    }
  };
  await walk(root);
  return out;
}

async function loadPricing(file: string | undefined, dir: string): Promise<Pricing | null> {
  const path = file ?? join(dir, 'pricing.json');
  if (!existsSync(path)) {
    if (file) throw new Error(`pricing file ${file} not found`);
    return null;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Pricing;
  } catch (err) {
    throw new Error(`could not read pricing from ${path}: ${(err as Error).message}`);
  }
}

async function version(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

// ─── formatting ──────────────────────────────────────────────────────────────

type Colors = ReturnType<typeof colors>;

function colors(on: boolean) {
  const wrap = (open: number, close: number) => (s: string) => (on && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, '').length;

function pad(s: string, width: number, right = false): string {
  const fill = ' '.repeat(Math.max(0, width - visible(s)));
  return right ? fill + s : s + fill;
}

function printTable(
  io: IO,
  c: Colors,
  head: string[],
  rows: string[][],
  rightAligned: number[] = [],
  styleRow?: (row: string[], index: number) => string[],
): void {
  const widths = head.map((h, i) => Math.max(visible(h), ...rows.map((r) => visible(r[i] ?? ''))));
  // The last column takes whatever width is left, so long outputs never wrap the table.
  const fixed = widths.slice(0, -1).reduce((n, w) => n + w + 2, 0);
  widths[widths.length - 1] = Math.max(10, Math.min(widths[widths.length - 1]!, io.width - fixed));
  const render = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const w = widths[i]!;
        const v = i === cells.length - 1 ? truncate(cell, w) : cell;
        return pad(v, w, rightAligned.includes(i));
      })
      .join('  ')
      .trimEnd();
  io.out(c.dim(render(head)));
  rows.forEach((r, i) => {
    const line = render(r);
    io.out(styleRow ? render(styleRow(r, i)) : line);
  });
}

function section(io: IO, c: Colors, title: string, body: string): void {
  io.out('');
  io.out(c.bold(title));
  for (const l of body.split('\n')) io.out(`  ${l}`);
}

function status(st: StepSummary, c?: Colors): string {
  const s = st.error ? 'ERR' : st.status === null ? '…' : String(st.status);
  const marked = st.truncated ? `${s}!` : s;
  return c && (st.error || (st.status ?? 0) >= 400) ? c.red(marked) : marked;
}

function forkLine(f: NonNullable<Recording['fork']>): string {
  const at = f.at === null ? 'after the recording ran out' : `at step ${f.at}`;
  const live = f.liveFrom === null ? 'never went live' : f.reason === 'unmatched' ? `went live early at #${f.liveFrom} (run diverged)` : `live from #${f.liveFrom}`;
  return `fork of "${f.from}" ${at}, ${live}`;
}

function formatHeaders(h: Record<string, string>): string {
  const keys = Object.keys(h);
  return keys.length ? keys.map((k) => `${k}: ${h[k]}`).join('\n') : '(none)';
}

function pretty(v: unknown): string {
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return JSON.stringify(v, null, 2);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… ${(s.length - max).toLocaleString('en')} more characters (use --full)` : s;
}

function truncate(s: string, max: number): string {
  if (visible(s) <= max) return s;
  const plain = s.replace(ANSI, '');
  return plain.slice(0, Math.max(0, max - 1)) + '…';
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function preview(v: unknown, max = 60): string {
  return truncate(v === undefined ? '(missing)' : JSON.stringify(v) ?? String(v), max);
}

/** Two differing values side by side. For long strings, skip the shared prefix so the change is visible. */
function previewPair(a: unknown, b: unknown, max = 60): [string, string] {
  if (typeof a !== 'string' || typeof b !== 'string') return [preview(a, max), preview(b, max)];
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const from = common > 24 ? common - 12 : 0;
  const cut = (s: string) => {
    const shown = JSON.stringify(s.slice(from));
    const body = from ? `"…${shown.slice(1)}` : shown;
    return truncate(body, max);
  };
  return [cut(a), cut(b)];
}

function tokens(u: Usage | null): string {
  if (!u || u.input + u.output + u.cacheRead + u.cacheWrite === 0) return '';
  return `${compact(u.input + u.cacheRead + u.cacheWrite)} in / ${compact(u.output)} out`;
}

function usageDelta(a: Usage, b: Usage): string | null {
  const di = b.input + b.cacheRead + b.cacheWrite - (a.input + a.cacheRead + a.cacheWrite);
  const dout = b.output - a.output;
  if (!di && !dout) return null;
  return `${signed(di, compact)} in / ${signed(dout, compact)} out`;
}

function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function signed(n: number, f: (x: number) => string): string {
  return n > 0 ? `+${f(n)}` : n < 0 ? `-${f(-n)}` : f(0);
}

function money(n: number | null): string {
  if (n === null) return '';
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function ms(n: number): string {
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return iso.slice(0, 10);
}

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i.exec(s.trim());
  if (!m) throw new UsageError(`invalid duration "${s}" (use e.g. 45m, 12h, 30d, 2w)`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!.toLowerCase() as 'm' | 'h' | 'd' | 'w'];
  return Number(m[1]) * unit;
}

function parseStep(s: string): number {
  const n = Number(s.replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--step must be a step number, got "${s}"`);
  return n;
}
