#!/usr/bin/env node
/**
 * qa-voice-bench.mjs — provider-neutral TEXT-mode voice-routing benchmark.
 *
 * Every provider gets the same prompt: production's realtimeInstructions()
 * and GEV_REALTIME_TOOLS (the Realtime adapter uses the exact session body the
 * token handler mints). Two suites, reported separately:
 *   core      the qa-voice-routing phrase table, graded with its semantics
 *             (plus benchmark-only typed-argument checks)
 *   coverage  the newer-layers coverage probe, graded correct /
 *             honest-refusal / hallucinated-capability / wrong-tool
 *   dialogue  two-turn dialogues in one context; turn 2 depends on turn 1
 *   capability  area handles / imagery / OSM / point-and-ask phrases (and two
 *             dialogues) for the tools added after 4b56d0e9
 * Coverage rows are graded twice: v1 (original rubric, 4b56d0e9 tool schema)
 * and v2 (rubric for the current tool surface).
 *
 * Methodology: a fresh context per phrase (new Realtime/Live session, or a
 * stateless chat request); stub tool results; continuations until the model
 * stops calling tools (max 4). No app page is involved.
 *
 * Usage:
 *   node scripts/qa-voice-bench.mjs --provider openai-realtime --model gpt-realtime-2 --reps 2
 *   node scripts/qa-voice-bench.mjs --provider gemini-live --model gemini-3.8-live
 *   node scripts/qa-voice-bench.mjs --provider ollama --model gemma4:e4b
 *   node scripts/qa-voice-bench.mjs --provider openai-chat --base http://localhost:1234/v1 --model <id>
 *   node scripts/qa-voice-bench.mjs --summarize --out qa-shots/voice-bench/<run>
 * Common flags: --out <dir> (reuse one dir to collect several models),
 *   --suite core,coverage  --only <substr>  --budget <usd, cloud total>
 *   --variant <label>  --temperature <t>  --num-ctx <n>  --think  --note <text>
 *   --reps <n> --start-rep <k> (add repetitions k..k+n-1 to an existing run)
 *   --replace (supersede earlier runs of this model for the suites run)
 *   --compare <run dir> (add a before → after table against another run)
 *
 * Output (gitignored): <out>/results.jsonl, summary.json, summary.md.
 * Keys come from the environment or the macOS Keychain at runtime only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CORE_PHRASES, COVERAGE_PROBE, DIALOGUES, CAPABILITY_EXTRAS,
  dialogueResult, coverageRubric,
} from './voice-bench/phrases.mjs';
import { gradeCore, gradeCoverage, gradeDialogue, expectLabel } from './voice-bench/grade.mjs';
import { stubResult } from './voice-bench/stub.mjs';
import { summarize, renderMarkdown, renderComparison } from './voice-bench/report.mjs';
import { GEV_REALTIME_TOOLS, realtimeInstructions } from './voice-bench/productionConfig.mjs';
import { chatNormalizationDiff } from './voice-bench/toolFormats.mjs';
import { createOpenAiRealtimeAdapter } from './voice-bench/adapters/openaiRealtime.mjs';
import { createGeminiLiveAdapter } from './voice-bench/adapters/geminiLive.mjs';
import { createOpenAiChatAdapter, createOllamaAdapter } from './voice-bench/adapters/localChat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (flag) => argv.includes(flag);

const PROVIDER = opt('--provider', null);
const MODEL = opt('--model', null);
const CLOUD = PROVIDER === 'openai-realtime' || PROVIDER === 'gemini-live';
const REPS = Number(opt('--reps', CLOUD ? '2' : '1'));
const START_REP = Number(opt('--start-rep', '1'));
const SUITES = opt('--suite', 'core,coverage,dialogue,capability').split(',');
const ONLY = opt('--only', null);
const BUDGET = Number(opt('--budget', '30'));
const VARIANT = opt('--variant', null);
const OUT = path.resolve(ROOT, opt('--out', path.join('qa-shots', 'voice-bench', new Date().toISOString().replace(/[:.]/g, '-'))));
const LEDGER = path.join(ROOT, 'qa-shots', 'voice-bench', 'cloud-spend.json');

fs.mkdirSync(OUT, { recursive: true });
const RESULTS = path.join(OUT, 'results.jsonl');
const NOTES = path.join(OUT, 'notes.json');

function readRows() {
  if (!fs.existsSync(RESULTS)) return [];
  // Several runs may append to one results file (a cloud run beside a local
  // one); skip a line another process is still writing.
  return fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}
function appendRow(row) {
  fs.appendFileSync(RESULTS, `${JSON.stringify(row)}\n`);
}
function readNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES, 'utf8')); } catch { return []; }
}
/**
 * Re-grade stored turns with the CURRENT phrase tables and grader, so a
 * grader fix applies to every model already in the results file. The raw
 * calls and text in results.jsonl are the source of truth; `gradeAtRun`
 * keeps the verdict recorded at run time.
 */
function regrade(rows) {
  const core = new Map(CORE_PHRASES.map((p) => [p.phrase, p]));
  const cov = new Map(COVERAGE_PROBE.map((c) => [c.id, c]));
  const dia = new Map(DIALOGUES.map((d) => [d.id, d]));
  const cap = new Map(CAPABILITY_ITEMS.map((c) => [c.id, c]));
  // A run started with --replace supersedes earlier runs of the same
  // provider/model/variant for the suites it covers.
  const key = (r) => `${r.provider}:${r.model}#${r.variant || ''}`;
  const runs = rows.filter((r) => r.type === 'run');
  const superseded = new Set();
  for (const r of runs.filter((x) => x.replace)) {
    for (const older of runs) {
      if (older.at < r.at && key(older) === key(r)) superseded.add(`${older.runId}|${(r.suites || []).join(',')}`);
    }
  }
  const isSuperseded = (row) => [...superseded].some((s) => {
    const [runId, suites] = s.split('|');
    return runId === row.runId && suites.split(',').includes(row.suite);
  });
  return rows.filter((row) => row.type !== 'turn' || !isSuperseded(row)).map((row) => {
    if (row.type !== 'turn') return row;
    if (row.suite === 'dialogue' && dia.has(row.phraseId)) {
      return { ...row, gradeAtRun: row.grade, grade: gradeDialogue(dia.get(row.phraseId), [row.turn1?.calls || [], row.calls || []]) };
    }
    if (row.suite === 'core' && core.has(row.phraseId)) {
      return { ...row, gradeAtRun: row.grade, grade: gradeCore(core.get(row.phraseId), row.calls || []) };
    }
    if (row.suite === 'coverage' && cov.has(row.phraseId)) {
      const item = cov.get(row.phraseId);
      return {
        ...row,
        gradeAtRun: row.grade,
        grade: gradeCoverage(item, row.calls || [], row.text, BASELINE_TOOLS),
        gradeV2: gradeCoverage(coverageRubric(item, 'v2'), row.calls || [], row.text, GEV_REALTIME_TOOLS),
      };
    }
    if (row.suite === 'capability' && cap.has(row.phraseId)) {
      const c = cap.get(row.phraseId);
      const grade = c.dialogue ? gradeDialogue(c.dialogue, [row.turn1?.calls || [], row.calls || []]) : gradeCore(c.phrase, row.calls || []);
      return { ...row, gradeAtRun: row.grade, grade };
    }
    return row;
  });
}

function readRowsFrom(dir) {
  const file = path.join(dir, 'results.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

function writeSummary() {
  const summary = summarize(regrade(readRows()));
  // --compare <dir> (remembered in compare-with.txt): a before → after table
  // against another run folder, both re-graded with the current grader.
  const compareFile = path.join(OUT, 'compare-with.txt');
  if (has('--compare')) fs.writeFileSync(compareFile, `${path.resolve(ROOT, opt('--compare', ''))}\n`);
  let comparison = '';
  if (fs.existsSync(compareFile)) {
    const beforeDir = fs.readFileSync(compareFile, 'utf8').trim();
    const before = summarize(regrade(readRowsFrom(beforeDir)));
    const beforeHead = readRowsFrom(beforeDir).find((r) => r.type === 'run' && r.prompt?.gitHead)?.prompt?.gitHead || '4b56d0e9';
    const afterHead = readRows().find((r) => r.type === 'run' && r.prompt?.gitHead)?.prompt?.gitHead || '?';
    comparison = renderComparison(before, summary, {
      beforeLabel: `${path.relative(ROOT, beforeDir)} (prompt/tools @ ${beforeHead})`,
      afterLabel: `${path.relative(ROOT, OUT)} (prompt/tools @ ${afterHead})`,
    });
    summary.comparison = { beforeDir: path.relative(ROOT, beforeDir), before: before.models.map((m) => ({ key: m.key, coreFull: m.core.fullCallAccuracyPct, coverageV1Pct: m.coverage.acceptablePct, hcV1: m.coverage.counts['hallucinated-capability'], dialogueT2: m.dialogue.turn2FullPct, toolCallP50: m.latencyMs.toolCallP50, promptTokens: m.warmup?.promptTokens ?? m.tokens.inputPerRequestMean })) };
    fs.writeFileSync(path.join(OUT, 'comparison.md'), `${comparison}\n`);
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  const md = renderMarkdown(summary, { notes: readNotes(), payload: payloadChanges() });
  fs.writeFileSync(path.join(OUT, 'summary.md'), comparison ? md.replace('## Routing accuracy', `${comparison}\n## Routing accuracy`) : md);
  return summary;
}
/** Exactly what each provider receives differently from production's payload. */
function payloadChanges() {
  const chat = chatNormalizationDiff(GEV_REALTIME_TOOLS)
    .map((c) => `\`${c.path}\`: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  return [
    `openai-realtime: none — the session body is captured from production's token handler (${GEV_REALTIME_TOOLS.length} tools, instructions, tool_choice auto, reasoning low, truncation). Only difference from a mic session: response.create asks for output_modalities ["text"] (as qa-voice-routing does).`,
    'gemini-live: same instructions text as systemInstruction; the same tool schemas passed verbatim as functionDeclarations[].parametersJsonSchema (no keyword changes); tool_choice has no Live equivalent (AUTO is the default); responseModalities AUDIO + outputAudioTranscription (TEXT is rejected by the model).',
    `ollama / openai-chat: same instructions as the system message; tools wrapped as {type:"function",function:{name,description,parameters}} with ${chat.length} schema change(s): ${chat.join('; ') || 'none'}. Descriptions, enums and required lists are unchanged; nothing is stringified.`,
  ];
}

function ledgerSpent() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')).spentUsd || 0; } catch { return 0; }
}
function ledgerAdd(usd) {
  const spent = ledgerSpent() + usd;
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify({ spentUsd: spent, updatedAt: new Date().toISOString() }));
  return spent;
}
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim(); } catch { return null; }
};

/** Snapshot of what else is using the machine (GPU-heavy servers, load). */
function machineSnapshot() {
  const load = os.loadavg().map((x) => x.toFixed(2)).join(' ');
  const ollamaPs = sh('ollama', ['ps']);
  const procs = sh('ps', ['-Ao', 'pcpu=,rss=,comm=']) || '';
  const heavy = procs.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => Number(p[0]) > 20)
    .map((p) => `${path.basename(p.slice(2).join(' '))} ${p[0]}%cpu`).slice(0, 6);
  const gpuServers = procs.split('\n').filter((l) => /ollama runner|llama-server|LM Studio|lms|mlx|whisper/i.test(l))
    .map((l) => path.basename(l.trim().split(/\s+/).slice(2).join(' '))).slice(0, 6);
  return {
    at: new Date().toISOString(),
    loadavg: load,
    ollamaPs,
    busyProcesses: heavy,
    modelServers: gpuServers,
    summary: `load ${load}; busy: ${heavy.join(', ') || 'none'}`,
  };
}

// ── Ollama lifecycle ────────────────────────────────────────────────────────

const OLLAMA = opt('--base', 'http://localhost:11434').replace(/\/v1\/?$/, '');

async function ollamaUnloadAll() {
  const ps = await fetch(`${OLLAMA}/api/ps`).then((r) => r.json()).catch(() => ({ models: [] }));
  for (const m of ps.models || []) {
    await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }) }).then((r) => r.text()).catch(() => null);
  }
  return (ps.models || []).map((m) => m.name);
}

async function ollamaLoad(model, numCtx) {
  const t = Date.now();
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model, keep_alive: '30m', options: { num_ctx: numCtx } }),
    signal: AbortSignal.timeout(600_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`load failed: ${body.error || res.status}`);
  return { wallMs: Date.now() - t, loadMs: body.load_duration ? body.load_duration / 1e6 : null };
}

// ── Main ────────────────────────────────────────────────────────────────────

function buildAdapter() {
  const temperature = Number(opt('--temperature', '0.8'));
  switch (PROVIDER) {
    case 'openai-realtime':
      return createOpenAiRealtimeAdapter({ model: MODEL });
    case 'gemini-live':
      return createGeminiLiveAdapter({ model: MODEL, schemaMode: opt('--gemini-schema', 'jsonSchema') });
    case 'ollama':
      return createOllamaAdapter({ model: MODEL, baseUrl: OLLAMA, temperature, numCtx: Number(opt('--num-ctx', '32768')), think: has('--think') });
    case 'openai-chat':
      return createOpenAiChatAdapter({ model: MODEL, baseUrl: opt('--base', 'http://localhost:1234/v1'), temperature });
    default:
      throw new Error(`unknown --provider ${PROVIDER}`);
  }
}

const COLD_PHRASE = 'Take me to Tokyo';

/** Capability suite: single phrases (optional pointer context) and dialogues. */
const CAPABILITY_ITEMS = CAPABILITY_EXTRAS.map((c) => (c.turns
  ? { suite: 'capability', id: c.id, text: c.turns.join(' → '), dialogue: c }
  : { suite: 'capability', id: c.context ? `${c.phrase} [pointer]` : c.phrase, text: c.phrase, phrase: c, context: c.context || null }));

/** The 4b56d0e9 tool schema, for grading coverage by the original yardstick. */
const BASELINE_TOOLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'voice-bench', 'baseline-tools-4b56d0e9.json'), 'utf8'));

/** What prompt this run actually sent (so before/after runs are identifiable). */
function promptVersion() {
  let head = null;
  try { head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  return {
    gitHead: head,
    tools: GEV_REALTIME_TOOLS.length,
    toolJsonChars: JSON.stringify(GEV_REALTIME_TOOLS).length,
    instructionsChars: realtimeInstructions().length,
  };
}

function workList() {
  const items = [];
  if (SUITES.includes('core')) {
    for (const p of CORE_PHRASES) items.push({ suite: 'core', id: p.phrase, text: p.phrase, phrase: p });
  }
  if (SUITES.includes('coverage')) {
    for (const c of COVERAGE_PROBE) items.push({ suite: 'coverage', id: c.id, text: c.utterance, item: c });
  }
  if (SUITES.includes('dialogue')) {
    for (const d of DIALOGUES) items.push({ suite: 'dialogue', id: d.id, text: d.turns.join(' → '), dialogue: d });
  }
  if (SUITES.includes('capability')) items.push(...CAPABILITY_ITEMS);
  return items.filter((w) => !ONLY || w.text.toLowerCase().includes(ONLY.toLowerCase()));
}

async function main() {
  if (has('--note')) {
    const notes = readNotes();
    notes.push(opt('--note', ''));
    fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
  }
  if (has('--summarize') || !PROVIDER) {
    writeSummary();
    console.log(`summary written to ${path.join(OUT, 'summary.md')}`);
    return;
  }
  if (!MODEL) throw new Error('--model is required');
  const adapter = buildAdapter();
  await adapter.open();

  let warmup = null;
  if (PROVIDER === 'ollama') {
    const unloaded = await ollamaUnloadAll();
    const numCtx = Number(opt('--num-ctx', '32768'));
    const load = await ollamaLoad(MODEL, numCtx);
    // COLD turn: the first request after load pays the full-prompt prefill.
    // It is recorded separately (warmup.cold*) and primes the prefix cache
    // the way a live session's first turn would; every benchmark turn after
    // it is steady state.
    const w = await adapter.runTurn({ text: COLD_PHRASE, onCall: () => ({ ok: true }) });
    warmup = { unloaded, loadWallMs: load.wallMs, loadMs: load.loadMs, coldPhrase: COLD_PHRASE, prefillTokS: w.local.prefillTokS, promptTokens: w.local.promptEvalCount, coldFirstTokenMs: w.tFirstTokenMs, coldToolCallMs: w.tFirstCallMs, coldCalls: w.calls.map((c) => c.name), warmupTurnMs: w.tDoneMs, errors: w.errors };
    console.log(`warm-up: load ${Math.round(load.wallMs)}ms, prefill ${Math.round(w.local.prefillTokS || 0)} tok/s over ${w.local.promptEvalCount} tokens`);
    if (w.errors.length) console.log(`  warm-up errors: ${w.errors.join('; ')}`);
  } else if (PROVIDER === 'openai-chat') {
    const w = await adapter.runTurn({ text: COLD_PHRASE, onCall: () => ({ ok: true }) });
    warmup = { loadMs: Number(opt('--load-ms', 'NaN')) || null, coldPhrase: COLD_PHRASE, prefillTokS: w.local.prefillTokS, promptTokens: w.local.promptEvalCount, coldFirstTokenMs: w.tFirstTokenMs, coldToolCallMs: w.tFirstCallMs, coldCalls: w.calls.map((c) => c.name), warmupTurnMs: w.tDoneMs, errors: w.errors };
    console.log(`warm-up: ${w.tDoneMs}ms prefill≈${Math.round(w.local.prefillTokS || 0)} tok/s`);
    if (w.errors.length) throw new Error(`warm-up failed, not benchmarking: ${w.errors[0]}`);
  }

  const runId = `${Date.now().toString(36)}`;
  const machine = CLOUD ? null : machineSnapshot();
  appendRow({ type: 'run', runId, at: new Date().toISOString(), provider: PROVIDER, model: MODEL, variant: VARIANT, reps: REPS, suites: SUITES, settings: adapter.settings, machine, warmup, replace: has('--replace'), prompt: promptVersion(), methodology: 'fresh context per phrase/dialogue; stub tool results (canned results for dialogue turn 1); ≤4 continuations' });

  const items = workList();
  let stopReason = null;
  let turnCosts = [];
  outer: for (let rep = START_REP; rep < START_REP + REPS; rep += 1) {
    console.log(`\n== ${PROVIDER} ${MODEL}${VARIANT ? ` (${VARIANT})` : ''} — rep ${rep}/${REPS}, ${items.length} phrases`);
    for (const w of items) {
      if (CLOUD) {
        const avg = turnCosts.length ? turnCosts.reduce((a, b) => a + b, 0) / turnCosts.length : 0.1;
        if (ledgerSpent() + avg > BUDGET) { stopReason = `cloud budget $${BUDGET} reached (ledger $${ledgerSpent().toFixed(2)})`; break outer; }
      }
      let r;
      let turn1 = null;
      let grade;
      if (w.dialogue) {
        const rs = await adapter.runDialogue({
          turns: w.dialogue.turns,
          onCall: (c, turn) => dialogueResult(w.dialogue, c.name, turn) ?? stubResult('core', c, GEV_REALTIME_TOOLS),
        });
        const [a, b] = rs;
        turn1 = { text: a.text.slice(0, 400), calls: a.calls, tFirstCallMs: a.tFirstCallMs, tDoneMs: a.tDoneMs, errors: a.errors };
        r = {
          ...b,
          errors: [...a.errors, ...b.errors],
          timeout: a.timeout || b.timeout,
          costUsd: a.costUsd + b.costUsd,
          usage: Object.fromEntries(Object.keys(b.usage).map((k) => [k, (a.usage[k] || 0) + (b.usage[k] || 0)])),
          setupMs: a.setupMs,
        };
        grade = gradeDialogue(w.dialogue, [a.calls, b.calls]);
      } else {
        r = await adapter.runTurn({ text: w.text, context: w.context || undefined, onCall: (c) => stubResult(w.suite, c, GEV_REALTIME_TOOLS) });
        grade = w.suite === 'coverage' ? gradeCoverage(w.item, r.calls, r.text, GEV_REALTIME_TOOLS) : gradeCore(w.phrase, r.calls);
      }
      const row = {
        type: 'turn', runId, provider: PROVIDER, model: MODEL, variant: VARIANT, cloud: CLOUD, rep, suite: w.suite,
        phraseId: w.id, phrase: w.text,
        expect: w.dialogue ? `t1 ${expectLabel(w.dialogue.first)} → t2 ${expectLabel(w.dialogue.second)}` : w.suite === 'coverage' ? w.item.expect : expectLabel(w.phrase),
        context: w.context || undefined,
        expectNone: Boolean(w.phrase?.expectNone), supported: w.item ? w.item.supported : undefined,
        calls: r.calls, text: r.text.slice(0, 800), grade, turn1: turn1 || undefined,
        tFirstTokenMs: r.tFirstTokenMs, tFirstCallMs: r.tFirstCallMs, tDoneMs: r.tDoneMs, setupMs: r.setupMs,
        responses: r.responses, usage: r.usage, costUsd: r.costUsd, errors: r.errors, timeout: r.timeout,
        local: r.local || undefined,
        at: new Date().toISOString(),
      };
      appendRow(row);
      if (CLOUD) { ledgerAdd(r.costUsd); turnCosts.push(r.costUsd); }
      const verdict = w.suite === 'coverage' ? grade.verdict : (grade.ok ? 'PASS' : 'FAIL');
      console.log(`  [${verdict}] ${w.text} → ${turn1 ? `${turn1.calls.map((c) => c.name).join(',') || '(none)'} ⇒ ` : ''}${r.calls.map((c) => c.name).join(',') || '(none)'}  tool@${r.tFirstCallMs ?? '—'}ms done@${r.tDoneMs}ms $${r.costUsd.toFixed(4)}${r.errors.length ? ` ERR ${r.errors[0]}` : ''}${r.timeout ? ' TIMEOUT' : ''}`);
      if (r.errors.some((e) => /HTTP 4\d\d|close 100[78]|invalid|not found|model_not_found|does not exist/i.test(e)) && r.calls.length === 0 && !r.text) {
        const same = readRows().filter((x) => x.type === 'turn' && x.runId === runId).slice(-3);
        if (same.length === 3 && same.every((x) => x.errors?.length && !x.calls.length)) { stopReason = `3 consecutive hard errors: ${r.errors[0]}`; break outer; }
      }
    }
    writeSummary();
  }
  await adapter.close();
  if (PROVIDER === 'ollama' && !has('--keep-loaded')) {
    await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: MODEL, keep_alive: 0 }) }).catch(() => null);
  }
  if (stopReason) {
    console.log(`STOPPED: ${stopReason}`);
    appendRow({ type: 'stop', runId, provider: PROVIDER, model: MODEL, reason: stopReason, at: new Date().toISOString() });
  }
  const summary = writeSummary();
  const mine = summary.models.find((m) => m.provider === PROVIDER && m.model === MODEL && (m.variant || null) === (VARIANT || null));
  if (mine) console.log(`\n${mine.key}: core ${mine.core.accuracyPct}% | coverage acceptable ${mine.coverage.acceptablePct}% | p50 tool ${mine.latencyMs.toolCallP50}ms | $${mine.costUsd}`);
  console.log(`results: ${RESULTS}\nsummary: ${path.join(OUT, 'summary.md')}\ncloud ledger: $${ledgerSpent().toFixed(3)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
