#!/usr/bin/env node
/**
 * Camera-chat verification harness (headless Chromium via the repo's puppeteer).
 *
 *   node scripts/qa-chat-harness.mjs --url https://<preview> --out <dir> [--camera "MARTIN LUTHER KING JR BLVD / COMAL ST"] [--settle 20000]
 *
 * Flow (docs/ONDEMAND_CAMERA_CHAT_ADDENDUM_2026-09-21.md §6): open the Austin
 * scene, enable the CCTV layer, select the MLK/Comal camera (by name, else the
 * camera nearest 30.2811,-97.7226), wait for its frame, open the chat panel
 * through the CCTV panel's ASK button (`gev:ask-camera`), then send three
 * questions — (i) an image question with the frame attached, (ii) a lane
 * question, (iii) an internet-connected question — and record for each the SSE
 * event count, HTTP statuses, latency and UTC timestamps of every OnDemand
 * proxy call (the controller's `apiCalls` ledger plus the page's network log).
 *
 * Keyless deployments: the panel must show its NOT CONFIGURED state; the
 * harness then records the 503 `not_configured` calls and reports
 * `configured:false` instead of inventing answers. Exit code 1 when any
 * structural assertion fails (panel/button/lucide icons/brand marks); the
 * keyless outcome itself is not a failure of the UI.
 *
 * Output: <out>/chat-harness.json plus PNGs (full 1440x900 frames of the
 * camera overlay before/after the chat opens, a crop of the chat panel over
 * the CCTV panel, and a crop after the third answer). Own process; the
 * browser is closed on every exit path.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const baseUrl = args.url;
const outDir = args.out || '.';
const CAMERA_NAME = args.camera || 'MARTIN LUTHER KING JR BLVD / COMAL ST';
const CAMERA_NEAR = { lat: 30.2811, lon: -97.7226 };
const SETTLE_MS = Number(args.settle || 20000);
const TURN_TIMEOUT_MS = Number(args.turnTimeout || 120000);
const CAP_MS = Number(args.cap || 540000);
if (!baseUrl) { console.error('usage: --url <base> --out <dir> [--camera <name>]'); process.exit(2); }
const SCENE_HASH = '#lat=30.2811&lon=-97.7226&alt=600&heading=0&pitch=-40&v=2&hv=1&hud=tactical';
const QUERIES = [
  { id: 'image', attachFrame: true, text: 'Are there any vehicles or pedestrians in the crosswalk right now?' },
  { id: 'lanes', attachFrame: false, text: 'How many lanes are on MLK here and which are open toward Comal?' },
  { id: 'internet', attachFrame: false, text: 'Any current road closures or incidents on MLK Jr Blvd in Austin right now?' },
];
const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
fs.mkdirSync(outDir, { recursive: true });
const shot = (name) => path.join(outDir, `${name}.png`);
const result = { startedAt: ts(), baseUrl, viewport: '1440x900', cameraRequested: CAMERA_NAME, camera: null, configured: null, turns: [], apiCalls: [], network: { total: 0, ondemand: [], non2xx: [] }, console: { errors: [], pageErrors: [] }, structure: {}, failures: [], shots: {}, error: null };

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 300000,
});
const hardKill = () => { try { browser.process()?.kill('SIGKILL'); } catch {} };
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { hardKill(); process.exit(124); });
process.on('exit', hardKill);
const capTimer = setTimeout(() => { result.error = `wall-clock cap ${CAP_MS} ms exceeded`; log('CAP EXCEEDED'); hardKill(); process.exit(124); }, CAP_MS);
const fail = (message) => { result.failures.push(message); log('FAIL', message); };

try {
  const page = await browser.newPage();
  const started = new Map();
  page.on('request', (r) => { if (r.url().includes('/api/ondemand/')) started.set(r, Date.now()); });
  page.on('response', (r) => {
    result.network.total++;
    const s = r.status();
    const url = r.url();
    if (url.includes('/api/ondemand/')) {
      const t0 = started.get(r.request());
      result.network.ondemand.push({ atUtc: ts(), method: r.request().method(), url: url.replace(baseUrl, ''), status: s, ms: t0 ? Date.now() - t0 : null });
    }
    if (s >= 300 && (url.includes('/api/') || s >= 500)) result.network.non2xx.push(`${s} ${r.request().method()} ${url.replace(baseUrl, '')}`);
  });
  page.on('console', (m) => { if (m.type() === 'error') result.console.errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => result.console.pageErrors.push(String(e.message).slice(0, 200)));

  const url = `${baseUrl}/?welcome=0${SCENE_HASH}`;
  log('goto', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && document.querySelectorAll('#data-toggles [data-layer-id]').length >= 18, { timeout: 90000 });
  result.appReadyAt = ts();
  await page.waitForFunction(() => document.querySelector('#loading-screen')?.classList.contains('hidden'), { timeout: 60000 }).catch(() => fail('loading screen did not hide'));

  // 1. Enable CCTV and pick the camera.
  result.cctv = await page.evaluate(async (name, near) => {
    const m = window.__godsEyeView.dataManager;
    if (!m.isEnabled('cctv')) await m.setEnabled('cctv', true, { origin: 'user' });
    const module = m.layers.get('cctv')?.module;
    const deadline = Date.now() + 60000;
    let state = null;
    while (Date.now() < deadline) {
      state = module?.getUIState?.();
      if (state?.cameras?.length) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const cameras = state?.cameras || [];
    const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const wanted = norm(name);
    let pick = cameras.find((c) => norm(c.name) === wanted) || cameras.find((c) => norm(c.name).includes('MARTIN LUTHER KING') && norm(c.name).includes('COMAL')) || null;
    let how = pick ? 'by-name' : null;
    if (!pick && cameras.length) {
      const d = (c) => Math.hypot((c.lat - near.lat) * 111, (c.lon - near.lon) * 96);
      pick = cameras.slice().sort((a, b) => d(a) - d(b))[0];
      how = 'nearest';
    }
    if (pick) module.setParams({ selectedCameraId: pick.id });
    await new Promise((r) => setTimeout(r, 800));
    const after = module?.getUIState?.();
    return { enabled: m.isEnabled('cctv'), cameraCount: cameras.length, picked: pick ? { id: pick.id, name: pick.name, lat: pick.lat, lon: pick.lon, headingDeg: pick.headingDeg, provider: pick.provider, how } : null, activeCameraId: after?.activeCameraId || null };
  }, CAMERA_NAME, CAMERA_NEAR);
  log('cctv', JSON.stringify(result.cctv));
  if (!result.cctv.picked) fail('no CCTV camera available to select');
  result.camera = result.cctv.picked;

  // 2. Wait for the frame and the ASK button.
  await page.waitForFunction(() => { const img = document.getElementById('cctv-frame'); return img && img.classList.contains('active') && img.dataset.loadedAt; }, { timeout: 60000 }).catch(() => fail('camera frame did not load within 60 s'));
  await page.evaluate(() => { const panel = document.getElementById('cctv-panel'); if (panel?.classList.contains('collapsed')) panel.querySelector('.panel-collapse-btn')?.click(); });
  await new Promise((r) => setTimeout(r, Math.min(SETTLE_MS, 20000)));
  result.structure.before = await page.evaluate(() => {
    const btn = document.getElementById('cctv-ask-btn');
    const svg = btn?.querySelector('svg[data-icon]');
    const img = document.getElementById('cctv-frame');
    return {
      askButtonPresent: !!btn, askButtonHidden: btn?.hidden ?? null, askIcon: svg?.dataset.icon || null, askStroke: svg?.getAttribute('stroke-width') || null,
      frameSrc: img?.dataset.currentSrc || null, frameLoadedAtUtc: img?.dataset.loadedAt ? new Date(Number(img.dataset.loadedAt)).toISOString() : null,
      cctvMeta: document.getElementById('cctv-meta')?.textContent || null,
      brandMarks: { titleBar: document.querySelectorAll('#title-bar [data-brand-mark]').length, loadingScreen: document.querySelectorAll('#loading-screen [data-brand-mark]').length },
      clearLayersIcon: document.querySelector('#clear-selected-layers svg[data-icon]')?.dataset.icon || null,
      shareIcon: document.querySelector('#share-btn svg[data-icon]')?.dataset.icon || null,
      chatOpen: document.getElementById('ondemand-entity-chat')?.getAttribute('data-open') || 'absent',
    };
  });
  log('before', JSON.stringify(result.structure.before));
  if (!result.structure.before.askButtonPresent) fail('#cctv-ask-btn missing');
  if (result.structure.before.askIcon !== 'message-square') fail(`ASK button icon is ${result.structure.before.askIcon}, expected lucide message-square`);
  await page.evaluate(() => { const v = window.__godsEyeView?.viewer; if (v) v.useDefaultRenderLoop = false; });
  await page.screenshot({ path: shot('chat-before-1440x900') }); result.shots.before = 'chat-before-1440x900.png'; result.shots.beforeAt = ts();
  await page.evaluate(() => { const v = window.__godsEyeView?.viewer; if (v) v.useDefaultRenderLoop = true; });

  // 3. Open the chat through the panel button.
  await page.evaluate(() => document.getElementById('cctv-ask-btn')?.click());
  await page.waitForFunction(() => document.getElementById('ondemand-entity-chat')?.getAttribute('data-open') === 'true', { timeout: 20000 }).catch(() => fail('chat panel did not open after clicking #cctv-ask-btn'));
  await page.waitForFunction(() => { const s = window.__godsEyeView?.entityChat?.getState?.(); return s && (s.sessionId || /SESSION FAILED|NOT CONFIGURED|CONTEXT TURN FAILED|READY/.test(s.statusText || '')); }, { timeout: 90000 }).catch(() => fail('chat session did not settle (no READY / failure status) within 90 s'));
  const opened = await page.evaluate(() => window.__godsEyeView.entityChat.getState());
  result.configured = opened.serverConfigured;
  result.session = { sessionId: opened.sessionId, entityKey: opened.entityKey, kind: opened.kind, statusText: opened.statusText, history: opened.history, cameraConfig: opened.cameraConfig, messages: opened.messages };
  log('opened', JSON.stringify({ configured: result.configured, sessionId: opened.sessionId, status: opened.statusText }));
  result.structure.chat = await page.evaluate(() => {
    const overlay = document.getElementById('ondemand-entity-chat');
    const attach = document.getElementById('ondemand-entity-chat-attach');
    const EMOJI = /\p{Extended_Pictographic}/u;
    return {
      kind: overlay?.getAttribute('data-entity-kind'), title: document.getElementById('ondemand-entity-chat-title')?.textContent, mgrs: document.getElementById('ondemand-entity-chat-mgrs')?.textContent,
      attachPresent: !!attach, attachHidden: attach?.hidden ?? null, attachIcon: attach?.querySelector('svg[data-icon]')?.dataset.icon || null,
      closeIcon: document.getElementById('ondemand-entity-chat-close')?.querySelector('svg[data-icon]')?.dataset.icon || null,
      emojiInPanel: EMOJI.test(overlay?.textContent || ''), materialInPanel: overlay?.querySelectorAll('.material-symbols-outlined').length || 0,
      brandMarksInPanel: overlay?.querySelectorAll('[data-brand-mark]').length || 0,
      brandMarks: { titleBar: document.querySelectorAll('#title-bar [data-brand-mark]').length, loadingScreen: document.querySelectorAll('#loading-screen [data-brand-mark]').length },
      clearLayersIcon: document.querySelector('#clear-selected-layers svg[data-icon]')?.dataset.icon || null, shareIcon: document.querySelector('#share-btn svg[data-icon]')?.dataset.icon || null,
      overlayRect: overlay?.getBoundingClientRect().toJSON(), panelRect: document.getElementById('cctv-panel')?.getBoundingClientRect().toJSON(),
    };
  });
  if (result.structure.chat.kind !== 'camera') fail(`chat kind is ${result.structure.chat.kind}, expected camera`);
  if (result.structure.chat.attachIcon !== 'image-plus') fail(`attach icon is ${result.structure.chat.attachIcon}, expected lucide image-plus`);
  if (result.structure.chat.emojiInPanel) fail('emoji found in the chat panel text');
  if (result.structure.chat.materialInPanel) fail('Material Symbols ligature found in the chat panel');
  if (result.structure.chat.brandMarksInPanel > 0) fail('the chat panel renders a brand mark (guard: none allowed)');
  for (const [k, v] of Object.entries(result.structure.chat.brandMarks)) if (v !== 1) fail(`brand mark count ${k}=${v}, expected 1`);
  if (result.structure.chat.clearLayersIcon !== 'layers-minus' || result.structure.chat.shareIcon !== 'link') fail('clear-layers/share buttons changed');
  await page.evaluate(() => { const v = window.__godsEyeView?.viewer; if (v) v.useDefaultRenderLoop = false; });
  await page.screenshot({ path: shot('chat-open-1440x900') }); result.shots.open = 'chat-open-1440x900.png'; result.shots.openAt = ts();
  {
    const boxes = [result.structure.chat.overlayRect, result.structure.chat.panelRect].filter((b) => b && b.width > 0);
    if (boxes.length) {
      const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 10), y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 10);
      const x1 = Math.min(1440, Math.max(...boxes.map((b) => b.x + b.width)) + 10), y1 = Math.min(900, Math.max(...boxes.map((b) => b.y + b.height)) + 10);
      await page.screenshot({ path: shot('chat-open-crop'), clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }); result.shots.openCrop = 'chat-open-crop.png';
    }
  }
  await page.evaluate(() => { const v = window.__godsEyeView?.viewer; if (v) v.useDefaultRenderLoop = true; });

  // 4. Three queries.
  for (const query of QUERIES) {
    const t0 = ts();
    const turn = await Promise.race([
      page.evaluate(async (text, attach) => {
        const chat = window.__godsEyeView.entityChat;
        const before = chat.getState().apiCalls.length;
        const turn = await chat.send(text, { attachFrame: attach });
        const state = chat.getState();
        return { turn, apiCalls: state.apiCalls.slice(before), lastMessage: state.messages.at(-1), statusText: state.statusText };
      }, query.text, query.attachFrame),
      new Promise((resolve) => setTimeout(() => resolve({ turn: null, apiCalls: [], statusText: 'HARNESS TIMEOUT' }), TURN_TIMEOUT_MS)),
    ]);
    const entry = {
      id: query.id, query: query.text, frameAttached: query.attachFrame, sentAtUtc: t0, finishedAtUtc: ts(),
      sseEventCount: turn.turn?.events ?? 0, ok: turn.turn?.ok ?? false, error: turn.turn?.error ?? (turn.turn ? null : 'no turn (session unavailable or timeout)'),
      httpStatus: turn.turn?.status ?? null, firstTokenMs: turn.turn?.firstTokenMs ?? null, totalMs: turn.turn?.totalMs ?? null, answerChars: turn.turn?.chars ?? 0,
      attachment: turn.turn?.attachment ?? null, apiCalls: turn.apiCalls, answerPreview: turn.lastMessage?.role === 'assistant' ? String(turn.lastMessage.text).slice(0, 400) : null, lastMessage: turn.lastMessage, statusText: turn.statusText,
    };
    result.turns.push(entry);
    log('turn', query.id, JSON.stringify({ ok: entry.ok, events: entry.sseEventCount, status: entry.httpStatus, error: entry.error }));
  }
  result.apiCalls = await page.evaluate(() => window.__godsEyeView.entityChat.getState().apiCalls);
  await page.evaluate(() => { const v = window.__godsEyeView?.viewer; if (v) v.useDefaultRenderLoop = false; });
  await page.screenshot({ path: shot('chat-after-1440x900') }); result.shots.after = 'chat-after-1440x900.png'; result.shots.afterAt = ts();
  {
    const r = await page.evaluate(() => document.getElementById('ondemand-entity-chat')?.getBoundingClientRect().toJSON());
    if (r && r.width > 0) await page.screenshot({ path: shot('chat-after-crop'), clip: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(1440 - Math.max(0, r.x - 8), r.width + 16), height: Math.min(900 - Math.max(0, r.y - 8), r.height + 16) } }), (result.shots.afterCrop = 'chat-after-crop.png');
  }
  result.finishedAt = ts();
} catch (error) {
  result.error = String((error && error.stack) || error);
  log('ERROR', String(error));
} finally {
  clearTimeout(capTimer);
  await browser.close().catch(() => {});
  hardKill();
}
const outJson = path.join(outDir, 'chat-harness.json');
fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log('RESULT_JSON', outJson);
console.log(result.failures.length ? `CHAT HARNESS STRUCTURE FAIL — ${result.failures.join(' | ')}` : `CHAT HARNESS STRUCTURE OK — configured=${result.configured}; turns ${result.turns.map((t) => `${t.id}:${t.ok ? 'ok' : 'fail'}/events=${t.sseEventCount}/http=${t.httpStatus}`).join(', ')}`);
process.exitCode = result.error || result.failures.length ? 1 : 0;
