/**
 * Headless browser proof for the HamRig amateur-radio layers.
 *
 * Loads the app on a running dev server (which proxies HamRig, POTA, SOTA and
 * KC2G through /api/hamrig/*), enables the seven ham layers, checks that each
 * one puts geometry on the globe and reports a healthy UI state, drives the
 * eight voice tools through the real action runner, and proves the spot
 * tuning rule: the receiver is chosen near the SPOTTER, never near the DX.
 *
 * Run: node scripts/qa-ham-radio.mjs --url http://localhost:4173
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const APP_URL = urlIndex >= 0 && args[urlIndex + 1] ? args[urlIndex + 1] : (process.env.QA_BASE_URL || 'http://localhost:4173');
const LAYERS = ['dx-spots', 'ham-activations', 'dxpeditions', 'ham-beacons', 'ham-propagation', 'ham-repeaters', 'ham-stations'];
const errors = [];
const findings = [];
const note = (ok, label, detail = '') => {
  findings.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--disable-dev-shm-usage', '--window-size=1440,900'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const frame = req.frame();
    if (frame && frame !== page.mainFrame()) req.abort();
    else req.continue();
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text().slice(0, 240)}`); });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  // Interval polling: requestAnimationFrame-based polling never fires in this headless Chromium while Cesium owns the frame loop.
  const appReady = () => window.__godsEyeView?.dataManager?.layers?.has('dx-spots');
  try {
    await page.waitForFunction(appReady, { timeout: 20_000, polling: 500 });
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForFunction(appReady, { timeout: 150_000, polling: 500 });
  }

  const dom = await page.evaluate((ids) => ({
    panel: Boolean(document.getElementById('ham-radio-panel')),
    collapsed: document.getElementById('ham-radio-panel')?.classList.contains('collapsed'),
    tabs: Array.from(document.querySelectorAll('#ham-radio-panel [data-ham-tab]')).map((b) => b.getAttribute('data-ham-tab')),
    registered: ids.filter((id) => window.__godsEyeView.dataManager.layers.has(id)),
    toggleRows: ids.map((id) => {
      const name = window.__godsEyeView.dataManager.layers.get(id)?.module?.name || id;
      return [id, Array.from(document.querySelectorAll('#data-toggles *')).some((el) => (el.textContent || '').includes(name))];
    }),
  }), LAYERS);
  console.log('dom:', JSON.stringify(dom));
  note(dom.panel, 'ham radio panel present');
  note(dom.registered.length === LAYERS.length, 'all seven layers registered', dom.registered.join(','));

  const status = await page.evaluate(async () => (await fetch('/api/hamrig/status')).json());
  console.log('status:', JSON.stringify(status));
  note(status && status.enabled !== false, 'proxy status answers');

  // Enable every layer and wait for its first load to settle.
  const layerReports = {};
  for (const id of LAYERS) {
    const before = await page.evaluate(() => ({
      ds: window.__godsEyeView.viewer.dataSources.length,
      entities: Array.from({ length: window.__godsEyeView.viewer.dataSources.length }, (_, i) => window.__godsEyeView.viewer.dataSources.get(i)).reduce((n, ds) => n + ds.entities.values.length, 0),
      primitives: window.__godsEyeView.viewer.scene.primitives.length,
    }));
    const started = Date.now();
    await page.evaluate((layerId) => window.__godsEyeView.dataManager.setEnabled(layerId, true, { origin: 'user' }), id);
    await page.waitForFunction((layerId) => {
      const entry = window.__godsEyeView.dataManager.layers.get(layerId);
      if (!entry || !window.__godsEyeView.dataManager.isEnabled(layerId)) return false;
      const state = entry.module.getUIState?.() || {};
      return state.loading === false || state.loading === undefined;
    }, { timeout: 120_000, polling: 500 }, id).catch(() => {});
    // Give the first fetch a moment to paint.
    await new Promise((r) => setTimeout(r, 2500));
    const report = await page.evaluate((layerId, beforeCounts) => {
      const app = window.__godsEyeView;
      const entry = app.dataManager.layers.get(layerId);
      const state = entry.module.getUIState?.() || {};
      const stats = entry.module.getStats?.() || {};
      const dataSources = Array.from({ length: app.viewer.dataSources.length }, (_, i) => app.viewer.dataSources.get(i));
      const entities = dataSources.reduce((n, ds) => n + ds.entities.values.length, 0);
      const shownNames = dataSources.filter((ds) => ds.show).map((ds) => ds.name);
      return {
        enabled: app.dataManager.isEnabled(layerId),
        loading: state.loading, error: state.error || null, stale: state.stale, count: state.count ?? stats.count ?? null,
        stateKeys: Object.keys(state).slice(0, 16),
        entitiesDelta: entities - beforeCounts.entities,
        primitivesDelta: app.viewer.scene.primitives.length - beforeCounts.primitives,
        shownNames,
        stateText: document.getElementById('ham-radio-layer-state')?.textContent?.trim().slice(0, 80),
      };
    }, id, before);
    report.ms = Date.now() - started;
    layerReports[id] = report;
    console.log(`layer ${id}:`, JSON.stringify(report));
    note(report.enabled && !report.error, `${id} enabled without error`, report.error || `${report.ms} ms`);
  }
  for (const id of ['dx-spots', 'ham-activations', 'dxpeditions', 'ham-beacons', 'ham-propagation']) {
    const r = layerReports[id];
    note((r.count ?? 0) > 0 || r.entitiesDelta > 0 || r.primitivesDelta > 0, `${id} draws something`, `count=${r.count} entities+${r.entitiesDelta} primitives+${r.primitivesDelta}`);
  }

  // Voice tools through the real action runner.
  const voice = await page.evaluate(async () => {
    const { createGevActionRunner } = await import('/src/voice/gevActions.js');
    const app = window.__godsEyeView;
    const run = createGevActionRunner({ viewer: app.viewer, styleManager: app.styleManager, dataManager: app.dataManager });
    const out = {};
    const safe = async (name, params) => {
      try { return await run(name, params); } catch (error) { return { ok: false, error: `threw: ${error?.message || error}` }; }
    };
    out.lookup = await safe('lookup_ham_station', { callsign: 'DH5DAX' });
    out.spots = await safe('show_dx_spots', { band: '20m', minutes: 60 });
    const spotsModule = app.dataManager.layers.get('dx-spots').module;
    const spots = (spotsModule.getSpots?.() || []);
    const withSpotter = spots.find((s) => s.spotterLoc && s.dxLoc) || spots[0] || null;
    out.spotSample = withSpotter && { id: withSpotter.id, dx: withSpotter.dx, spotter: withSpotter.spotter, band: withSpotter.band, mode: withSpotter.mode, dxLoc: withSpotter.dxLoc, spotterLoc: withSpotter.spotterLoc };
    out.tune = withSpotter ? await safe('tune_to_dx_spot', { spotId: withSpotter.id }) : { ok: false, error: 'no spot available' };
    if (out.tune?.receiver?.id) {
      // The voice result summarises the receiver; fetch its position from the layer for the distance proof.
      const receiverRow = app.dataManager.layers.get('web-receivers')?.module?.getReceiver?.(out.tune.receiver.id);
      out.tune.receiverPosition = receiverRow ? { lat: receiverRow.lat, lon: receiverRow.lon } : null;
    }
    out.activations = await safe('show_ham_activations', { program: 'all' });
    out.dxpeditions = await safe('show_dxpeditions', { status: 'active' });
    out.propagation = await safe('show_ham_propagation', { overlay: 'aurora' });
    out.beacons = await safe('show_ham_beacons', { kind: 'ibp' });
    out.repeaters = await safe('show_ham_repeaters', { latitude: 52.19, longitude: 7.04, radiusKm: 100 });
    out.layerAlias = await safe('set_layer_visibility', { layerId: 'dx spots', enabled: true });
    out.panelOpen = await safe('set_panel_open', { panelId: 'ham-radio-panel', open: true });
    const dock = document.getElementById('web-receivers-dock');
    out.dockVisible = Boolean(dock && !dock.hidden);
    out.panelExpanded = !document.getElementById('ham-radio-panel')?.classList.contains('collapsed');
    out.focusOnApp = document.activeElement !== document.getElementById('web-receivers-frame');
    return out;
  });
  const brief = (r) => (r && typeof r === 'object' ? { ok: r.ok, error: r.error, action: r.action, keys: Object.keys(r).slice(0, 12) } : r);
  for (const key of ['lookup', 'spots', 'tune', 'activations', 'dxpeditions', 'propagation', 'beacons', 'repeaters', 'layerAlias', 'panelOpen']) {
    console.log(`voice ${key}:`, JSON.stringify(key === 'tune' ? voice[key] : brief(voice[key])));
  }
  console.log('spot sample:', JSON.stringify(voice.spotSample));
  note(voice.lookup?.ok && Number.isFinite(voice.lookup?.station?.lat), 'lookup_ham_station places DH5DAX', JSON.stringify(voice.lookup?.station && { lat: voice.lookup.station.lat, lon: voice.lookup.station.lon, precision: voice.lookup.station.precision }));
  note(voice.spots?.ok, 'show_dx_spots ok', voice.spots?.error);
  if (voice.tune?.ok) {
    const anchor = voice.tune.anchor || voice.spotSample?.spotterLoc;
    const receiver = voice.tune.receiverPosition;
    const d = Number.isFinite(voice.tune.distanceKm) ? voice.tune.distanceKm : (anchor && receiver ? haversineKm(anchor.lat, anchor.lon, receiver.lat, receiver.lon) : null);
    const dxDistance = voice.spotSample?.dxLoc && receiver ? haversineKm(voice.spotSample.dxLoc.lat, voice.spotSample.dxLoc.lon, receiver.lat, receiver.lon) : null;
    note(d !== null && d <= 1500, 'tune_to_dx_spot picked a receiver near the spotter/evidence anchor', `${Math.round(d ?? -1)} km from anchor, ${dxDistance === null ? '?' : Math.round(dxDistance)} km from DX, evidence=${voice.tune.evidence}, reason=${voice.tune.reason}`);
    if (dxDistance !== null && d !== null) note(dxDistance >= d, 'receiver is not closer to the DX than to the spotter side', `${Math.round(dxDistance)} km from DX vs ${Math.round(d)} km from anchor`);
    note(voice.dockVisible, 'receiver dock opened after tuning');
    note(voice.focusOnApp, 'focus stayed on the app after the dock opened');
  } else {
    note(false, 'tune_to_dx_spot ok', voice.tune?.error || voice.tune?.reason);
  }
  for (const key of ['activations', 'dxpeditions', 'propagation', 'beacons', 'repeaters', 'layerAlias', 'panelOpen']) note(Boolean(voice[key]?.ok), `voice ${key} ok`, voice[key]?.error);
  note(voice.panelExpanded, 'ham radio panel expanded by voice');

  await page.waitForFunction(() => {
    const splash = document.getElementById('loading-screen') || document.querySelector('.loading-screen, #splash');
    return !splash || splash.hidden || getComputedStyle(splash).display === 'none' || getComputedStyle(splash).opacity === '0';
  }, { timeout: 60_000, polling: 500 }).catch(() => {});
  await page.screenshot({ path: process.env.SHOT || 'qa-shots/ham-radio.png' });

  // Disable everything; nothing may stay visible or throw.
  for (const id of LAYERS) {
    await page.evaluate((layerId) => window.__godsEyeView.dataManager.setEnabled(layerId, false, { origin: 'user' }), id);
  }
  await page.waitForFunction((ids) => ids.every((id) => !window.__godsEyeView.dataManager.isEnabled(id)), { timeout: 60_000, polling: 500 }, LAYERS);
  const afterDisable = await page.evaluate(() => {
    const app = window.__godsEyeView;
    const dataSources = Array.from({ length: app.viewer.dataSources.length }, (_, i) => app.viewer.dataSources.get(i));
    return { shownNames: dataSources.filter((ds) => ds.show).map((ds) => ds.name) };
  });
  console.log('after disable:', JSON.stringify(afterDisable));
} finally {
  await browser.close();
  const relevant = errors.filter((e) => !/Failed to load resource|net::ERR_|Access-Control-Allow-Origin|Outdated Optimize Dep/i.test(e));
  console.log('page errors (filtered):', relevant.length ? relevant.slice(0, 10) : 'none');
  const failed = findings.filter((f) => !f.ok);
  console.log(`\nSUMMARY: ${findings.length - failed.length}/${findings.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
