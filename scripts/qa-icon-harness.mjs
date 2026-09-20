#!/usr/bin/env node
/**
 * Icon / DATA LAYERS verification harness (headless Chromium via the repo's puppeteer).
 *
 *   node scripts/qa-icon-harness.mjs --url https://<preview> --scene austin|galveston --scope 53|90 --out <dir> [--settle 45000]
 *
 * scope 53  = the 2026-09-20 04:04Z pass: five MOVEMENT toggles + Data Centers enabled after the share-link
 *             camera restore; DATA LAYERS / DISPLAY / Global Context panels expanded; document-wide count.
 * scope 90  = the 2026-09-19 08:57Z–10:20Z sweep as documented in docs/audit/closeout-2026-09-19.md: five
 *             MOVEMENT toggles + Directions + Radio + Space Missions + Earthquakes, EVERY collapsible panel
 *             expanded (incl. Global Context), 55 s settle; document-wide count; +1 with ASK ONDEMAND open.
 * Output: <out>/<scene>-scope<scope>.json plus PNG proofs (full viewport, DATA LAYERS panel, DISPLAY panel,
 * header crop, chat overlay). Runs in its own process; the browser is closed on every exit path.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const baseUrl = args.url; const sceneKey = args.scene; const scope = String(args.scope || '53'); const outDir = args.out || '.';
const SETTLE_MS = Number(args.settle || (scope === '90' ? 55000 : 45000));
if (!baseUrl || !sceneKey) { console.error('usage: --url <base> --scene austin|galveston --scope 53|90 --out <dir>'); process.exit(2); }
const SCENES = {
  austin: { label: 'Austin (MGRS 14R PU 1994 4730)', hash: '#lat=30.25146&lon=-97.7533&alt=800&heading=0&pitch=-35&v=2&hv=1&hud=tactical', lat: 30.25146, lon: -97.7533 },
  galveston: { label: 'Galveston Bay', hash: '#lat=29.45&lon=-94.85&alt=45000&heading=0&pitch=-55&v=2&hv=1&hud=tactical', lat: 29.45, lon: -94.85 },
};
const scene = SCENES[sceneKey];
const MOVEMENT = ['Satellites', 'Live Flights', 'Military Flights', 'Live Vessels', 'Street Traffic'];
// scope 90 enables Space Missions FIRST: `rocket-launches` is a Global-Context dependency and entering that mode
// isolates the non-context layers; enabling the five MOVEMENT toggles afterwards restores them (measured 2026-09-20).
const LAYERS = scope === '90' ? ['Space Missions (30d)', 'Radio', 'Directions', 'Earthquakes (24h)', ...MOVEMENT] : [...MOVEMENT, 'Data Centers'];
const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
fs.mkdirSync(outDir, { recursive: true });
const prefix = path.join(outDir, `${sceneKey}-scope${scope}`);
const result = { scene: scene.label, sceneKey, scope, baseUrl, layersRequested: LAYERS, settleMs: SETTLE_MS, startedAt: ts(), network: { total: 0, status502: [], status5xx: [] }, console: { errors: [], pageErrors: [] } };

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 300000,
});
const cam = (page) => page.evaluate(() => { const c = window.__godsEyeView.viewer.camera.positionCartographic; const d = Math.PI / 180; return { lat: +(c.latitude / d).toFixed(5), lon: +(c.longitude / d).toFixed(5), altM: Math.round(c.height) }; });
try {
  const page = await browser.newPage();
  page.on('response', (r) => { result.network.total++; const s = r.status(); if (s === 502) result.network.status502.push(r.url()); else if (s >= 500) result.network.status5xx.push(`${s} ${r.url()}`); });
  page.on('console', (m) => { if (m.type() === 'error') result.console.errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => result.console.pageErrors.push(String(e.message).slice(0, 200)));
  const url = `${baseUrl}/?welcome=0${scene.hash}`; result.url = url;
  log('goto', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager && document.querySelectorAll('#data-toggles [data-layer-id]').length >= 18, { timeout: 90000 });
  result.appReadyAt = ts();
  await page.waitForFunction((lat, lon) => { const v = window.__godsEyeView?.viewer; if (!v) return false; const c = v.camera.positionCartographic; const d = Math.PI / 180; return Math.abs(c.latitude / d - lat) < 0.08 && Math.abs(c.longitude / d - lon) < 0.08; }, { timeout: 60000 }, scene.lat, scene.lon).catch(() => { result.cameraRestore = 'TIMEOUT'; });
  result.cameraRestoredAt = ts(); result.cameraAfterRestore = await cam(page);
  // enable layers by DATA LAYERS row name, after the camera restore
  result.layersEnabled = await page.evaluate(async (names) => {
    const m = window.__godsEyeView.dataManager; const out = [];
    const rows = [...document.querySelectorAll('#data-toggles [data-layer-id]')];
    for (const name of names) {
      const row = rows.find((r) => r.querySelector('.data-name')?.textContent.trim() === name); const id = row?.dataset.layerId;
      if (!id) { out.push({ name, id: null, error: 'row not found' }); continue; }
      let en = false; try { en = m.isEnabled(id); } catch {}
      let action = en ? 'already-on' : 'setEnabled';
      if (!en) { try { await m.setEnabled(id, true, { origin: 'user' }); await new Promise((r) => setTimeout(r, 400)); } catch (e) { action = 'error: ' + e.message; } }
      let now = null; try { now = m.isEnabled(id); } catch {}
      out.push({ name, id, action, enabled: now });
    }
    return out;
  }, LAYERS);
  log('layers', JSON.stringify(result.layersEnabled));
  // expand panels
  result.panels = await page.evaluate((all) => {
    const out = {};
    // #left-panel-stack shows one expanded panel at a time: expanding cctv-panel / scene-panel would collapse DATA LAYERS,
    // so those two siblings are left collapsed and data-panel is (re-)expanded last.
    const targets = all ? [...document.querySelectorAll('.panel-collapsible.collapsed')].filter((el) => !['cctv-panel', 'scene-panel'].includes(el.id)) : ['data-panel', 'pp-toggles', 'global-context-panel'].map((id) => document.getElementById(id)).filter(Boolean);
    for (const el of targets) { const id = el.id || el.dataset.panelId || el.className; if (el.classList.contains('collapsed')) el.querySelector('.panel-collapse-btn')?.click(); out[id] = el.classList.contains('collapsed') ? 'still-collapsed' : 'expanded'; }
    const dp = document.getElementById('data-panel'); if (dp?.classList.contains('collapsed')) { dp.querySelector('.panel-collapse-btn')?.click(); out['data-panel'] = dp.classList.contains('collapsed') ? 'still-collapsed' : 'expanded (re-expanded last)'; }
    return out;
  }, scope === '90');
  log('panels', JSON.stringify(result.panels));
  log(`settling ${SETTLE_MS} ms`); await new Promise((r) => setTimeout(r, SETTLE_MS)); result.settledAt = ts(); result.cameraAfterSettle = await cam(page);
  const pauseRender = (on) => page.evaluate((on) => { const v = window.__godsEyeView?.viewer; if (v) v.useDefaultRenderLoop = !on; return !!v; }, on);
  await pauseRender(true);
  const collect = () => page.evaluate(() => {
    const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/gu; const GLYPH = /[\u21BB\u21C4]/g; const count = (s, re) => (String(s || '').match(re) || []).length;
    const PANEL_IDS = ['data-panel', 'pp-toggles', 'global-context-panel', 'military-awareness-panel', 'radio-panel', 'context-radio-dock', 'space-mission-panel-host', 'cctv-panel', 'scene-panel', 'title-bar', 'top-center-actions', 'command-dock', 'control-panel', 'cockpit', 'cockpit-display-panel', 'cockpit-radio-panel', 'ondemand-entity-chat', 'key-setup', 'hud', 'welcome'];
    const panelOf = (el) => { let n = el; while (n && n !== document.body) { if (n.id && PANEL_IDS.some((p) => n.id === p || n.id.startsWith(p + '-') || n.id.startsWith(p))) return n.id; n = n.parentElement; } let m = el; while (m && m !== document.body) { if (m.id) return 'other:#' + m.id; m = m.parentElement; } return 'other:body'; };
    const icons = [...document.querySelectorAll('svg[data-icon]')];
    const perPanel = {}; const strokeSet = {}; let black = 0; const blackNames = []; const rowsOfPanel = {};
    for (const s of icons) {
      const p = panelOf(s); const sw = s.getAttribute('stroke-width'); const cs = getComputedStyle(s); const r = s.getBoundingClientRect();
      perPanel[p] = perPanel[p] || { total: 0, stroke175: 0, visible: 0, names: {} }; perPanel[p].total++; if (sw === '1.75') perPanel[p].stroke175++; if (r.width > 0 && r.height > 0) perPanel[p].visible++;
      perPanel[p].names[s.dataset.icon] = (perPanel[p].names[s.dataset.icon] || 0) + 1;
      strokeSet[sw] = (strokeSet[sw] || 0) + 1; if (cs.color === 'rgb(0, 0, 0)' || cs.stroke === 'rgb(0, 0, 0)') { black++; blackNames.push(s.dataset.icon); }
    }
    const rows = [...document.querySelectorAll('#data-toggles [data-layer-id]')].map((r) => { const svg = r.querySelector('svg[data-icon]'); const rect = svg?.getBoundingClientRect(); const cs = svg ? getComputedStyle(svg) : null; const btn = r.querySelector('.data-toggle-btn'); const sub = [...r.querySelectorAll('*')].filter((e) => e.children.length === 0 && e !== btn && !e.closest('.data-name') && !e.closest('.data-count') && e.textContent.trim()).map((e) => e.textContent.trim()); const name = r.querySelector('.data-name')?.textContent.trim(); return { id: r.dataset.layerId, name, badge: btn?.textContent.trim(), feedState: btn?.dataset.feedState, subtext: sub.filter((t) => t !== name).join(' | ').slice(0, 200), icon: svg ? { name: svg.dataset.icon, w: +rect.width.toFixed(1), h: +rect.height.toFixed(1), strokeAttr: svg.getAttribute('stroke-width'), strokeComputed: cs.strokeWidth, color: cs.color, ariaHidden: svg.getAttribute('aria-hidden') } : null }; });
    const panel = document.getElementById('data-panel'); const docText = document.body.innerText || document.body.textContent;
    const titleBar = document.getElementById('title-bar'); const lockupImg = titleBar?.querySelector('picture.brand-wordmark-logo img, img[src*="logo"]'); const shareSvg = document.querySelector('#share-btn svg[data-icon]'); const clearBtn = document.getElementById('clear-selected-layers'); const clearSvg = clearBtn?.querySelector('svg[data-icon]'); const clearRect = clearSvg?.getBoundingClientRect(); const clearCs = clearSvg ? getComputedStyle(clearSvg) : null;
    const material = [...document.querySelectorAll('.material-symbols-outlined, .material-icons, [class*="material-symbols"]')];
    const matVisible = material.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const matById = {}; for (const e of material) { const p = panelOf(e); matById[p] = (matById[p] || 0) + 1; }
    return {
      svgDataIconCount: icons.length, strokeWidths: strokeSet, blackIcons: black, blackIconNames: blackNames, perPanel,
      rows, rowCount: rows.length, rowsInlineSvg18: rows.filter((r) => r.icon && Math.round(r.icon.w) === 18 && Math.round(r.icon.h) === 18 && r.icon.strokeAttr === '1.75' && r.icon.ariaHidden === 'true').length,
      rowsStroke175Computed: rows.filter((r) => r.icon && r.icon.strokeComputed === '1.75px').length, rowIconsBlack: rows.filter((r) => r.icon && r.icon.color === 'rgb(0, 0, 0)').length,
      emojiDataLayersText: count(panel?.textContent, EMOJI), emojiDataLayersMarkup: count(panel?.innerHTML, EMOJI), emojiDocument: count(docText, EMOJI), glyphsText: count(docText, GLYPH), glyphsMarkup: count(document.body.innerHTML, GLYPH),
      unavailableBadges: rows.filter((r) => /UNAVAILABLE/i.test(r.badge || '')).length, unavailableStrings: count(panel?.textContent, /UNAVAILABLE/g), http502Strings: count(docText, /HTTP 502/g),
      header: { titleBarPresent: !!titleBar, lockup: lockupImg ? { src: lockupImg.getAttribute('src'), loaded: lockupImg.complete && lockupImg.naturalWidth > 0, naturalWidth: lockupImg.naturalWidth } : null, title: titleBar?.querySelector('h1')?.textContent.replace(/\s+/g, ' ').trim(), subtitle: titleBar?.querySelector('.subtitle')?.textContent.trim(), shareLinkIcon: shareSvg ? { dataIcon: shareSvg.dataset.icon, strokeAttr: shareSvg.getAttribute('stroke-width'), visible: shareSvg.getBoundingClientRect().width > 0 } : null },
      clearLayers: clearBtn ? { hasSvgIcon: !!clearSvg, dataIcon: clearSvg?.dataset.icon || null, w: clearRect ? +clearRect.width.toFixed(1) : null, h: clearRect ? +clearRect.height.toFixed(1) : null, strokeAttr: clearSvg?.getAttribute('stroke-width') || null, strokeComputed: clearCs?.strokeWidth || null, color: clearCs?.color || null, materialInside: !!clearBtn.querySelector('.material-symbols-outlined'), innerHTML: clearBtn.innerHTML.replace(/\s+/g, ' ').trim().slice(0, 200) } : null,
      materialSymbols: { total: material.length, visible: matVisible.length, byPanel: matById, ligatures: material.slice(0, 40).map((e) => e.textContent.trim()) },
      rects: { titleBar: titleBar?.getBoundingClientRect().toJSON(), clearBtn: clearBtn?.getBoundingClientRect().toJSON(), share: document.getElementById('share-btn')?.getBoundingClientRect().toJSON(), dataPanel: panel?.getBoundingClientRect().toJSON(), pp: document.getElementById('pp-toggles')?.getBoundingClientRect().toJSON() },
    };
  });
  result.dom = await collect(); result.assertedAt = ts();
  log('svg', result.dom.svgDataIconCount, JSON.stringify(result.dom.strokeWidths), 'rows18', result.dom.rowsInlineSvg18, 'unavail', result.dom.unavailableBadges, 'clear', JSON.stringify(result.dom.clearLayers && { icon: result.dom.clearLayers.dataIcon, w: result.dom.clearLayers.w, sw: result.dom.clearLayers.strokeAttr, material: result.dom.clearLayers.materialInside }));
  // screenshots
  const clip = async (file, r, pad = 4) => { if (!r || r.width < 2 || r.height < 2) return null; const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad); await page.screenshot({ path: file, clip: { x, y, width: Math.min(1440 - x, r.width + 2 * pad), height: Math.min(900 - y, r.height + 2 * pad) } }); return file; };
  result.shots = {}; await page.screenshot({ path: `${prefix}-full.png` }); result.shots.full = `${prefix}-full.png`;
  result.shots.dataLayers = await clip(`${prefix}-data-layers.png`, result.dom.rects.dataPanel);
  { const r = result.dom.rects; const boxes = [r.titleBar, r.clearBtn, r.share].filter(Boolean); if (boxes.length) { const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 8), y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 8), x1 = Math.min(1440, Math.max(...boxes.map((b) => b.x + b.width)) + 8), y1 = Math.min(900, Math.max(...boxes.map((b) => b.y + b.height)) + 8); await page.screenshot({ path: `${prefix}-header.png`, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }); result.shots.header = `${prefix}-header.png`; } }
  if (result.dom.rects.clearBtn) result.shots.clearLayers = await clip(`${prefix}-clear-layers.png`, result.dom.rects.clearBtn, 12);
  // DISPLAY panel (hidden by the tactical HUD layout at 1440x900 → forced visible for the capture only)
  result.displayPanel = await page.evaluate(() => { const pp = document.getElementById('pp-toggles'); if (!pp) return null; const hidden = getComputedStyle(pp).display === 'none'; if (hidden) { pp.dataset.qaForced = '1'; pp.style.display = 'block'; pp.style.visibility = 'visible'; pp.style.opacity = '1'; pp.classList.remove('collapsed'); } const r = pp.getBoundingClientRect(); return { wasHidden: hidden, rect: r.toJSON(), icons: pp.querySelectorAll('svg[data-icon]').length, strokes: [...new Set([...pp.querySelectorAll('svg[data-icon]')].map((s) => s.getAttribute('stroke-width')))] }; });
  if (result.displayPanel?.rect) result.shots.display = await clip(`${prefix}-display.png`, result.displayPanel.rect);
  await page.evaluate(() => { const pp = document.getElementById('pp-toggles'); if (pp?.dataset.qaForced) { pp.style.display = ''; pp.style.visibility = ''; pp.style.opacity = ''; delete pp.dataset.qaForced; } });
  // ASK ONDEMAND overlay (+1 icon)
  await pauseRender(false);
  result.chat = await page.evaluate(async () => { const ec = window.__godsEyeView.entityChat; if (!ec) return { error: 'entityChat not exposed' }; let opened = null; for (const k of ['aircraft', 'vessel', 'satellite']) { try { const r = await ec.openFirstVisible(k); if (r !== false) { opened = k; break; } } catch (e) { opened = 'error:' + e.message; } } await new Promise((r) => setTimeout(r, 2500)); const icons = [...document.querySelectorAll('svg[data-icon]')]; const set = {}; for (const s of icons) { const a = s.getAttribute('stroke-width'); set[a] = (set[a] || 0) + 1; } const closeBtn = document.querySelector('.od-chat__close svg[data-icon]'); const root = closeBtn?.closest('[id]'); return { opened, svgDataIconCount: icons.length, strokeWidths: set, closeIcon: closeBtn ? { dataIcon: closeBtn.dataset.icon, strokeAttr: closeBtn.getAttribute('stroke-width') } : null, chatVisible: root ? root.getBoundingClientRect().width > 0 : false }; });
  await pauseRender(true);
  if (result.chat?.chatVisible) { await page.screenshot({ path: `${prefix}-chat.png` }); result.shots.chat = `${prefix}-chat.png`; }
  result.domWithChat = await collect();
  await page.evaluate(() => { try { document.querySelector('.od-chat__close')?.click(); } catch {} });
  result.finishedAt = ts();
} catch (e) {
  result.error = String((e && e.stack) || e); log('ERROR', result.error);
} finally {
  await browser.close().catch(() => {});
}
fs.writeFileSync(`${prefix}.json`, JSON.stringify(result, null, 2));
console.log('RESULT_JSON', `${prefix}.json`);
process.exitCode = result.error ? 1 : 0;
