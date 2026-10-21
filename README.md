# rewind

**Record and deterministically replay AI agent runs.**
Your agent failed at step 31. Replay it exactly, offline, for $0, as many times as you need.

```bash
npm install -D rewindjs
```

```ts
import { rewind } from 'rewindjs';

await rewind.record('checkout-bug', () => runAgent(input)); // real run, every request captured
await rewind.replay('checkout-bug', () => runAgent(input)); // exact replay: no network, no cost
await rewind.fork('checkout-bug', () => runAgent(input), { at: 31 }); // steps 0–30 replayed, 31+ live
```

Works with anything that talks over `fetch` or `node:http`: Anthropic, OpenAI, the Vercel AI SDK, LangChain, MCP over HTTP, axios, got, plain `fetch`. No code changes to your agent.

## Why

Agents are hard to debug because they don't repeat themselves. The model answers differently each time, tools return fresh data, and a 40-step run costs real money to reproduce. Observability tools show you *what* happened. rewind lets you **run it again**.

- **Exact replay**: every response, including streamed tokens chunk by chunk, comes back exactly as recorded. So do `Date.now()`, `new Date()`, `Math.random()` and `crypto.randomUUID()`, so run IDs and timestamps in your prompts match on replay too.
- **Parallel-safe**: sessions run concurrently (e.g. `test.concurrent`), and each one sees only its own requests.
- **Free, fast tests**: recorded runs become CI fixtures that need no API keys and finish in milliseconds.
- **Clear divergence errors**: if your change makes the agent ask something new, rewind tells you exactly what changed:

```
ReplayDivergenceError: Replay diverged: the recording has no response for POST https://api.anthropic.com/v1/messages
  Step #3 in the recording is a POST to this URL, but its body is different.
  First difference at $.messages[4].content:
    recorded: "Find flights to Lisbon"
    now:      "Find flights to Lisbon in May"
  Re-record with REWIND_MODE=record if this change is intended.
```

- **Secrets never hit disk**: `Authorization`, `x-api-key`, cookies, `?key=` params and known key formats (`sk-ant-…`, `sk-…`, `ghp_…`, `AKIA…`, `AIza…`) are redacted from requests *and* responses.
- **Readable, compact recordings**: plain JSON you can commit and review, with each distinct body stored only once.

## Fork: fix step 31 without re-running steps 0–30

You found the bug and changed the prompt. With `fork`, the agent gets the *recorded* responses for every step before `at`, then goes live:

```ts
const res = await rewind.fork('book-flight', () => agent(fixedPrompt), { at: 2 });
// res.value     → what your agent returned
// res.replayed  → 2 steps served from the recording
// res.live      → 1 step sent to the real model
// res.savedAs   → 'book-flight.fork-2', a new recording you can commit as a regression test
```

Before the fork point, requests match by **method + URL in recorded order, ignoring the body**. A changed system prompt changes every request body, and the fork still gets the same history the failing run saw. `Date`, `Math.random` and UUIDs follow the original run until it goes live. If your changed code makes a request the recording has no counterpart for before `at`, the fork goes live there and reports `reason: 'unmatched'`.

Run `node examples/fork-demo.mjs` (after `npm run build`) to see it end to end.

**Try "what if" without touching your code:**

```ts
// Send a different system prompt from step 31 on
await rewind.fork('run', agent, { at: 31, patchRequest: (req) => ({ ...req.body, system: newSystem }) });

// What if the search tool had failed at step 12?
await rewind.fork('run', agent, {
  at: 13,
  patchResponse: (res, { step }) => (step === 12 ? { error: 'timeout' } : undefined),
});
```

## Inspect and compare runs

```bash
npx rewind ls                              # every recording: steps, LLM calls, tokens, age
npx rewind show book-flight                # timeline of one run
npx rewind show book-flight --step 2       # one step: request, model output, response
npx rewind diff book-flight book-flight.fork-2
```

`diff` lines up two runs step by step, even when one made extra calls, and shows what changed and what it did:

```
a book-flight (3 steps)    b book-flight.fork-2 (3 steps)

   #0    #0  ~  POST api.example.com/v1/messages
                request  $.system: "…or the user." → "…or the user. Always choose the cheapest option."
   #1    #1  =  POST api.example.com/flights
   #2    #2  ~  POST api.example.com/v1/messages
                request  $.system: "…or the user." → "…or the user. Always choose the cheapest option."
                output   Booking TP 1351 for €315
                         Booking U2 8173 for €216
                tokens  +9 in / 0 out

First divergence at a#0 / b#0
1 same · 2 changed · 0 added · 0 removed
tokens 106 in / 21 out → 115 in / 21 out  ·  time 51 ms → 11 ms
```

rewind understands **Anthropic, OpenAI (Chat Completions and Responses) and Gemini** traffic, streamed or not: it shows the model, token usage (cached tokens counted separately) and output text, including tool calls. Everything has `--json` output; `diff --exit-code` exits 1 when runs differ, for CI.

**Costs:** rewind does not ship a price list, because prices change and a stale table would show wrong numbers. To see costs, add `.rewind/pricing.json` with your provider's current prices in USD per million tokens. Keys match a model name exactly or as a prefix:

```json
{
  "my-model-name": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
}
```

**Housekeeping:** `npx rewind prune --older-than 30d` (add `--dry-run` to preview).

The same analysis is available from code: `summarize(recording)`, `diffRecordings(a, b)`.

## Timeline viewer

```bash
npx rewind ui
```

This opens a local web app with every recording:

- **Run view:** a waterfall timeline of every request, including parallel ones. Scrub with the slider or <kbd>↑</kbd>/<kbd>↓</kbd>, and inspect any step's model output, request, response and headers.
- **Compare view:** two runs side by side, aligned step by step, with the changed fields listed above both versions.
- **Fork from here:** select a step, edit its request body in the browser (for example the system prompt), and run the fork live. You land on a diff of the original run against the fork.

To fork from the UI, tell it how to run your agent in `rewind.config.mjs`:

```js
// rewind.config.mjs
import { runAgent } from './src/agent.js';

export default {
  agents: {
    'book-flight': () => runAgent('Book me a flight to Lisbon'),
    'checkout-*': () => runCheckoutAgent(), // a trailing * matches by prefix
  },
};
```

Forks of a recording use the same agent. Without a config, the button shows the code to run the fork yourself.

The UI listens on `127.0.0.1` only. It has no external requests or CDN, so it works offline. Because it can run your agent, and live steps cost money, every API call needs a token that is generated at each launch and included in the printed link. Requests from other sites are rejected by `Host` checks. Options: `--port`, `--config`, `--no-open`, `--dir`.

## Use it in tests

```ts
import { test, expect } from 'vitest';
import { rewind } from 'rewindjs';

test('agent books the cheapest flight', async () => {
  const result = await rewind.auto('book-flight', () => agent.run('Book me a flight to Lisbon'));
  expect(result.booking.price).toBeLessThan(300);
});
```

`auto` records on the first run and replays afterwards. Refresh all recordings with:

```bash
REWIND_MODE=record npm test
```

## API

### `record(name, fn, options?)`
Runs `fn` against the real network and saves every request and response to `.rewind/<name>.rewind.json`. The recording is saved **even if `fn` throws**, so you can replay crashes.

### `replay(name, fn, options?)`
Runs `fn` with every `fetch` answered from the recording. Throws `ReplayDivergenceError` if the run makes a request the recording can't answer. It throws even if your code caught the error, because SDK retry logic often hides it. Identical requests replay in recorded order.

### `fork(name, fn, options?)`
Replays `name` up to step `at`, then runs live. Saves the run as its own recording that `replay()` reproduces. Options: `at` (default: go live when the recording runs out), `saveAs` (name, or `false`), `patchRequest`, `patchResponse`, plus the record and replay options. Returns `{ value, replayed, live, liveFrom, reason, savedAs }`.

### `auto(name, fn, options?)`
Replays if the recording exists, otherwise records. `REWIND_MODE=record|replay|auto` overrides.

### `load(name, dir?)`
Returns the parsed recording for inspection.

### Options

| Option | Applies to | Default | |
|---|---|---|---|
| `dir` | all | `.rewind` | Where recordings live |
| `deterministic` | all | `true` | Control clock, `Math.random` and UUIDs. `false` turns it off; `{ clock, random, uuid }` picks sources |
| `redactHeaders` | all | | Extra header names to redact |
| `redactBody` | all | | `(text, { url }) => text`, to strip timestamps or nonces from request bodies before matching |
| `settleTimeoutMs` | record | `10000` | How long to wait for streams still open when `fn` returns |
| `timing` | replay | `'instant'` | `'original'` reproduces the recorded streaming speed |
| `speed` | replay | `1` | Playback multiplier for `timing: 'original'` |
| `strict` | replay | `false` | Fail if recorded steps were never used |
| `passthrough` | replay | | `(url: URL) => boolean`: send matching requests to the real network |

### How matching works
A request matches a recorded one by **method + URL + body**. Query parameters are compared regardless of order, JSON bodies regardless of key order, and secrets are redacted before comparing. Headers are not compared, so a rotated API key never breaks a replay.

### What gets controlled
Inside a session, rewind intercepts:

| Source | Record | Replay |
|---|---|---|
| `fetch`, `node:http`, `node:https` | real network, saved | answered from the recording |
| `Date.now()`, `new Date()`, `Date()` | real time, saved | recorded values, then real time continues from the last one |
| `Math.random()` | seeded generator, seed saved | same seed, same sequence |
| `crypto.randomUUID()` (global and `node:crypto`) | real UUIDs, saved | recorded UUIDs, then deterministic ones |

Outside a session, every patched API behaves exactly like the original. Calls are attributed to a session through `AsyncLocalStorage`, so test runners and loggers calling `Date.now()` in the background never consume recorded values. `performance.now()`, timers and `crypto.getRandomValues()` are not touched.

## Important: import order
rewind patches `globalThis.fetch` when it is imported. Some SDKs capture `fetch` when you construct a client, so **import `rewindjs` before you create your SDK clients**, or pass the fetch explicitly:

```ts
import { rewind } from 'rewindjs';
const client = new Anthropic({ fetch: rewind.fetch });
```

`node:http` clients (axios, got, …) don't need this.

## Roadmap

- [x] **Phase 1**: fetch interception, recording format, redaction, replay, divergence errors
- [x] **Phase 2**: deterministic `Date`, `Math.random()`, `crypto.randomUUID()`; `node:http` interception; concurrent sessions via `AsyncLocalStorage`
- [x] **Phase 3**: `fork()`: replay up to a step, then go live, with request/response patching
- [x] **Phase 4**: CLI: `rewind ls`, `show`, `diff`, `prune`; token usage and costs for Anthropic, OpenAI and Gemini
- [x] **Phase 5**: `npx rewind ui`: timeline you can scrub, side-by-side diffs, fork from the browser
- [ ] **Phase 6**: Vitest/Jest matchers, GitHub Action, Python port

## License

MIT
