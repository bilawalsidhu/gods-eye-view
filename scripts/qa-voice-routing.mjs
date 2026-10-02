#!/usr/bin/env node
/**
 * qa-voice-routing.mjs — voice-surface QA harness (overnight 2026-07-27).
 *
 * Two independent layers:
 *
 *  LAYER 1 — ROUTING (costs model turns, budget-capped):
 *    Sends TEXT turns through a real OpenAI Realtime session minted by the
 *    app's own /api/realtime/token endpoint — so the instructions + tool defs
 *    under test are the PRODUCTION config, not a copy. Asserts which tool the
 *    model calls for each phrase (plus a few critical-arg spot checks).
 *    Batches phrases per session (fresh-ish context, amortized mints), hard
 *    budget on model turns, JSONL evidence log per run.
 *
 *  LAYER 2 — BEHAVIOR (free, deterministic, no model):
 *    Drives window.__gevVoiceCommands.runner(toolName, args) in a headless
 *    page against the dev server and asserts world state via __godsEyeView /
 *    __gevAnnotations (camera altitude bands, annotation counts, route
 *    geometry, framing modes). This is the instrument that later gates new
 *    tools (analyst queries, camera verbs) without anyone speaking.
 *
 * Usage:
 *   node scripts/qa-voice-routing.mjs                 # both layers, :4415
 *   node scripts/qa-voice-routing.mjs --layer routing --budget 120
 *   node scripts/qa-voice-routing.mjs --layer behavior --url http://localhost:4173
 *   node scripts/qa-voice-routing.mjs --layer behavior --deixis-only --headful --shots qa-shots/point-and-ask
 *   node scripts/qa-voice-routing.mjs --layer deixis --budget 12      # pointer_context routing (model turns)
 *   node scripts/qa-voice-routing.mjs --layer deixis-live --url ...   # in-app text turns (model turns)
 *
 * House gotchas honored: camera.cancelFlight() before every teleport; puppeteer
 * suites must run sequentially with other harnesses (SwiftShader saturation);
 * routing assertions pin tool NAMES (model wording varies, tool choice must not).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import puppeteer from 'puppeteer';
import { ROUTING_PHRASES } from './voice-bench/phrases.mjs';
import { gradeCore, expectLabel } from './voice-bench/grade.mjs';
import { countWords, findHedges } from '../src/voice/speechLint.js';
import { buildPointerSnapshot, pointerContextItem } from '../src/voice/pointerContext.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  await puppeteer.executablePath().catch(() => null),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const CHROME_EXECUTABLE = CHROME_CANDIDATES.find((candidate) => {
  try { return fs.existsSync(candidate); } catch { return false; }
});

// ── CLI ─────────────────────────────────────────────────────
function getOpt(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP_URL = getOpt('--url', 'http://localhost:4415');
const LAYER = getOpt('--layer', 'all'); // routing | behavior | all | deixis | deixis-live
const TURN_BUDGET = Number(getOpt('--budget', '120'));
const PHRASES_PER_SESSION = Number(getOpt('--batch', '6'));
const ONLY = getOpt('--only', null); // substring filter on phrase text
const DEIXIS_ONLY = process.argv.includes('--deixis-only'); // behavior: point-and-ask block only
const HEADFUL = process.argv.includes('--headful'); // real GPU, visible window
const SHOT_DIR = getOpt('--shots', null); // point-and-ask evidence screenshots

// ── Reporting ───────────────────────────────────────────────
let pass = 0, fail = 0, skip = 0;
const failures = [];
function report(ok, label, detail) {
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${label}  — ${detail}`);
  if (ok) pass += 1; else { fail += 1; failures.push({ label, detail }); }
}
function skipped(label, detail) {
  console.log(`  [\x1b[33mSKIP\x1b[0m] ${label}  — ${detail}`);
  skip += 1;
}

// ════════════════════════════════════════════════════════════
// LAYER 1 — ROUTING
// ════════════════════════════════════════════════════════════

// Phrase table + grading live in scripts/voice-bench/ (shared with the
// provider-neutral benchmark, qa-voice-bench.mjs). See phrases.mjs for the
// expect / oneOf / expectNone / args / argsByTool semantics.
const PHRASES = ROUTING_PHRASES;

/** Mint a session via the app's own endpoint. */
async function mintSession() {
  const res = await fetch(`${APP_URL}/api/realtime/token`, { method: 'POST' });
  if (!res.ok) throw new Error(`token mint failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
  const body = await res.json();
  const value = body?.value || body?.client_secret?.value;
  const model = body?.session?.model || 'gpt-realtime';
  if (!value) throw new Error(`token mint returned no client secret: ${JSON.stringify(body).slice(0, 160)}`);
  return { value, model };
}

/** One Realtime WS session that can run several text turns sequentially. */
class RoutingSession {
  constructor(secret, model, evidence) {
    this.secret = secret;
    this.model = model;
    this.evidence = evidence;
    this.ws = null;
    this.pending = null; // active turn collector
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.secret}` } });
      const timer = setTimeout(() => reject(new Error('ws connect timeout')), 15000);
      ws.on('open', () => { clearTimeout(timer); this.ws = ws; resolve(); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('message', (raw) => this.onMessage(raw));
    });
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    this.evidence.write(`${JSON.stringify({ at: new Date().toISOString(), dir: 'recv', type: msg.type, item: msg.item?.type, name: msg.item?.name ?? msg.name, error: msg.error?.message })}\n`);
    if (!this.pending) return;
    if (msg.type === 'response.output_item.done' && msg.item?.type === 'message') {
      // Speech stats only: text said before a call in the same response is a
      // preamble; text after the last call is the spoken answer.
      const text = (msg.item.content || []).map((part) => part?.text ?? part?.transcript ?? '').join(' ').trim();
      if (text) this.pending.messages.push({ text, response: this.pending.continuations, callsBefore: this.pending.calls.length });
    }
    if (msg.type === 'response.output_item.done' && msg.item?.type === 'function_call') {
      this.pending.callResponses.push(this.pending.continuations);
      let parsed = {};
      try { parsed = JSON.parse(msg.item.arguments || '{}'); } catch { /* keep {} */ }
      this.pending.calls.push({ name: msg.item.name, args: parsed });
      // Feed a neutral tool result (item.create is legal mid-response); the
      // continuation response is requested ONLY after response.done — sending
      // response.create while a response is active is an API error (the
      // pilot's failure mode).
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: msg.item.call_id,
          output: JSON.stringify(this.stubResult || { ok: true, note: 'qa-harness stub result' }),
        },
      });
      this.pending.needContinuation = true;
    }
    if (msg.type === 'response.done') {
      if (this.pending.needContinuation && this.pending.continuations < 4) {
        this.pending.needContinuation = false;
        this.pending.continuations += 1;
        this.send({ type: 'response.create', response: { output_modalities: ['text'] } });
        return;
      }
      const p = this.pending;
      this.pending = null;
      p.resolve(p.calls);
      this.lastTurn = p;
    }
    if (msg.type === 'error') {
      // Log-and-continue: a per-turn API hiccup should surface as that turn's
      // result, not poison the batch. The turn resolves with what it has.
      this.pending.errors.push(msg.error?.message || 'realtime error');
    }
  }

  send(obj) {
    this.evidence.write(`${JSON.stringify({ at: new Date().toISOString(), dir: 'send', type: obj.type })}\n`);
    this.ws.send(JSON.stringify(obj));
  }

  /** An inert system item (the app's notifyMapEvent shape), e.g. pointer_context. */
  sendSystemItem(payload) {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: JSON.stringify(payload) }] },
    });
  }

  /** Send one user text turn; resolve with the list of tool calls it produced. */
  runTurn(text) {
    return new Promise((resolve) => {
      this.pending = { calls: [], messages: [], callResponses: [], continuations: 0, needContinuation: false, errors: [], resolve };
      const timer = setTimeout(() => {
        if (this.pending) { const p = this.pending; this.pending = null; p.resolve(p.calls); }
      }, 45000);
      const origResolve = resolve;
      this.pending.resolve = (v) => { clearTimeout(timer); origResolve(v); };
      this.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
      this.send({ type: 'response.create', response: { output_modalities: ['text'] } });
    });
  }

  close() { try { this.ws?.close(); } catch { /* noop */ } }
}

async function runRoutingLayer() {
  console.log(`\nLAYER 1 — routing assertions (budget ${TURN_BUDGET} model turns)`);
  const logDir = path.join(ROOT, '.gev-logs', 'qa-voice-routing');
  fs.mkdirSync(logDir, { recursive: true });
  const evidence = fs.createWriteStream(path.join(logDir, `run-${Date.now()}.jsonl`));

  const list = PHRASES.filter((p) => !ONLY || p.phrase.toLowerCase().includes(ONLY.toLowerCase()));
  let turnsUsed = 0;

  for (let i = 0; i < list.length; i += PHRASES_PER_SESSION) {
    if (turnsUsed >= TURN_BUDGET) {
      list.slice(i).forEach((p) => skipped(`route: "${p.phrase}"`, 'turn budget exhausted'));
      break;
    }
    const batch = list.slice(i, i + PHRASES_PER_SESSION);
    let session;
    try {
      const { value, model } = await mintSession();
      session = new RoutingSession(value, model, evidence);
      await session.connect();
    } catch (e) {
      batch.forEach((p) => report(false, `route: "${p.phrase}"`, `session setup failed: ${e.message}`));
      continue;
    }
    for (const p of batch) {
      if (turnsUsed >= TURN_BUDGET) { skipped(`route: "${p.phrase}"`, 'turn budget exhausted'); continue; }
      turnsUsed += 1;
      let calls = [];
      try {
        calls = await session.runTurn(p.phrase);
      } catch (e) {
        report(false, `route: "${p.phrase}"`, `turn error: ${e.message}`);
        continue;
      }
      recordSpeech(p.phrase, calls.map((c) => c.name), session.lastTurn);
      const grade = gradeCore(p, calls);
      report(grade.ok, `route: "${p.phrase}" → ${expectLabel(p)}`, grade.detail);
    }
    session.close();
  }
  evidence.end();
  console.log(`  routing turns used: ${turnsUsed}/${TURN_BUDGET}`);
  summarizeSpeech(logDir);
}

// ════════════════════════════════════════════════════════════
// LAYER 1b — DEIXIS ROUTING (costs model turns)
// ════════════════════════════════════════════════════════════
//
// Point-and-ask phrases against the production instructions and tools. Each
// scenario runs in its own fresh session: a pointer_context item built by the
// app's own formatter lands first (exactly what the client sends at speech
// start), then the user's words. Asserts the model passes the 'pointer'
// sentinel (or referent:n) instead of guessing coordinates or names.

const AIRCRAFT_POINTER = pointerContextItem(buildPointerSnapshot({
  at: 'speech_start', x: 912, y: 388, width: 1500, height: 950,
  pick: {
    entity: { layerId: 'flights', id: 'a4f2c1', label: 'UPS793', kind: 'aircraft', lat: 30.3121, lon: -97.6013 },
    ground: { lat: 30.3, lon: -97.6 },
  },
}));
const GROUND_POINTER = pointerContextItem(buildPointerSnapshot({
  at: 'speech_start', x: 640, y: 520, width: 1500, height: 950,
  pick: { entity: null, ground: { lat: 30.2849, lon: -97.7341, heightM: 160 } },
}));
const FRAMED_STUB = {
  ok: true,
  action: 'frame_overhead',
  layerId: 'flights',
  count: 3,
  say: 'Framed 3 aircraft within 150 km.',
  display: { title: '3 aircraft in frame' },
  referents: [
    { n: 1, id: 'a11111', label: 'SWA1445', layerId: 'flights' },
    { n: 2, id: 'a22222', label: 'UPS793', layerId: 'flights' },
    { n: 3, id: 'a33333', label: 'AAL2231', layerId: 'flights' },
  ],
};

const pointerArg = (value) => String(value || '').toLowerCase() === 'pointer';
const DEIXIS_SCENARIOS = [
  { pointer: AIRCRAFT_POINTER, phrase: 'Tell me about this', check: (c) => c.name === 'get_entity_context' && pointerArg(c.args.scope), want: 'get_entity_context{scope:pointer}' },
  { pointer: AIRCRAFT_POINTER, phrase: "What's that plane?", check: (c) => c.name === 'get_entity_context' && pointerArg(c.args.scope), want: 'get_entity_context{scope:pointer}' },
  { pointer: AIRCRAFT_POINTER, phrase: 'Track that one', check: (c) => c.name === 'track_entity' && (pointerArg(c.args.query) || /a4f2c1|ups793/i.test(c.args.query || '')), want: 'track_entity{query:pointer}' },
  { pointer: GROUND_POINTER, phrase: 'How many flights are around here?', check: (c) => c.name === 'analyst_query' && pointerArg(c.args.scope?.kind), want: 'analyst_query{scope.kind:pointer}' },
  { pointer: GROUND_POINTER, phrase: 'Take me there', check: (c) => c.name === 'fly_to_location' && pointerArg(c.args.query), want: 'fly_to_location{query:pointer}' },
  { pointer: GROUND_POINTER, phrase: 'Drop a pin right here', check: (c) => c.name === 'annotate_map' && (c.args.annotations || []).some((a) => pointerArg(a.target)), want: 'annotate_map{target:pointer}' },
  { pointer: GROUND_POINTER, phrase: 'What is this place?', check: (c) => c.name === 'get_entity_context' && pointerArg(c.args.scope), want: 'get_entity_context{scope:pointer}' },
  // Open mic / typed turns: the model only learns that something is pointed at.
  { pointer: { type: 'pointer_context', at: 'speech_start', pointing: 'aircraft' }, phrase: "What's that?", check: (c) => c.name === 'get_entity_context' && pointerArg(c.args.scope), want: 'get_entity_context{scope:pointer} (pointing:aircraft)' },
  { pointer: { type: 'pointer_context', at: 'speech_start', pointing: 'ground' }, phrase: 'How many flights are around here?', check: (c) => c.name === 'analyst_query' && pointerArg(c.args.scope?.kind), want: 'analyst_query{scope.kind:pointer} (pointing:ground)' },
  { pointer: { type: 'pointer_context', at: 'speech_start', pointing: 'aircraft' }, phrase: 'Follow that one', check: (c) => c.name === 'track_entity' && pointerArg(c.args.query), want: 'track_entity{query:pointer} (pointing:aircraft)' },
  // A named place wins over the pointer.
  { pointer: GROUND_POINTER, phrase: 'How many flights are over Texas right now?', check: (c) => c.name === 'analyst_query' && !pointerArg(c.args.scope?.kind), want: 'analyst_query not pointer (named place)' },
  // No pointer_context: the model may still pass the sentinel (observed); the
  // runner then falls back to scope auto, so only the tool choice is pinned.
  { pointer: null, phrase: 'Tell me about this', check: (c) => c.name === 'get_entity_context', want: 'get_entity_context (runner falls back to auto)' },
  // Referents: a numbered list, then "the second one".
  { setup: { phrase: 'Frame the aircraft near us', stub: FRAMED_STUB }, pointer: null, phrase: 'Track the second one', check: (c) => c.name === 'track_entity' && (c.args.referent === 2 || /ups793|a22222/i.test(c.args.query || '')), want: 'track_entity{referent:2}' },
];

async function runDeixisRoutingLayer() {
  console.log(`\nLAYER 1b — deixis routing (budget ${TURN_BUDGET} model turns)`);
  const logDir = path.join(ROOT, '.gev-logs', 'qa-voice-routing');
  fs.mkdirSync(logDir, { recursive: true });
  const evidence = fs.createWriteStream(path.join(logDir, `deixis-${Date.now()}.jsonl`));
  let turnsUsed = 0;
  let referentUse = 0;
  for (const scenario of DEIXIS_SCENARIOS) {
    const where = !scenario.pointer ? 'no pointer' : scenario.pointer.pointing ? `pointing ${scenario.pointer.pointing}` : scenario.pointer.target ? scenario.pointer.target.label : 'ground';
    const label = `deixis route: [${where}] "${scenario.phrase}" → ${scenario.want}`;
    const cost = scenario.setup ? 2 : 1;
    if (turnsUsed + cost > TURN_BUDGET) { skipped(label, 'turn budget exhausted'); continue; }
    let session;
    try {
      const { value, model } = await mintSession();
      session = new RoutingSession(value, model, evidence);
      await session.connect();
    } catch (e) {
      report(false, label, `session setup failed: ${e.message}`);
      continue;
    }
    try {
      if (scenario.setup) {
        turnsUsed += 1;
        session.stubResult = scenario.setup.stub;
        await session.runTurn(scenario.setup.phrase);
        session.stubResult = null;
      }
      if (scenario.pointer) session.sendSystemItem(scenario.pointer);
      turnsUsed += 1;
      const calls = await session.runTurn(scenario.phrase);
      const hit = calls.find(scenario.check);
      if (hit?.args?.referent !== undefined) referentUse += 1;
      report(Boolean(hit), label, `called: ${calls.map((c) => `${c.name}${JSON.stringify(c.args)}`).join(' ').slice(0, 220) || '(none)'}`);
    } catch (e) {
      report(false, label, `turn error: ${e.message}`);
    } finally {
      session.close();
    }
  }
  evidence.end();
  console.log(`  deixis routing turns used: ${turnsUsed}/${TURN_BUDGET}; referent:n used ${referentUse}x`);
}

// ════════════════════════════════════════════════════════════
// LAYER 1c — DEIXIS LIVE (in-app text turns; costs model turns)
// ════════════════════════════════════════════════════════════
//
// The whole loop in the real app: a synthetic pointer on the live canvas, a
// real Realtime session (push-to-talk mode, so the fake microphone stays
// muted), a typed turn, the model's tool call, the runner's resolution and
// the tool result — observed through the session's own events.

async function runDeixisLiveLayer() {
  console.log('\nLAYER 1c — deixis live (in-app text turns)');
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(HEADFUL ? [] : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1500,950',
    ],
    protocolTimeout: 180000,
  });
  const appUrl = new URL(APP_URL);
  appUrl.searchParams.set('welcome', '0');
  await browser.defaultBrowserContext().overridePermissions(appUrl.origin, ['microphone']);
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (name, args) => page.evaluate(
    (n, a) => Promise.resolve(window.__gevVoiceCommands.runner(n, a)).catch((e) => ({ ok: false, error: String(e?.message || e) })),
    name, args,
  );
  let turnsUsed = 0;
  try {
    await page.goto(appUrl.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__godsEyeView?.viewer && window.__gevVoiceCommands?.session, { timeout: 120000, polling: 250 });
    await page.evaluate(() => window.__godsEyeView.viewer.camera.cancelFlight());
    await run('fly_to_location', { query: 'Austin, Texas' });
    await settle(9000);
    await run('set_layer_visibility', { layerId: 'flights', enabled: true });
    await settle(40000);
    await run('frame_overhead', { target: 'flights' });
    await settle(7000);
    await page.evaluate(() => {
      window.__qaEvents = [];
      window.__gevVoiceCommands.session.subscribe((event) => {
        window.__qaEvents.push({
          type: event.type,
          name: event.name || null,
          state: event.state || null,
          args: event.arguments || null,
          result: event.result
            ? { ok: event.result.ok, error: event.result.error || null, say: event.result.say ?? null, resolvedFrom: event.result.resolvedFrom || null, selectedId: event.result.selected?.id || null, scopeLabel: event.result.scopeLabel || null, label: event.result.label || null }
            : null,
          text: event.type === 'transcript' && event.final ? event.text : null,
          role: event.role || null,
        });
      });
      return window.__gevVoiceCommands.session.start({ pushToTalk: true });
    });
    await page.waitForFunction(() => window.__gevVoiceCommands.status === 'listening', { timeout: 45000, polling: 250 });

    // The pointer moves and the text is sent in one step, as when someone
    // points and types: typed turns count only a pointer moved in the last
    // few seconds.
    const turn = async (text, point = null) => {
      turnsUsed += 1;
      const from = await page.evaluate(() => window.__qaEvents.length);
      await page.evaluate((t, p) => {
        let at = p;
        if (p?.aircraftId) {
          // Aircraft move: project the contact's live position in this step.
          const { viewer, dataManager } = window.__godsEyeView;
          // The billboard position, which is what the pick hits.
          const found = (dataManager.layers.get('flights')?.module?.getAllPositions?.(3000) || []).find((e) => e.id === p.aircraftId);
          viewer.scene.render();
          at = found?.position ? viewer.scene.cartesianToCanvasCoordinates(found.position) : null;
        }
        if (at) window.__gevVoiceCommands.pointer.moveTo(at.x, at.y);
        window.__gevVoiceCommands.sendTextCommand(t);
      }, text, point);
      // Done when a reply completes after the last tool result (or no tool).
      const deadline = Date.now() + 90000;
      let events = [];
      while (Date.now() < deadline) {
        await settle(500);
        events = await page.evaluate((i) => window.__qaEvents.slice(i), from);
        const lastResult = events.map((e) => e.type).lastIndexOf('action-result');
        const lastCall = events.map((e) => e.type).lastIndexOf('action-call');
        const answered = events.some((e, i) => e.type === 'transcript' && e.role === 'assistant' && e.text && i > lastResult);
        if (answered && lastResult >= lastCall) break;
      }
      return events;
    };
    const summarize = (events) => events.filter((e) => e.type === 'action-call' || e.type === 'action-result')
      .map((e) => (e.type === 'action-call' ? `${e.name}${JSON.stringify(e.args)}` : `→${JSON.stringify(e.result)}`)).join(' ').slice(0, 320);

    const aircraft = await findPickableAircraft(page);
    if (!aircraft) {
      skipped('deixis live: aircraft scenarios', 'no pickable aircraft on screen');
    } else {
      let events = await turn('Tell me about this', { aircraftId: aircraft.id });
      let call = events.find((e) => e.type === 'action-call' && e.name === 'get_entity_context');
      let result = events.find((e) => e.type === 'action-result' && e.name === 'get_entity_context');
      report(
        call?.args?.scope === 'pointer' && result?.result?.selectedId === aircraft.id,
        `deixis live: [${aircraft.label}] "Tell me about this" → the pointed aircraft`,
        summarize(events),
      );
      if (SHOT_DIR) {
        const dir = path.resolve(ROOT, SHOT_DIR);
        fs.mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, 'live-tell-me-about-this.png') });
      }
      events = await turn('Track that one', { aircraftId: aircraft.id });
      result = events.find((e) => e.type === 'action-result' && e.name === 'track_entity');
      report(
        // By the pointer, or by the name the previous answer just gave it.
        result?.result?.ok === true && (result.result.resolvedFrom?.source === 'pointer' || result.result.label === aircraft.label),
        `deixis live: [${aircraft.label}] "Track that one" → tracks it`,
        summarize(events),
      );
      await run('stop_tracking', {});
      await settle(3000);
    }

    const size = await page.evaluate(() => ({ w: window.__godsEyeView.viewer.scene.canvas.clientWidth, h: window.__godsEyeView.viewer.scene.canvas.clientHeight }));
    const events = await turn('How many flights are around here?', { x: size.w * 0.3, y: size.h * 0.62 });
    const result = events.find((e) => e.type === 'action-result' && e.name === 'analyst_query');
    report(
      result?.result?.resolvedFrom?.source === 'pointer' && /within/i.test(result?.result?.scopeLabel || ''),
      'deixis live: [ground] "How many flights are around here?" → radius at the pointer',
      summarize(events),
    );
  } catch (e) {
    report(false, 'deixis live: layer crashed', String(e?.message || e).slice(0, 200));
  } finally {
    try { await page.evaluate(() => window.__gevVoiceCommands?.session?.stop()); } catch { /* closing */ }
    await browser.close();
    console.log(`  deixis live turns used: ${turnsUsed}`);
  }
}

// Speech stats: informational, never pass/fail. Slow tools are the ones whose
// latency justifies a spoken plan; instant ones should answer after the call.
const SLOW_TOOLS = new Set(['annotate_map', 'fly_to_location', 'select_nearest_aircraft', 'analyst_query', 'fly_route', 'frame_overhead']);
const speechTurns = [];
function recordSpeech(phrase, names, turn) {
  if (!turn) return;
  const firstCallResponse = turn.callResponses.length ? Math.min(...turn.callResponses) : null;
  const preamble = turn.messages
    .filter((m) => firstCallResponse !== null && m.response === firstCallResponse && m.callsBefore === 0)
    .map((m) => m.text).join(' ');
  const answer = turn.messages
    .filter((m) => !(firstCallResponse !== null && m.response === firstCallResponse && m.callsBefore === 0))
    .map((m) => m.text).join(' ');
  speechTurns.push({
    phrase,
    tools: names,
    slow: names.some((n) => SLOW_TOOLS.has(n)),
    preamble: preamble || null,
    answer,
    answerWords: countWords(answer),
    preambleWords: countWords(preamble),
    hedges: findHedges(`${preamble} ${answer}`),
  });
}
function summarizeSpeech(logDir) {
  const toolTurns = speechTurns.filter((t) => t.tools.length);
  const slow = toolTurns.filter((t) => t.slow);
  const instant = toolTurns.filter((t) => !t.slow);
  const rate = (list) => (list.length ? `${list.filter((t) => t.preamble).length}/${list.length}` : '0/0');
  const words = speechTurns.map((t) => t.answerWords).sort((a, b) => a - b);
  const summary = {
    turns: speechTurns.length,
    preambleSlow: rate(slow),
    preambleInstant: rate(instant),
    answerWordsP50: words[Math.floor(words.length / 2)] ?? null,
    answerWordsMax: words.at(-1) ?? null,
    answerWordsTotal: words.reduce((a, b) => a + b, 0),
    hedgeHits: speechTurns.reduce((sum, t) => sum + t.hedges.length, 0),
    preambleWordsMax: Math.max(0, ...speechTurns.map((t) => t.preambleWords)),
    spokenWordsTotal: speechTurns.reduce((sum, t) => sum + t.answerWords + t.preambleWords, 0),
  };
  fs.writeFileSync(path.join(logDir, `speech-${Date.now()}.json`), JSON.stringify({ summary, turns: speechTurns }, null, 2));
  console.log(`  speech: preamble slow ${summary.preambleSlow}, instant ${summary.preambleInstant}; answer words p50 ${summary.answerWordsP50}, max ${summary.answerWordsMax}, total ${summary.answerWordsTotal}; preamble words max ${summary.preambleWordsMax}; all spoken words ${summary.spokenWordsTotal}; hedge hits ${summary.hedgeHits}`);
}

// ════════════════════════════════════════════════════════════
// LAYER 2 — BEHAVIOR (runner-driven, no model)
// ════════════════════════════════════════════════════════════

/** An on-screen aircraft whose billboard really answers a pick, or null. */
function findPickableAircraft(page) {
  return page.evaluate(() => {
    const { viewer, dataManager } = window.__godsEyeView;
    const module = dataManager.layers.get('flights')?.module;
    const canvas = viewer.scene.canvas;
    const eye = viewer.camera.positionWC;
    viewer.scene.render();
    let picks = 0;
    const candidates = [];
    for (const entry of module?.getAllPositions?.(3000) || []) {
      // Horizon test: far-side contacts still project onto the canvas.
      const p = entry.position;
      if (eye.x * p.x + eye.y * p.y + eye.z * p.z < 6356000 ** 2) continue;
      const at = viewer.scene.cartesianToCanvasCoordinates(entry.position);
      if (!at || at.x < 60 || at.y < 60 || at.x > canvas.clientWidth - 60 || at.y > canvas.clientHeight - 240) continue;
      candidates.push({ entry, at, d: Math.hypot(at.x - canvas.clientWidth / 2, at.y - canvas.clientHeight * 0.45) });
    }
    // Nearest the middle first: clear of the dock and panels.
    candidates.sort((a, b) => a.d - b.d);
    for (const { entry, at } of candidates) {
      if (++picks > 80) break;
      const picked = viewer.scene.pick(at);
      if (picked?.id === entry.id || picked?.primitive?.id === entry.id)
        return { id: entry.id, label: entry.label, x: at.x, y: at.y };
    }
    return null;
  });
}

/**
 * Point-and-ask behavior (no model): place a synthetic pointer through the
 * public tracker, start a turn the way speech start does, and drive the real
 * runner with the 'pointer' sentinel and referent:n. The pick, reticle and
 * card chip are the product's own.
 */
async function runDeixisBehavior(page, run, settle) {
  const shot = async (name) => {
    if (!SHOT_DIR) return;
    // A backgrounded headful window freezes CSS animation timelines.
    await page.bringToFront();
    const dir = path.resolve(ROOT, SHOT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, name) });
  };
  const beginAt = (x, y, said = null) => page.evaluate((px, py, text) => {
    const voice = window.__gevVoiceCommands;
    if (text) {
      // What the session emits for a spoken turn: a new turn, then the caption.
      voice.emitSessionEvent({ type: 'interruption', reason: 'user-speech' });
      voice.emitSessionEvent({ type: 'transcript', role: 'user', text, final: true });
    }
    voice.pointer.moveTo(px, py);
    // A Space hold: the explicit pointing gesture shows the reticle and chip.
    voice.pointer.hold('keydown');
    const snapshot = voice.beginPointerTurn('keydown');
    voice.pointer.releaseHold();
    const chip = document.getElementById('gev-voice-card-pointer');
    const reticle = document.querySelector('.gev-pointer-reticle');
    return {
      snapshot,
      chipVisible: Boolean(chip && !chip.hidden),
      chipKind: document.getElementById('gev-voice-card-pointer-kind')?.textContent || '',
      chipText: document.getElementById('gev-voice-card-pointer-text')?.textContent || '',
      reticleVisible: Boolean(reticle && !reticle.hidden),
    };
  }, x, y, said);
  const showResult = (name, result) => page.evaluate((n, res) => {
    // The session publishes every runner result to the card this way.
    window.__gevVoiceCommands.emitSessionEvent({ type: 'action-call', name: n, arguments: {} });
    window.__gevVoiceCommands.emitSessionEvent({ type: 'action-result', name: n, result: res });
  }, name, result);

  // D1 — an aircraft under the pointer: find one whose billboard really picks.
  const aircraft = await findPickableAircraft(page);
  if (!aircraft) {
    skipped('deixis: pointer on an aircraft', 'no pickable aircraft on screen right now');
  } else {
    const turn = await beginAt(aircraft.x, aircraft.y, 'Tell me about this');
    report(
      turn.snapshot?.entity?.id === aircraft.id && turn.chipVisible && turn.chipKind === 'THIS' && turn.reticleVisible,
      'deixis: pointer on an aircraft resolves "this" with chip and reticle',
      `entity=${turn.snapshot?.entity?.id}/${turn.snapshot?.entity?.label} expected=${aircraft.id} chip=${turn.chipKind}:${turn.chipText} reticle=${turn.reticleVisible}`,
    );
    await shot('aircraft-reticle-chip.png');
    if (SHOT_DIR) {
      const clip = { x: Math.max(0, aircraft.x - 90), y: Math.max(0, aircraft.y - 90), width: 180, height: 180 };
      await page.screenshot({ path: path.join(path.resolve(ROOT, SHOT_DIR), 'aircraft-reticle-zoom.png'), clip });
    }
    const context = await run('get_entity_context', { scope: 'pointer' });
    report(
      context?.ok === true && context.scope === 'pointer' && context.selected?.id === aircraft.id && Boolean(context.identityLine),
      'deixis: "tell me about this" describes the pointed aircraft',
      `selected=${context?.selected?.id} identityLine=${JSON.stringify(context?.identityLine)}`,
    );
    await showResult('get_entity_context', context);
    await page.evaluate((line) => window.__gevVoiceCommands.emitSessionEvent({ type: 'transcript', role: 'assistant', text: line, final: true }), context?.identityLine || '');
    await settle(400);
    await shot('result-card.png');
    const tracked = await run('track_entity', { query: 'pointer' });
    const trackedId = await page.evaluate(() => {
      const info = window.__godsEyeView.dataManager.layers.get('flights')?.module?.getTrackedInfo?.();
      return info?.icao24 || info?.id || null;
    });
    report(
      tracked?.ok === true && tracked.resolvedFrom?.source === 'pointer' && (trackedId === aircraft.id || trackedId === null),
      'deixis: "track that one" follows the pointed aircraft',
      `ok=${tracked?.ok} label=${tracked?.label} trackedId=${trackedId} error=${tracked?.error || ''}`,
    );
    await run('stop_tracking', {});
    await settle(2500);
  }

  // D2 — bare ground: the chip gives coordinates and "around here" is a radius.
  const size = await page.evaluate(() => {
    const canvas = window.__godsEyeView.viewer.scene.canvas;
    return { w: canvas.clientWidth, h: canvas.clientHeight };
  });
  let groundTurn = null;
  for (const [fx, fy] of [[0.3, 0.62], [0.7, 0.62], [0.5, 0.7], [0.2, 0.5]]) {
    groundTurn = await beginAt(size.w * fx, size.h * fy, "What's here?");
    if (groundTurn.snapshot?.target === 'ground') break;
  }
  report(
    groundTurn?.snapshot?.target === 'ground' && groundTurn.chipKind === 'HERE' && /-?\d+\.\d\d, -?\d+\.\d\d/.test(groundTurn.chipText) && groundTurn.reticleVisible,
    'deixis: pointer on bare ground resolves "here" to coordinates',
    `target=${groundTurn?.snapshot?.target} chip=${groundTurn?.chipKind}:${groundTurn?.chipText} reticle=${groundTurn?.reticleVisible}`,
  );
  await shot('ground-reticle-chip.png');
  // The 512 px crop a ground-only point sends the model (one retained image).
  const captured = await page.evaluate((px) => window.__gevVoiceCommands._viewport.capturePointer(px), groundTurn?.snapshot?.screenPx || null);
  const crop = captured?.dataUrl || null;
  report(
    typeof crop === 'string' && crop.startsWith('data:image/jpeg') && crop.length > 4000 && captured.rect?.w > 0,
    'deixis: a ground point yields a 512 px crop with the ring',
    `bytes~${crop ? Math.round((crop.length * 3) / 4 / 1024) : 0} KB rect=${JSON.stringify(captured?.rect)}`,
  );
  if (SHOT_DIR && crop) {
    fs.writeFileSync(path.join(path.resolve(ROOT, SHOT_DIR), 'ground-crop.jpg'), Buffer.from(crop.split(',')[1], 'base64'));
  }
  const where = await run('get_entity_context', { scope: 'pointer' });
  report(
    where?.ok === true && where.scope === 'pointer' && Number.isFinite(where.pointer?.latitude ?? where.selected?.latitude),
    'deixis: "what is here" reads context at the pointer, not the view centre',
    `scope=${where?.scope} pointer=${JSON.stringify(where?.pointer)}`,
  );
  const around = await run('analyst_query', { layers: ['flights'], scope: { kind: 'pointer' } });
  report(
    around?.ok !== false && around?.resolvedFrom?.source === 'pointer' && /within/i.test(around?.scopeLabel || ''),
    'deixis: "how many flights around here" counts a radius at the pointer',
    `count=${around?.count} scope=${around?.scopeLabel} km=${around?.resolvedFrom?.km}`,
  );
  const pin = await run('annotate_map', { annotations: [{ type: 'pin', target: 'pointer', label: 'Here' }] });
  report(pin?.ok === true && pin.drawn >= 1, 'deixis: "drop a pin here" marks the pointed spot', `drawn=${pin?.drawn} failed=${JSON.stringify(pin?.failedLabels)}`);

  // D3 — referents: "track the second one" after a numbered list.
  const framed = await run('frame_overhead', { target: 'flights' });
  await settle(5000);
  const refs = Array.isArray(framed?.referents) ? framed.referents : [];
  if (refs.length < 2) {
    skipped('deixis: "track the second one"', `only ${refs.length} referents in frame`);
  } else {
    const second = await run('track_entity', { query: 'the second one', referent: 2 });
    report(
      second?.ok === true && second.resolvedFrom?.source === 'referent' && second.label === refs[1].label,
      'deixis: "track the second one" follows referent 2',
      `label=${second?.label} expected=${refs[1].label}`,
    );
    await run('stop_tracking', {});
    const missing = await run('track_entity', { query: 'x', referent: 40 });
    report(missing?.ok === false && /no item 40/.test(missing?.error || ''), 'deixis: an out-of-range referent is a plain refusal', missing?.error);
  }

  // D4 — a stale pointer is never "this".
  const stale = await page.evaluate(() => {
    const voice = window.__gevVoiceCommands;
    voice.pointer.element.dispatchEvent(new PointerEvent('pointerleave'));
    const snapshot = voice.beginPointerTurn('text');
    const chip = document.getElementById('gev-voice-card-pointer');
    return { fresh: Boolean(snapshot?.fresh), chipHidden: Boolean(chip?.hidden) };
  });
  const refused = await run('track_entity', { query: 'pointer' });
  report(
    !stale.fresh && stale.chipHidden && refused?.ok === false && /Nothing is under the pointer/.test(refused?.error || ''),
    'deixis: a pointer off the canvas is refused, not guessed',
    `fresh=${stale.fresh} chipHidden=${stale.chipHidden} error=${refused?.error}`,
  );
}

async function runBehaviorLayer() {
  console.log('\nLAYER 2 — behavior drives (runner(), no model)');
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(String(res.status));
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(HEADFUL ? [] : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1500,950',
    ],
    protocolTimeout: 180000,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  page.on('pageerror', (e) => console.log(`  [page error] ${String(e).slice(0, 140)}`));
  // Voice must not reach Overpass unless an operator configured it: count
  // Overpass queries through the app and any direct request to an Overpass
  // host (the status probe is not a query).
  const overpassRequests = [];
  page.on('request', (request) => {
    const target = new URL(request.url());
    const viaApp = target.origin === new URL(APP_URL).origin
      && target.pathname.startsWith('/api/overpass')
      && target.pathname !== '/api/overpass/status';
    if (viaApp || /overpass/i.test(target.hostname))
      overpassRequests.push(`${request.method()} ${target.origin}${target.pathname}`);
  });

  try {
    // The point-and-ask block skips the first-run launcher so its evidence
    // screenshots show the map; the full run keeps the historical URL.
    const behaviorUrl = new URL(APP_URL);
    if (DEIXIS_ONLY) behaviorUrl.searchParams.set('welcome', '0');
    await page.goto(behaviorUrl.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__gevVoiceCommands?.runner && window.__gevAnnotations,
      { timeout: 120000, polling: 250 },
    );
    // House rule: the intro flight clobbers teleports issued mid-flight.
    await page.evaluate(() => window.__godsEyeView.viewer.camera.cancelFlight());

    const run = (name, args) => page.evaluate(
      (n, a) => Promise.resolve(window.__gevVoiceCommands.runner(n, a))
        .catch((e) => ({ ok: false, error: String(e?.message || e), _threw: true })),
      name, args,
    );
    const camState = () => page.evaluate(() => {
      const c = window.__godsEyeView.viewer.camera;
      const p = c.positionCartographic;
      return { lat: p.latitude * 180 / Math.PI, lon: p.longitude * 180 / Math.PI, altKm: p.height / 1000, pitchDeg: c.pitch * 180 / Math.PI };
    });
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));

    // (1) fly_to_location lands near the target. Annotations follow IMMEDIATELY
    // while the camera is local — the resolver's proximity gate rejects far
    // targets BY DESIGN (annotating Austin from over the Alps must fail).
    let r = await run('fly_to_location', { query: 'Austin, Texas' });
    await settle(9000);
    let cam = await camState();
    const dAustin = Math.hypot(cam.lat - 30.2672, cam.lon + 97.7431);
    report(r?.ok !== false && dAustin < 1.2, 'behavior: fly_to_location Austin lands nearby',
      `cam=(${cam.lat.toFixed(3)},${cam.lon.toFixed(3)}) Δ=${dAustin.toFixed(2)}° alt=${cam.altKm.toFixed(1)}km`);

    // Radio voice control selects by semantic category + place without moving
    // the just-established Austin camera, then preserves explicit volume and
    // transport commands through the public layer surface.
    // `fly_to_location` may finish its promise just before Cesium drains the
    // final tween frame. Cancel that already-arrived flight so the assertion
    // measures Radio's camera ownership, not residual navigation motion.
    await page.evaluate(() => window.__godsEyeView.viewer.camera.cancelFlight());
    await settle(250);
    const radioCameraBefore = await camState();
    r = await run('control_radio', { action: 'select', category: 'news', locationId: 'austin' });
    const radioCameraAfter = await camState();
    const radioCameraDelta = Math.hypot(
      radioCameraAfter.lat - radioCameraBefore.lat,
      radioCameraAfter.lon - radioCameraBefore.lon,
    );
    report(r?.ok === true && r?.category === 'news' && r?.stationId && radioCameraDelta < 0.001,
      'behavior: Radio selects Austin news without moving the camera',
      `stationId=${r?.stationId || 'none'} category=${r?.category} cameraΔ=${radioCameraDelta.toFixed(5)}°`);
    r = await run('control_radio', { action: 'volume', volumePct: 30 });
    report(r?.ok === true && r?.volumePct === 30,
      'behavior: Radio voice volume reaches the public player', `volume=${r?.volumePct}`);
    r = await run('control_radio', { action: 'stop' });
    report(r?.ok === true && r?.audioState === 'stopped',
      'behavior: Radio voice stop releases playback', `audioState=${r?.audioState}`);

    // (2) two pins near the camera
    await run('clear_annotations', {});
    await settle(400);
    r = await run('annotate_map', {
      annotations: [
        { type: 'pin', target: 'Texas State Capitol, Austin', label: 'Capitol' },
        { type: 'pin', target: 'Zilker Park, Austin', label: 'Zilker' },
      ],
    });
    await settle(2500);
    let annoCount = await page.evaluate(() => window.__gevAnnotations?.list?.().length ?? window.__gevAnnotations?.count?.() ?? -1);
    report((r?.drawn ?? 0) >= 2 && (annoCount >= 2 || annoCount === -1),
      'behavior: two pins drawn near camera', `result.drawn=${r?.drawn} failed=${r?.failed} listCount=${annoCount}`);

    // (3) walking route between them (street-following path, sane result)
    r = await run('annotate_map', {
      annotations: [{ type: 'route', points: [{ target: 'Texas State Capitol, Austin' }, { target: 'Zilker Park, Austin' }], mode: 'walking', label: 'Capitol → Zilker walk' }],
    });
    await settle(6000);
    const routeItem = (r?.items || []).find((it) => it.type === 'route') || (r?.items || [])[0];
    report((r?.drawn ?? 0) >= 1 && routeItem?.ok !== false,
      'behavior: walking route Capitol→Zilker draws',
      `drawn=${r?.drawn} route=${JSON.stringify(routeItem)?.slice(0, 140)}`);

    if (DEIXIS_ONLY) {
      await run('set_layer_visibility', { layerId: 'flights', enabled: true });
      await settle(45000);
      await run('frame_overhead', { target: 'flights' });
      await settle(7000);
      await runDeixisBehavior(page, run, settle);
      report(overpassRequests.length === 0,
        'behavior: no Overpass request during the run',
        overpassRequests.length ? overpassRequests.slice(0, 3).join(' | ') : 'none');
      return;
    }

    // (4) frame_overhead frames nearby entities of an ENABLED layer with a
    // cinematic oblique pull-back (NOT nadir — that is its design). Flights
    // render one poll interval behind live, so give the layer time to populate.
    await run('set_layer_visibility', { layerId: 'flights', enabled: true });
    await settle(45000);
    r = await run('frame_overhead', { target: 'flights' });
    await settle(7000);
    if (r?.ok === false && /not enabled/i.test(r?.error || '')) {
      report(false, 'behavior: frame_overhead frames flights', `layer enable did not stick: ${r?.error}`);
    } else if (r?.ok && (r.count === 0 || r.framedCount === 0)) {
      skipped('behavior: frame_overhead frames flights', 'no flights in range right now (empty sky) — framing path OK');
    } else {
      report(r?.ok === true, 'behavior: frame_overhead frames flights', `result=${JSON.stringify(r)?.slice(0, 140)}`);
    }

    // (4-deixis) Point-and-ask with a synthetic pointer on the live canvas.
    await runDeixisBehavior(page, run, settle);

    // (4a) Deterministic owner-transfer probes use the real product runner and
    // camera policy with synthetic target records only. This proves ordering
    // without claiming that the live AIS stream delivered a vessel.
    const ownerTransfer = await page.evaluate(async () => {
      const app = window.__godsEyeView;
      const runner = window.__gevVoiceCommands?.runner;
      const { viewer, dataManager, styleManager } = app || {};
      const fireEntry = dataManager?.layers?.get('local-firms');
      const vesselEntry = dataManager?.layers?.get('ais-live-vessels');
      const flightsEntry = dataManager?.layers?.get('flights');
      if (!runner || !fireEntry || !vesselEntry || !flightsEntry) {
        return { error: 'required product modules unavailable' };
      }

      const original = {
        isEnabled: dataManager.isEnabled,
        fireModule: fireEntry.module,
        vesselModule: vesselEntry.module,
        flightsModule: flightsEntry.module,
        flyToBoundingSphere: viewer.camera.flyToBoundingSphere,
        cockpitActive: styleManager.cockpitView?.active,
      };
      const flightStarts = [];
      let currentKind = null;
      let vesselSelections = 0;
      viewer.camera.flyToBoundingSphere = function (...args) {
        flightStarts.push({ kind: currentKind, trackingReleased: !viewer.trackedEntity });
        return original.flyToBoundingSphere.apply(this, args);
      };
      dataManager.isEnabled = function (id) {
        if (['local-firms', 'ais-live-vessels', 'flights'].includes(id)) return true;
        return original.isEnabled.call(this, id);
      };
      fireEntry.module = {
        ...original.fireModule,
        getStrongestFire: () => ({
          id: 'qa-synthetic-fire', label: 'QA synthetic fire',
          latitude: 37.7749, longitude: -122.4194, frp: 922,
        }),
      };
      vesselEntry.module = {
        ...original.vesselModule,
        findByQuery: () => ({
          mmsi: '999000111', name: 'QA synthetic vessel',
          latitude: 29.7604, longitude: -95.3698,
        }),
        selectById: () => { vesselSelections += 1; return true; },
      };
      flightsEntry.module = {
        ...original.flightsModule,
        getNearby: () => [{
          id: 'qa-aircraft',
          position: viewer.camera.positionWC.clone(),
        }],
      };

      const results = {};
      try {
        for (const [kind, args] of [
          ['fire', { query: 'strongest fire', layerId: 'local-firms' }],
          ['vessel', { query: 'QA synthetic vessel', layerId: 'ais-live-vessels' }],
        ]) {
          const sentinel = viewer.entities.add({ id: `qa-prior-${kind}` });
          viewer.trackedEntity = sentinel;
          const generationBefore = styleManager._navigationGeneration;
          currentKind = kind;
          const result = await runner('track_entity', args);
          results[kind] = {
            ok: result?.ok === true,
            generationAdvanced: styleManager._navigationGeneration > generationBefore,
            trackingReleased: !viewer.trackedEntity,
          };
          viewer.camera.cancelFlight();
          viewer.entities.remove(sentinel);
        }

        await runner('move_camera', { motion: 'stop' });
        const seededMotion = await runner('move_camera', {
          motion: 'pan', direction: 'right', mode: 'continuous',
        });
        const cockpitSentinel = viewer.entities.add({ id: 'qa-cockpit-owner' });
        viewer.trackedEntity = cockpitSentinel;
        const generationBefore = styleManager._navigationGeneration;
        const flightsBefore = flightStarts.length;
        const selectionsBefore = vesselSelections;
        styleManager.cockpitView.active = true;
        const refused = [];
        for (const [name, args] of [
          ['move_camera', { motion: 'pan', direction: 'right' }],
          ['move_camera', { motion: 'stop' }],
          ['fly_route', { speed: 'fast' }],
          ['frame_overhead', { target: 'flights' }],
          ['track_entity', { query: 'strongest fire', layerId: 'local-firms' }],
          ['track_entity', { query: 'QA synthetic vessel', layerId: 'ais-live-vessels' }],
        ]) {
          refused.push((await runner(name, args))?.ok === false);
        }
        results.cockpit = {
          allRefused: refused.every(Boolean),
          generationUnchanged: styleManager._navigationGeneration === generationBefore,
          trackingUnchanged: viewer.trackedEntity === cockpitSentinel,
          noFlight: flightStarts.length === flightsBefore,
          noSelection: vesselSelections === selectionsBefore,
        };
        styleManager.cockpitView.active = false;
        results.cockpit.motionUnchanged = seededMotion?.ok === true
          && (await runner('move_camera', { motion: 'stop' }))?.stopped === true;
        viewer.trackedEntity = undefined;
        viewer.entities.remove(cockpitSentinel);
      } finally {
        styleManager.cockpitView.active = original.cockpitActive;
        viewer.camera.flyToBoundingSphere = original.flyToBoundingSphere;
        dataManager.isEnabled = original.isEnabled;
        fireEntry.module = original.fireModule;
        vesselEntry.module = original.vesselModule;
        flightsEntry.module = original.flightsModule;
      }
      return { results, flightStarts, vesselSelections };
    });
    const takeoversPass = ['fire', 'vessel'].every((kind) => {
      const result = ownerTransfer?.results?.[kind];
      const flight = ownerTransfer?.flightStarts?.find((candidate) => candidate.kind === kind);
      return result?.ok && result?.generationAdvanced && result?.trackingReleased
        && flight?.trackingReleased;
    }) && ownerTransfer?.vesselSelections === 1;
    report(takeoversPass,
      'behavior: synthetic fire/vessel voice targets take camera authority from tracked aircraft',
      `syntheticTarget=true result=${JSON.stringify(ownerTransfer)?.slice(0, 240)}`);
    const cockpit = ownerTransfer?.results?.cockpit;
    report(Boolean(cockpit?.allRefused && cockpit?.generationUnchanged
      && cockpit?.trackingUnchanged && cockpit?.noFlight && cockpit?.noSelection
      && cockpit?.motionUnchanged),
    'behavior: Cockpit refuses every named voice camera route before mutation',
    `result=${JSON.stringify(cockpit)}`);

    // (4b) analyst engine end-to-end: count flights over Texas (region ring
    // via NE-pack/admin machinery), then a follow-up over the same set.
    // A cold boundary lookup can exceed the resolver's budget; it answers
    // region-timeout and keeps loading, so asking again must succeed.
    let texasTimeouts = 0;
    r = await run('analyst_query', { layers: ['flights'], scope: { kind: 'region', name: 'Texas' }, limit: 5 });
    while (r?.code === 'region-timeout' && texasTimeouts < 8) {
      texasTimeouts += 1;
      await settle(5000);
      r = await run('analyst_query', { layers: ['flights'], scope: { kind: 'region', name: 'Texas' }, limit: 5 });
    }
    report(r?.ok === true && Number.isFinite(r?.count) && r.count > 0 && String(r?.coverage?.scope || '').includes('Texas'),
      'behavior: analyst counts flights over Texas', `count=${r?.count} scope=${r?.coverage?.scope} timeouts=${texasTimeouts} err=${r?.error || ''}`);
    r = await run('analyst_query', { followUp: true, filters: [{ field: 'onGround', op: 'eq', value: false }], sortBy: 'altitudeM', limit: 3 });
    report(r?.ok === true && r?.coverage?.followUp === true,
      'behavior: analyst follow-up re-filters the remembered set', `count=${r?.count} followUp=${r?.coverage?.followUp}`);
    // A marine region resolves from the bundled Natural Earth pack in the page,
    // without the slower geocode fallback.
    const gulfStarted = Date.now();
    r = await run('analyst_query', { layers: ['flights'], scope: { kind: 'region', name: 'Gulf of Mexico' }, limit: 5 });
    const gulfMs = Date.now() - gulfStarted;
    report(r?.ok === true && String(r?.coverage?.scope || '').includes('Gulf of Mexico') && gulfMs < 3000,
      'behavior: analyst resolves the Gulf of Mexico from the bundled pack', `scope=${r?.coverage?.scope} ms=${gulfMs} err=${r?.error || ''}`);

    // (5) zoom_to_globe is ABSOLUTE full-earth (>12,000 km band)
    r = await run('zoom_to_globe', {});
    await page.waitForFunction(
      () => window.__godsEyeView.viewer.camera.positionCartographic.height / 1000 > 12000,
      { timeout: 30_000, polling: 250 },
    ).catch(() => {});
    cam = await camState();
    report(cam.altKm > 12000, 'behavior: zoom_to_globe reaches global band', `alt=${Math.round(cam.altKm)}km (want >12000)`);

    // (6) natural-region swath: overview of the Alps must CAP the range
    r = await run('fly_to_location', { query: 'the Alps', viewMode: 'overview' });
    await page.waitForFunction(
      () => window.__godsEyeView.viewer.camera.positionCartographic.height / 1000 < 900,
      { timeout: 40_000, polling: 250 },
    ).catch(() => {});
    cam = await camState();
    const swathMode = r?.navigationMode || r?.mode || '(none)';
    report(String(swathMode).includes('swath') || cam.altKm < 900,
      'behavior: Alps overview uses capped swath, not whole-bbox space view',
      `navigationMode=${swathMode} alt=${Math.round(cam.altKm)}km (want swath / <900km)`);

    // (6b) THE owner field finding: "outline the Alps" must draw the real
    // range ring (Natural Earth first-rung, offline → resolves in seconds),
    // not a 60 km² meadow and not a stuck point. Camera is over the Alps
    // from (6), so the proximity gate and the containment guard both pass.
    r = await run('annotate_map', {
      annotations: [{ type: 'area', target: 'the Alps', label: 'The Alps' }],
    });
    let alpsOutline = false;
    for (let i = 0; i < 10 && !alpsOutline; i += 1) {
      await settle(1500);
      alpsOutline = await page.evaluate(() => {
        // list() returns RAW annotation objects: outline presence = ring array
        // (the `outline` boolean exists only in the tool-result mapping).
        const items = window.__gevAnnotations?.list?.() || [];
        const alps = items.find((it) => /alps/i.test(it.label || ''));
        return Array.isArray(alps?.ring) && alps.ring.length >= 8;
      });
    }
    report((r?.drawn ?? 0) >= 1 && alpsOutline,
      'behavior: "outline the Alps" draws the Natural Earth range ring',
      `drawn=${r?.drawn} outlineResolved=${alpsOutline}`);

    // (6b2) proximity-gate NEGATIVE control at a LOCAL far view (Alps swath,
    // ~165 km): annotating Austin from here must be an honest rejection.
    // NOT run at globe scale — the gate is view-scale-aware by design and a
    // global view legitimately allows marking anywhere.
    r = await run('annotate_map', { annotations: [{ type: 'pin', target: 'Zilker Park, Austin', label: 'FarPin' }] });
    await settle(1500);
    report((r?.drawn ?? 1) === 0 || (r?.failed ?? 0) >= 1,
      'behavior: far-target annotate is proximity-rejected by design',
      `drawn=${r?.drawn} failed=${r?.failed}`);

    // Camera-verb scenarios: shed the heavy layers first — headless
    // SwiftShader drops to ~1 fps with fires+vessels loaded and every
    // motion assert starves (environment, not product).
    await run('set_layer_visibility', { layerId: 'local-firms', enabled: false });
    await run('set_layer_visibility', { layerId: 'ais-live-vessels', enabled: false });
    await settle(1500);

    // (6c) move_camera orbit ONCE: bounded eased ~30° heading advance.
    const heading = () => page.evaluate(() => window.__godsEyeView.viewer.camera.heading * 180 / Math.PI);
    let h0 = await heading();
    r = await run('move_camera', { motion: 'orbit', mode: 'once' });
    await settle(5000);
    let h1 = await heading();
    let dOnce = Math.abs(((h1 - h0 + 540) % 360) - 180);
    report(r?.ok === true && dOnce > 10 && dOnce < 45,
      'behavior: orbit once advances ~30° and self-stops', `Δheading=${dOnce.toFixed(1)}° result=${JSON.stringify(r)?.slice(0, 90)}`);

    // (6d) continuous orbit runs until stop; stop reports it was active.
    r = await run('move_camera', { motion: 'orbit', mode: 'continuous', speed: 'normal' });
    await settle(2500);
    h0 = await heading();
    // SwiftShader can fall near 1 fps. The motion loop deliberately caps a
    // single-frame time step, so allow enough wall time for >1° of observable
    // travel even at that floor while keeping the same product assertion.
    await settle(3500);
    h1 = await heading();
    const moving = Math.abs(((h1 - h0 + 540) % 360) - 180) > 1;
    let stopRes = await run('move_camera', { motion: 'stop' });
    await settle(600);
    h0 = await heading();
    await settle(1200);
    h1 = await heading();
    const frozen = Math.abs(((h1 - h0 + 540) % 360) - 180) < 0.5;
    report(moving && stopRes?.stopped === true && frozen,
      'behavior: continuous orbit moves, stop freezes it', `moving=${moving} stopped=${stopRes?.stopped} frozen=${frozen}`);

    // (6e) a navigation tool reclaims the camera from continuous motion.
    await run('move_camera', { motion: 'orbit', mode: 'continuous', speed: 'slow' });
    await settle(800);
    await run('zoom_to_globe', {});
    await settle(1000);
    stopRes = await run('move_camera', { motion: 'stop' });
    report(stopRes?.stopped === false,
      'behavior: nav tool interrupts continuous motion', `stop-after-nav reports stopped=${stopRes?.stopped} (want false)`);

    // (6e3) CHAINED fly+orbit ("take me to X and orbit it"): orbit called
    // mid-flight must ARM and start once the camera settles (field finding).
    await run('fly_to_location', { query: 'Texas State Capitol' });
    r = await run('move_camera', { motion: 'orbit', mode: 'continuous', speed: 'normal' });
    const armedOk = r?.ok === true; // either armed or started, both fine
    await settle(16000);
    h0 = await heading();
    h1 = h0;
    let chainMoving = false;
    // Multi-stage Cesium flights can settle later under SwiftShader even
    // after reaching the destination. Poll for actual heading motion instead
    // of sampling exactly one frame five seconds after arrival.
    for (let i = 0; i < 20 && !chainMoving; i += 1) {
      await settle(1500);
      h1 = await heading();
      chainMoving = Math.abs(((h1 - h0 + 540) % 360) - 180) > 1.5;
    }
    // ARRIVAL is the assert that catches mid-flight capture: the orbit must
    // engage AT the Capitol, not wherever the flight happened to be.
    const camChain = await camState();
    const dCapitol = Math.hypot(camChain.lat - 30.2747, camChain.lon + 97.7404);
    report(armedOk && chainMoving && dCapitol < 0.1 && camChain.altKm < 30,
      'behavior: chained fly+orbit arms and starts AT the destination',
      `Δheading=${Math.abs(((h1 - h0 + 540) % 360) - 180).toFixed(1)}° cam=(${camChain.lat.toFixed(3)},${camChain.lon.toFixed(3)}) alt=${camChain.altKm.toFixed(1)}km dCapitol=${dCapitol.toFixed(3)}°`);

    // (6e4) zoom during orbit spirals the RADIUS (never a snapped-back no-op).
    // Wait out any residual arrival descent first so altitude deltas are the
    // ZOOM's, not the flight's.
    for (let i = 0; i < 10; i += 1) {
      const a = (await camState()).altKm;
      await settle(1500);
      if (Math.abs((await camState()).altKm - a) < a * 0.02) break;
    }
    let altBefore = (await camState()).altKm;
    r = await run('adjust_camera_zoom', { direction: 'out', amount: 'medium' });
    await settle(2500);
    let altAfter = (await camState()).altKm;
    let stillOrbiting = (await run('move_camera', { motion: 'stop' }))?.stopped === true;
    report(r?.orbitRadiusAdjusted === true && altAfter > altBefore * 1.1 && stillOrbiting,
      'behavior: zoom during orbit grows the radius while circling',
      `alt ${altBefore.toFixed(2)}→${altAfter.toFixed(2)}km adjusted=${r?.orbitRadiusAdjusted} stillOrbiting=${stillOrbiting}`);

    // (6e4b) move_camera is explicit navigation: while TRACKING it must first
    // release the follow owner, then start the requested motion.
    await run('set_layer_visibility', { layerId: 'flights', enabled: true });
    // Track a REAL contact the way the voice model does: nearest via analyst.
    const near = await run('analyst_query', { layers: ['flights'], scope: { kind: 'view' }, sortBy: 'distance', limit: 1 });
    const trackId = near?.items?.[0]?.id;
    r = trackId ? await run('track_entity', { query: trackId, layerId: 'flights' }) : { ok: false, error: 'no contacts in view' };
    if (r?.ok) {
      const orbitRes = await run('move_camera', { motion: 'orbit', mode: 'continuous' });
      const trackingReleased = await page.evaluate(() => !window.__godsEyeView.viewer.trackedEntity);
      const orbitStop = await run('move_camera', { motion: 'stop' });
      report(orbitRes?.ok === true && trackingReleased && orbitStop?.stopped === true,
        'behavior: move_camera releases tracking before taking the camera',
        `released=${trackingReleased} stopped=${orbitStop?.stopped} result=${JSON.stringify(orbitRes)?.slice(0, 100)}`);
    } else {
      skipped('behavior: move_camera releases tracking before taking the camera',
        `no trackable flight right now (${JSON.stringify(r)?.slice(0, 80)})`);
    }
    await settle(1500);

    // (6e4c) explicit navigation while tracking SUPERSEDES the follow camera
    // (field finding: "flew there but still tracking — couldn't do anything").
    const near2 = await run('analyst_query', { layers: ['flights'], scope: { kind: 'anywhere' }, sortBy: 'distance', limit: 1 });
    const trackId2 = near2?.items?.[0]?.id;
    if (trackId2 && (await run('track_entity', { query: trackId2, layerId: 'flights' }))?.ok) {
      await settle(2000);
      await run('fly_to_location', { query: 'Austin, Texas' });
      await settle(6000);
      const stillTracked = await page.evaluate(() => Boolean(window.__godsEyeView.viewer.trackedEntity));
      const camHere = await camState();
      const nearAustin = Math.hypot(camHere.lat - 30.2672, camHere.lon + 97.7431) < 1.5;
      report(!stillTracked && nearAustin,
        'behavior: fly-to while tracking stops the tracking and arrives',
        `stillTracked=${stillTracked} cam=(${camHere.lat.toFixed(2)},${camHere.lon.toFixed(2)}) nearAustin=${nearAustin}`);
    } else {
      skipped('behavior: fly-to while tracking stops the tracking and arrives', 'no trackable contact right now');
    }

    // (6e5) tilt at the clamp answers honestly instead of silently no-oping.
    await page.evaluate(() => {
      const c = window.__godsEyeView.viewer.camera;
      c.setView({ orientation: { heading: c.heading, pitch: -5.2 * Math.PI / 180, roll: 0 } });
    });
    r = await run('move_camera', { motion: 'tilt', direction: 'up', mode: 'once' });
    report(r?.ok === false && /limit/i.test(r?.error || ''),
      'behavior: tilt at the clamp reports the limit honestly', `result=${JSON.stringify(r)?.slice(0, 120)}`);

    // (6f) fly_route dollies along the drawn Capitol→Zilker route.
    r = await run('fly_route', { speed: 'fast' });
    await settle(4000);
    const camNow = await camState();
    const nearRoute = Math.hypot(camNow.lat - 30.27, camNow.lon + 97.755) < 0.2;
    stopRes = await run('move_camera', { motion: 'stop' });
    report(r?.ok === true && (r?.distanceM ?? 0) > 2000 && (r?.distanceM ?? 0) < 12000 && nearRoute,
      'behavior: fly_route dollies the drawn route', `distanceM=${r?.distanceM} waypoints=${r?.waypoints} cam=(${camNow.lat.toFixed(3)},${camNow.lon.toFixed(3)}) nearRoute=${nearRoute} stopHadMotion=${stopRes?.stopped} err=${r?.error || ''}`);

    // (7) clear_annotations empties the board
    r = await run('clear_annotations', {});
    await settle(800);
    annoCount = await page.evaluate(() => window.__gevAnnotations?.list?.().length ?? window.__gevAnnotations?.count?.() ?? -1);
    report(r?.ok !== false && (annoCount === 0 || annoCount === -1), 'behavior: clear_annotations empties board', `listCount=${annoCount}`);

    // (8) get_entity_context returns basemap context
    r = await run('get_entity_context', {});
    const hasContext = !!(r && (r.basemap || r.scene || r.context || r.viewScale || r.center));
    report(hasContext, 'behavior: get_entity_context returns scene context', `keys=${Object.keys(r || {}).slice(0, 8).join(',')}`);

    // (9) set_context_mode — happy path and a refusal.
    // Contacts is an exclusive mode that tears other layers down, so this runs
    // last and hands the app back to `off` before the screenshot.
    r = await run('set_context_mode', { mode: 'contacts' });
    await settle(2500);
    const contextEntered = await page.evaluate(
      () => window.__godsEyeView?.styleManager?.getContextModeState?.() || null,
    );
    report(r?.ok === true && contextEntered?.mode === 'flights',
      'behavior: set_context_mode enters Contacts',
      `result=${JSON.stringify(r)?.slice(0, 140)} state=${JSON.stringify(contextEntered)?.slice(0, 90)}`);

    // (9a) control_cockpit status reads the real Cockpit surface.
    r = await run('control_cockpit', { action: 'status' });
    report(r?.ok === true && r?.state && typeof r.state === 'object',
      'behavior: control_cockpit status reports Cockpit state',
      `result=${JSON.stringify(r)?.slice(0, 160)}`);

    // (9b) Cockpit entry with nothing to fly is an honest failure, never a
    // silent success that leaves the operator staring at an unchanged map.
    const cockpitBefore = await page.evaluate(
      () => Boolean(window.__godsEyeView?.styleManager?.cockpitView?.active),
    );
    r = await run('control_cockpit', { action: 'enter' });
    await settle(1200);
    const cockpitAfter = await page.evaluate(
      () => Boolean(window.__godsEyeView?.styleManager?.cockpitView?.active),
    );
    // Either it genuinely entered (an aircraft was tracked) or it refused with
    // a reason — the one thing it must never do is claim success while inert.
    report((r?.ok === true && cockpitAfter) || (r?.ok !== true && !!r?.error && !cockpitAfter),
      'behavior: control_cockpit entry is honest about whether it entered',
      `ok=${r?.ok} error=${String(r?.error || '').slice(0, 80)} before=${cockpitBefore} after=${cockpitAfter}`);
    if (cockpitAfter) await run('control_cockpit', { action: 'exit' });

    // (9c) An unknown cockpit action is refused by name.
    r = await run('control_cockpit', { action: 'barrel-roll' });
    report(r?.ok === false && /unknown cockpit action/i.test(r?.error || ''),
      'behavior: control_cockpit refuses an unknown action',
      `result=${JSON.stringify(r)?.slice(0, 120)}`);

    // (9d) An unavailable context mode is refused, and the live mode survives.
    r = await run('set_context_mode', { mode: 'orbital-weather' });
    const contextAfterRefusal = await page.evaluate(
      () => window.__godsEyeView?.styleManager?.getContextModeState?.() || null,
    );
    report(r?.ok === false && /unknown context mode/i.test(r?.error || '')
      && contextAfterRefusal?.mode === 'flights',
      'behavior: set_context_mode refuses an unavailable mode without dropping the live one',
      `result=${JSON.stringify(r)?.slice(0, 120)} state=${JSON.stringify(contextAfterRefusal)?.slice(0, 80)}`);

    // (9c-2) With Contacts up, an aircraft radius query must carry the panel's
    // own numbers. Field case: analyst said 8 for a 250 km window the panel had
    // at 42 — both honest (analyst counts loaded records, the flights layer
    // reloads by viewport), and the operator saw two answers to one question.
    r = await run('analyst_query', {
      layers: ['flights'],
      scope: { kind: 'radius', km: 250 },
      sortBy: 'distance',
      limit: 3,
    });
    const awarenessFlights = await page.evaluate(() => {
      const snap = window.__godsEyeView?.dataManager?.layers
        ?.get('military-awareness')?.module?.getContextSnapshot?.();
      const cohort = snap?.cohorts?.find((c) => c.id === 'flights');
      return cohort ? cohort.count : null;
    });
    const windowBlock = r?.contactsWindow || null;
    report(
      Boolean(windowBlock)
      && windowBlock.flights === awarenessFlights
      && windowBlock.radiusKm === 250
      && typeof windowBlock.centeredOn === 'string'
      && /loads by viewport/.test(r?.coverage?.note || '')
      // Contract rule 3: the count names its own scope.
      && /^within 250 km of /.test(r?.scopeLabel || ''),
      'behavior: analyst_query carries the Contacts panel counts and says what it measured',
      `contactsWindow=${JSON.stringify(windowBlock)} awarenessFlights=${awarenessFlights} analystCount=${r?.count} scopeLabel="${r?.scopeLabel}"`,
    );

    // (9d-2) enter + targetLayer must land on that layer or refuse by name.
    // Field case: enter{targetLayer:"military"} reported ok:true on a FLIGHTS
    // subject, so "cockpit in that military helicopter" put the operator in an
    // airliner.
    if (await page.evaluate(() => Boolean(window.__godsEyeView?.styleManager?.cockpitView?.active))) {
      await run('control_cockpit', { action: 'exit' });
      await settle(600);
    }
    r = await run('control_cockpit', { action: 'enter', targetLayer: 'military' });
    await settle(1200);
    const layerAfter = r?.state?.subject?.layerId ?? null;
    const cockpitOn = await page.evaluate(
      () => Boolean(window.__godsEyeView?.styleManager?.cockpitView?.active),
    );
    report(
      (r?.ok === true && layerAfter === 'military' && cockpitOn)
      || (r?.ok !== true && !!r?.error && !cockpitOn),
      'behavior: control_cockpit enter honours targetLayer or refuses by name',
      `ok=${r?.ok} subjectLayer=${layerAfter} active=${cockpitOn} error=${String(r?.error || '').slice(0, 90)}`,
    );
    if (cockpitOn) { await run('control_cockpit', { action: 'exit' }); await settle(600); }

    // (9d-3) A non-aircraft layer can never be entered — Cockpit flies aircraft.
    r = await run('control_cockpit', { action: 'enter', targetLayer: 'ais-live-vessels' });
    const vesselCockpit = await page.evaluate(
      () => Boolean(window.__godsEyeView?.styleManager?.cockpitView?.active),
    );
    report(r?.ok === false && /aircraft only/i.test(r?.error || '') && !vesselCockpit,
      'behavior: control_cockpit refuses to enter a non-aircraft layer',
      `result=${JSON.stringify(r)?.slice(0, 130)} active=${vesselCockpit}`);

    // (9e) Exit restores the neutral map.
    r = await run('set_context_mode', { mode: 'off' });
    await settle(2000);
    const contextExited = await page.evaluate(
      () => window.__godsEyeView?.styleManager?.getContextModeState?.() || null,
    );
    report(r?.ok !== false && !contextExited?.mode,
      'behavior: set_context_mode exits back to the neutral map',
      `result=${JSON.stringify(r)?.slice(0, 120)} state=${JSON.stringify(contextExited)?.slice(0, 80)}`);

    // (9f) With Contacts OFF the entry gate is shut. Entry must refuse with the
    // reason rather than produce the half-entered state the operator saw: a
    // plane anchored under the camera with no HUD and no exit control.
    r = await run('control_cockpit', { action: 'status' });
    const gateReport = r?.state || {};
    const cockpitBeforeGate = await page.evaluate(
      () => Boolean(window.__godsEyeView?.styleManager?.cockpitView?.active),
    );
    report(gateReport.active === false && gateReport.entryAllowed === false
      && gateReport.entryBlockedReason === 'contacts-inactive' && !cockpitBeforeGate,
    'behavior: cockpit status names why entry is blocked with Contacts off',
    `state=${JSON.stringify(gateReport)?.slice(0, 150)}`);

    // The runner calls controlCockpit directly, so this exercises the app gate
    // rather than the voice tool's own Contacts bootstrap.
    const gated = await page.evaluate(
      () => window.__godsEyeView?.styleManager?.controlCockpit?.('enter') || null,
    );
    const cockpitAfterGate = await page.evaluate(
      () => Boolean(window.__godsEyeView?.styleManager?.cockpitView?.active),
    );
    report(gated?.ok === false && /contacts/i.test(gated?.error || '') && !cockpitAfterGate,
      'behavior: cockpit entry with Contacts off is refused, not half-entered',
      `ok=${gated?.ok} error=${String(gated?.error || '').slice(0, 90)} active=${cockpitAfterGate}`);

    const shotDir = path.join(ROOT, 'qa-shots');
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'voice-behavior-final.png') });
    report(overpassRequests.length === 0,
      'behavior: no Overpass request during the run',
      overpassRequests.length ? overpassRequests.slice(0, 3).join(' | ') : 'none');
  } catch (e) {
    report(false, 'behavior: layer crashed', String(e?.message || e).slice(0, 200));
  } finally {
    await browser.close();
  }
}

// ── Main ────────────────────────────────────────────────────
console.log('\nVoice-surface QA harness');
console.log(`  App URL : ${APP_URL}`);
console.log(`  Layer   : ${LAYER}\n`);

if (LAYER === 'behavior' || LAYER === 'all') await runBehaviorLayer();
if (LAYER === 'routing' || LAYER === 'all') await runRoutingLayer();
if (LAYER === 'deixis') await runDeixisRoutingLayer();
if (LAYER === 'deixis-live') await runDeixisLiveLayer();

console.log('\n────────────────────────────────────────────────────────────');
console.log(`  RESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
if (failures.length) failures.forEach((f) => console.log(`    ✗ ${f.label}`));
console.log('────────────────────────────────────────────────────────────\n');
process.exitCode = fail > 0 ? 1 : 0;
