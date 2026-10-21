/**
 * Best-effort understanding of LLM API traffic: token usage, output text and model, for
 * Anthropic, OpenAI (Chat Completions and Responses) and Gemini, both JSON and streamed (SSE).
 * Nothing here is used for matching; it only feeds `show`, `diff` and summaries.
 */

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A response body as a list of JSON objects: one for a JSON body, one per `data:` event for SSE. */
export function parsePayloads(text: string | null): Obj[] {
  if (!text) return [];
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const v = JSON.parse(text) as unknown;
      // Gemini's non-SSE streaming endpoint returns a JSON array of chunks.
      return Array.isArray(v) ? v.filter(isObj) : isObj(v) ? [v] : [];
    } catch {
      /* fall through: may be SSE that happens to start with '{' on some servers */
    }
  }
  const out: Obj[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const v = JSON.parse(data) as unknown;
      if (isObj(v)) out.push(v);
    } catch {
      /* non-JSON event */
    }
  }
  return out;
}

export function extractUsage(payloads: Obj[]): Usage | null {
  let found = false;
  let inputIncludesCache = false;
  const u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Streams report usage cumulatively and across several events, so take the max of each field.
  const take = (field: keyof Usage, v: number | undefined) => {
    if (v === undefined) return;
    found = true;
    u[field] = Math.max(u[field], v);
  };
  for (const p of payloads) {
    const candidates = [p.usage, isObj(p.message) ? p.message.usage : undefined, isObj(p.response) ? p.response.usage : undefined];
    for (const c of candidates) {
      if (!isObj(c)) continue;
      take('input', num(c.input_tokens) ?? num(c.prompt_tokens));
      take('output', num(c.output_tokens) ?? num(c.completion_tokens));
      take('cacheWrite', num(c.cache_creation_input_tokens));
      const details = isObj(c.prompt_tokens_details) ? c.prompt_tokens_details : isObj(c.input_tokens_details) ? c.input_tokens_details : null;
      const cached = details ? num(details.cached_tokens) : undefined;
      if (cached !== undefined) inputIncludesCache = true;
      take('cacheRead', num(c.cache_read_input_tokens) ?? cached);
    }
    const g = p.usageMetadata;
    if (isObj(g)) {
      take('input', num(g.promptTokenCount));
      take('output', num(g.candidatesTokenCount));
      if (num(g.cachedContentTokenCount) !== undefined) inputIncludesCache = true;
      take('cacheRead', num(g.cachedContentTokenCount));
    }
  }
  // OpenAI and Gemini count cached tokens inside the input count; Anthropic reports them separately.
  // Normalize to Anthropic's shape so `input` is always the uncached part.
  if (inputIncludesCache) u.input = Math.max(0, u.input - u.cacheRead);
  return found ? u : null;
}

/** The model's visible output: text, plus `[tool: name]` markers for tool calls. */
export function extractText(payloads: Obj[]): string | null {
  const parts: string[] = [];
  for (const p of payloads) {
    // Anthropic message
    if (p.type === 'message') for (const b of arr(p.content)) block(b);
    // Anthropic stream
    if (p.type === 'content_block_start' && isObj(p.content_block) && p.content_block.type === 'tool_use') block(p.content_block);
    if (p.type === 'content_block_delta' && isObj(p.delta) && p.delta.type === 'text_delta') push(p.delta.text);
    // OpenAI Chat Completions, JSON and stream
    for (const c of arr(p.choices)) {
      if (!isObj(c)) continue;
      const m = isObj(c.message) ? c.message : isObj(c.delta) ? c.delta : null;
      if (!m) continue;
      push(m.content);
      for (const t of arr(m.tool_calls)) if (isObj(t) && isObj(t.function) && str(t.function.name)) parts.push(`[tool: ${t.function.name}]`);
    }
    // OpenAI Responses API
    if (p.object === 'response') for (const o of arr(p.output)) responsesItem(o);
    if (p.type === 'response.output_text.delta') push(p.delta);
    if (p.type === 'response.output_item.done') responsesItem(p.item, true);
    // Gemini
    for (const c of arr(p.candidates)) {
      if (!isObj(c) || !isObj(c.content)) continue;
      for (const part of arr(c.content.parts)) {
        if (!isObj(part)) continue;
        push(part.text);
        if (isObj(part.functionCall) && str(part.functionCall.name)) parts.push(`[tool: ${part.functionCall.name}]`);
      }
    }
  }
  return parts.length ? parts.join('') : null;

  function push(v: unknown) {
    if (typeof v === 'string' && v) parts.push(v);
  }
  function block(b: unknown) {
    if (!isObj(b)) return;
    if (b.type === 'text') push(b.text);
    if (b.type === 'tool_use' && str(b.name)) parts.push(`[tool: ${b.name}]`);
  }
  function responsesItem(o: unknown, toolsOnly = false) {
    if (!isObj(o)) return;
    if (o.type === 'function_call' && str(o.name)) parts.push(`[tool: ${o.name}]`);
    if (!toolsOnly && o.type === 'message') for (const c of arr(o.content)) if (isObj(c) && c.type === 'output_text') push(c.text);
  }
}

/** Names of the tools the model asked to call, in order. */
export function extractToolCalls(payloads: Obj[]): string[] {
  const names: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) names.push(v);
  };
  for (const p of payloads) {
    if (p.type === 'message') for (const b of arr(p.content)) if (isObj(b) && b.type === 'tool_use') add(b.name);
    if (p.type === 'content_block_start' && isObj(p.content_block) && p.content_block.type === 'tool_use') add(p.content_block.name);
    for (const c of arr(p.choices)) {
      if (!isObj(c)) continue;
      const m = isObj(c.message) ? c.message : isObj(c.delta) ? c.delta : null;
      // Streamed OpenAI tool calls repeat per chunk; only the chunk carrying the name counts.
      if (m) for (const t of arr(m.tool_calls)) if (isObj(t) && isObj(t.function)) add(t.function.name);
    }
    if (p.object === 'response') for (const o of arr(p.output)) if (isObj(o) && o.type === 'function_call') add(o.name);
    if (p.type === 'response.output_item.done' && isObj(p.item) && p.item.type === 'function_call') add(p.item.name);
    for (const c of arr(p.candidates)) {
      if (!isObj(c) || !isObj(c.content)) continue;
      for (const part of arr(c.content.parts)) if (isObj(part) && isObj(part.functionCall)) add(part.functionCall.name);
    }
  }
  return names;
}

export function extractModel(requestBody: unknown, payloads: Obj[], url: string): string | null {
  if (isObj(requestBody) && str(requestBody.model)) return requestBody.model as string;
  for (const p of payloads) {
    if (str(p.model)) return p.model as string;
    if (isObj(p.message) && str(p.message.model)) return p.message.model as string;
    if (isObj(p.response) && str(p.response.model)) return p.response.model as string;
    if (str(p.modelVersion)) return p.modelVersion as string;
  }
  const gemini = /\/models\/([^/:]+):/.exec(url);
  return gemini?.[1] ?? null;
}

/** USD per million tokens, keyed by model name or model-name prefix. Supplied by the user. */
export type Pricing = Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;

export function costOf(model: string | null, usage: Usage | null, pricing: Pricing | null): number | null {
  if (!model || !usage || !pricing) return null;
  // Exact match first, then the longest key the model name starts with.
  const key = pricing[model] ? model : Object.keys(pricing).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  const p = key ? pricing[key] : undefined;
  if (!p) return null;
  return (
    (usage.input * (p.input ?? 0) + usage.output * (p.output ?? 0) + usage.cacheRead * (p.cacheRead ?? 0) + usage.cacheWrite * (p.cacheWrite ?? 0)) /
    1_000_000
  );
}
