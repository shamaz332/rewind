// The launch demo: an agent picks the wrong flight, you fix the prompt, and re-run only the last step.
//
//   npm run build && node examples/fork-demo.mjs
//
// A local fake "model" and "flight API" stand in for real services, so this runs offline and free.
import { rewind } from '../dist/index.js';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';

let modelCalls = 0;
let apiCalls = 0;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/flights') {
    apiCalls++;
    // Live prices change every call, which is exactly why this bug was hard to reproduce.
    const flights = ['TP 1351', 'FR 8341', 'U2 8173'].map((id) => ({ id, price: 80 + Math.floor(Math.random() * 300) }));
    flights[0].price = Math.max(...flights.map((f) => f.price)) + 40; // the airline's sponsored result is listed first
    return res.end(JSON.stringify(flights));
  }
  // A fake model that speaks the Anthropic Messages format, so `rewind show`/`diff` see tokens and output.
  modelCalls++;
  const { model, system, messages } = JSON.parse(body);
  const { task, flights } = JSON.parse(messages.at(-1).content);
  let text = `Plan: search flights for "${task}", then pick one.`;
  if (flights) {
    const pick = system.includes('cheapest') ? flights.reduce((a, b) => (b.price < a.price ? b : a)) : flights[0];
    text = `Booking ${pick.id} for €${pick.price}`;
  }
  res.end(JSON.stringify({
    id: `msg_${modelCalls}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: Math.ceil(text.length / 4) },
  }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) =>
  (await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

const ask = (system, content) =>
  post('/v1/messages', { model: 'demo-model', max_tokens: 200, system, messages: [{ role: 'user', content: JSON.stringify(content) }] });

function agent(system) {
  return async () => {
    const task = 'Lisbon, 12 May';
    await ask(system, { task }); // step 0: plan
    const flights = await post('/flights', { task }); // step 1: tool call
    const reply = await ask(system, { task, flights }); // step 2: decide
    const id = /Booking (\S+ \d+)/.exec(reply.content[0].text)[1];
    const pick = flights.find((f) => f.id === id);
    const cheapest = Math.min(...flights.map((f) => f.price));
    return { pick, cheapest, ok: pick.price === cheapest };
  };
}

const dir = '.rewind-demo';
const line = (s = '') => console.log(s);

line('1. The agent runs in production and books an expensive flight.');
const bad = await rewind.record('book-flight', agent('You book flights for the user.'), { dir });
line(`   picked ${bad.pick.id} at €${bad.pick.price}; cheapest was €${bad.cheapest} → ${bad.ok ? 'ok' : 'BUG'}`);

line('\n2. Replay the exact failing run, with no network calls:');
const before = modelCalls + apiCalls;
const again = await rewind.replay('book-flight', agent('You book flights for the user.'), { dir });
line(`   picked ${again.pick.id} at €${again.pick.price} (same prices, same bug), network calls: ${modelCalls + apiCalls - before}`);

line('\n3. Fix the prompt and fork from step 2: steps 0–1 come from the recording, step 2 goes live.');
const callsBefore = { model: modelCalls, api: apiCalls };
const fixed = await rewind.fork('book-flight', agent('You book flights for the user. Always choose the cheapest option.'), { dir, at: 2 });
line(`   picked ${fixed.value.pick.id} at €${fixed.value.pick.price}; cheapest was €${fixed.value.cheapest} → ${fixed.value.ok ? 'FIXED' : 'still broken'}`);
line(`   replayed ${fixed.replayed} steps, ran ${fixed.live} live: ${modelCalls - callsBefore.model} model call, ${apiCalls - callsBefore.api} flight API calls`);
line(`   saved as "${fixed.savedAs}", which you can now commit as a regression test.`);

server.close();
if (process.env.KEEP) line(`\n   recordings kept in ${dir}/ (try: npx rewind diff book-flight book-flight.fork-2 --dir ${dir})`);
else await rm(dir, { recursive: true, force: true });
