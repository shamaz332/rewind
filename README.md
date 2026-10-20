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
```

Works with any SDK that uses `fetch`: Anthropic, OpenAI, the Vercel AI SDK, LangChain, MCP over HTTP, or plain `fetch`. No code changes to your agent.

## Why

Agents are hard to debug because they don't repeat themselves. The model answers differently each time, tools return fresh data, and a 40-step run costs real money to reproduce. Observability tools show you *what* happened. rewind lets you **run it again**.

- **Exact replay**: every response, including streamed tokens chunk by chunk, comes back exactly as recorded.
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

### `auto(name, fn, options?)`
Replays if the recording exists, otherwise records. `REWIND_MODE=record|replay|auto` overrides.

### `load(name, dir?)`
Returns the parsed recording for inspection.

### Options

| Option | Applies to | Default | |
|---|---|---|---|
| `dir` | all | `.rewind` | Where recordings live |
| `redactHeaders` | all | | Extra header names to redact |
| `redactBody` | all | | `(text, { url }) => text`, to strip timestamps or nonces from request bodies before matching |
| `settleTimeoutMs` | record | `10000` | How long to wait for streams still open when `fn` returns |
| `timing` | replay | `'instant'` | `'original'` reproduces the recorded streaming speed |
| `speed` | replay | `1` | Playback multiplier for `timing: 'original'` |
| `strict` | replay | `false` | Fail if recorded steps were never used |
| `passthrough` | replay | | `(url: URL) => boolean`: send matching requests to the real network |

### How matching works
A request matches a recorded one by **method + URL + body**. Query parameters are compared regardless of order, JSON bodies regardless of key order, and secrets are redacted before comparing. Headers are not compared, so a rotated API key never breaks a replay.

## Important: import order
rewind patches `globalThis.fetch` when it is imported. Some SDKs capture `fetch` when you construct a client, so **import `rewindjs` before you create your SDK clients**, or pass the fetch explicitly:

```ts
import { rewind } from 'rewindjs';
const client = new Anthropic({ fetch: rewind.fetch });
```

## Roadmap

- [x] **Phase 1**: fetch interception, recording format, redaction, replay, divergence errors
- [ ] **Phase 2**: deterministic `Date.now()`, `Math.random()`, `crypto.randomUUID()`; `node:http` interception; concurrent sessions via `AsyncLocalStorage`
- [ ] **Phase 3**: `fork(name, { at: 31 })`: replay up to a step, then go live with a patched prompt
- [ ] **Phase 4**: `npx rewind diff a b`, `rewind ls`, token and cost deltas
- [ ] **Phase 5**: `npx rewind ui`, a local timeline viewer you can scrub through
- [ ] **Phase 6**: Vitest/Jest matchers, GitHub Action, Python port

## License

MIT
