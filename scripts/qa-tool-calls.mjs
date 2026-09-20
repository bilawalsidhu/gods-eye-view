#!/usr/bin/env node
// Tool-calling accuracy and latency eval for local Ollama models, using the
// production system prompt and the same 28 tool schemas the voice path sends.
//
//   node scripts/qa-tool-calls.mjs [--models qwen2.5:14b,qwen3:14b,qwen3:8b]
//        [--reps 3] [--cases all|quick] [--json out.json]
//
// Each case is a fresh conversation (system + one user turn). The first call
// per model is discarded (model load). prompt_eval_count near the full prompt
// size (~12k tokens) proves num_ctx is not truncating the tool schemas.
import { writeFileSync } from 'node:fs';
import { GEV_REALTIME_TOOLS } from '../server/providers/openai/tools.js';
import { realtimeInstructions } from '../server/providers/openai/instructions.js';
import { streamChat, ollamaRequestDefaults } from '../server/providers/ollama/chat.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const models = (args.get('models') || 'qwen2.5:14b,qwen3:14b,qwen3:8b').split(',');
const reps = Number(args.get('reps')) || 3;

const tools = GEV_REALTIME_TOOLS.map(({ name, description, parameters }) => ({
  type: 'function',
  function: { name, description, parameters },
}));

// expected: every listed tool must appear (order-insensitive); alt: any one of
// these also counts as correct for that slot.
export const CASES = [
  { text: 'fly to Tokyo', expect: ['fly_to_location'], check: (c) => /tokyo/i.test(JSON.stringify(c[0]?.function?.arguments)) },
  { text: 'show me live flights', expect: ['set_layer_visibility'], alt: ['show_data_layers_menu'] },
  { text: 'go to the flights layer', expect: ['show_data_layers_menu'], alt: ['set_layer_visibility', 'set_panel_open'] },
  { text: 'turn on ships and earthquakes', expect: ['set_layer_visibility', 'set_layer_visibility'] },
  { text: 'zoom out to the globe', expect: ['zoom_to_globe'], alt: ['adjust_camera_zoom'] },
  { text: "what's the nearest aircraft", expect: ['select_nearest_aircraft'], alt: ['get_entity_context', 'analyst_query'] },
  { text: 'track it', expect: ['track_entity'], alt: ['select_nearest_aircraft', 'get_current_view_state'] },
  { text: 'switch to thermal view', expect: ['set_visual_style'] },
  { text: 'stop tracking', expect: ['stop_tracking'] },
  { text: 'clear the annotations', expect: ['clear_annotations'] },
  { text: 'take me to Paris and enable flights', expect: ['fly_to_location', 'set_layer_visibility'] },
  { text: 'what am I looking at', expect: ['get_current_view_state'], alt: ['get_entity_context', 'analyst_query'] },
];

function score(testCase, calls) {
  const names = calls.map((call) => call.function?.name);
  const remaining = [...names];
  let hits = 0;
  for (const want of testCase.expect) {
    const index = remaining.findIndex((n) => n === want || testCase.alt?.includes(n));
    if (index >= 0) {
      remaining.splice(index, 1);
      hits++;
    }
  }
  const ok = hits === testCase.expect.length && (!testCase.check || testCase.check(calls));
  return { ok, names };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
}

const system = { role: 'system', content: realtimeInstructions() };
const report = { numCtx: ollamaRequestDefaults().num_ctx, reps, models: {} };

for (const model of models) {
  console.log(`\n=== ${model} ===`);
  // Warm the model and discard timing.
  try {
    await streamChat({ model, messages: [system, { role: 'user', content: 'hello' }], tools });
  } catch (error) {
    console.log(`  load failed: ${error.message}`);
    report.models[model] = { error: error.message };
    continue;
  }
  const latencies = [];
  const promptTokens = [];
  const perCase = [];
  let correct = 0;
  for (const testCase of CASES) {
    let caseHits = 0;
    let lastNames = [];
    for (let rep = 0; rep < reps; rep++) {
      const started = Date.now();
      let reply;
      try {
        reply = await streamChat({
          model,
          messages: [system, { role: 'user', content: testCase.text }],
          tools,
          options: { temperature: 0 },
        });
      } catch (error) {
        lastNames = [`ERROR: ${error.message}`];
        continue;
      }
      const ms = Date.now() - started;
      latencies.push(ms);
      if (reply.promptEvalCount) promptTokens.push(reply.promptEvalCount);
      const { ok, names } = score(testCase, reply.toolCalls);
      lastNames = names.length ? names : [`(text) ${reply.content.slice(0, 60)}`];
      if (ok) caseHits++;
    }
    const rate = caseHits / reps;
    correct += rate;
    perCase.push({ text: testCase.text, rate, sample: lastNames });
    console.log(`  ${rate === 1 ? 'PASS' : rate > 0 ? 'FLAKY' : 'FAIL'} ${String(Math.round(rate * 100)).padStart(3)}%  ${testCase.text}  ->  ${lastNames.join(', ')}`);
  }
  const summary = {
    accuracy: Number((correct / CASES.length).toFixed(3)),
    medianMs: median(latencies),
    p90Ms: percentile(latencies, 0.9),
    medianPromptTokens: median(promptTokens),
    perCase,
  };
  report.models[model] = summary;
  console.log(
    `  accuracy ${(summary.accuracy * 12).toFixed(1)}/12  median ${summary.medianMs} ms  p90 ${summary.p90Ms} ms  prompt tokens ${summary.medianPromptTokens}` +
      (summary.medianPromptTokens && summary.medianPromptTokens < 9000 ? '  (!! prompt looks truncated; raise OLLAMA_NUM_CTX)' : ''),
  );
}

if (args.get('json')) writeFileSync(args.get('json'), JSON.stringify(report, null, 2));
console.log('\nDecision rule: smallest model with >= 11/12 and median <= 2500 ms; if qwen3:8b is within one case of qwen3:14b, ship 8b.');
