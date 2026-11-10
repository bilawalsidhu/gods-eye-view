// Cesium-only probes: native primitive and streamed-tile positions provide the Cesium floor oracle.
import { evaluateWithGeo } from './qa/geometry.mjs';
import { whenSettled } from './qa/ready.mjs';
// scripts/qa-floor-verify.mjs — live floor verification at AUS (round 5).
// Pins the camera at Austin airport, enables flights, waits ~3 polls, then
// measures every nearby contact's render height against the ACTUAL rendered
// mesh (sprite- and model-excluded scene.sampleHeight probes). Caught the mesh-latch
// coarse-LOD poison and the taxiing cold-cell regression on 2026-07-06.
// Run: node scripts/qa-floor-verify.mjs   (dev server on :4173, real GPU best)
// with the poison fix + simplified chain live.
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs';

// QA_BASE_URL matches the sibling harnesses (qa-height-datum / qa-cctv-v2) so a
// secondary checkout can verify against its own dev server instead of the default :4173.
const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
// --engine=cesium|navara: on Navara the camera, the mesh probes and
// the sprite census go through the engine and the QA probe.
const ENGINE = (process.argv.find((arg) => arg.startsWith('--engine=')) ?? '--engine=cesium').slice(9);
const APP_URL =
  ENGINE === 'cesium' ? BASE_URL : `${BASE_URL.replace(/\/$/, '')}/?engine=${ENGINE}`;
// CLI: --lat --lon --floor-min --floor-max (defaults: Austin airport)
const argv = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.replace(/^--/, ''), Number(v)]));
const SITE = {
  lat: Number.isFinite(argv.lat) ? argv.lat : 30.197,
  lon: Number.isFinite(argv.lon) ? argv.lon : -97.666,
  floorMin: Number.isFinite(argv['floor-min']) ? argv['floor-min'] : 100,
  floorMax: Number.isFinite(argv['floor-max']) ? argv['floor-max'] : 250,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Prefer puppeteer's version-pinned Chrome-for-Testing over the system Chrome
// (2026-07-30 lesson, already applied to the other harnesses): /Applications
// auto-updates underneath the harnesses and its software-GL behavior shifts
// across majors.

const browser = await launchBrowser({
  headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.engine, { timeout: 150000 });
await whenSettled(page);

// Let the app's boot fly-to fully settle FIRST (it was overriding an early
// setView, leaving the camera away from Austin — every probe then read
// coarse global tiles at ~25 m and the oracle was garbage).
await whenSettled(page);
await page.evaluate((site) => { window.__QA_SITE = site; }, SITE);
const camPin = async () => evaluateWithGeo(page, async (qaGeo) => {
  const v = window.__godsEyeView.viewer;
  if (!v) {
    const geo = await import('/src/geo/index.js');
    const { camera } = window.__godsEyeView.engine;
    camera.cancelFlight();
    camera.setView({ destination: geo.cartesian3.fromDegrees(window.__QA_SITE.lon, window.__QA_SITE.lat, 3000) });
    const c = camera.pose().cartographic;
    return { lat: +(c.latitude * 180 / Math.PI).toFixed(3), lon: +(c.longitude * 180 / Math.PI).toFixed(3), h: Math.round(c.height) };
  }
  const C = qaGeo.cartographic;
  window.__godsEyeView.engine.camera.cancelFlight();
  window.__godsEyeView.engine.camera.setView({ destination: qaGeo.cartographic.toCartesian(C.fromDegrees(window.__QA_SITE.lon, window.__QA_SITE.lat, 3000)) });
  window.__godsEyeView.engine.camera.moveEnd.raiseEvent();
  const c = window.__godsEyeView.engine.camera.pose().cartographic;
  return { lat: +(c.latitude * 180 / Math.PI).toFixed(3), lon: +(c.longitude * 180 / Math.PI).toFixed(3), h: Math.round(c.height) };
});
console.log('camera pinned:', JSON.stringify(await camPin()));
await page.evaluate(async () => { await window.__godsEyeView.dataManager.toggle('flights'); });
console.log('waiting 100s: tiles stream + 3 polls...');
await sleep(100000);
// re-pin + report readiness right before probing
console.log('camera at probe time:', JSON.stringify(await camPin()));
const ready = await page.evaluate(() => {
  const v = window.__godsEyeView.viewer;
  if (!v) return { tilesLoaded: window.__godsEyeView.engine.surface.tilesLoaded() };
  const prims = v.scene.primitives;
  for (let i = 0; i < prims.length; i++) {
    const p = prims.get(i);
    if (p && p.tilesLoaded !== undefined && p.show) return { tilesLoaded: !!p.tilesLoaded };
  }
  return { tilesLoaded: null };
});
console.log('tileset ready:', JSON.stringify(ready));
await sleep(8000);

const report = await evaluateWithGeo(page, async (qaGeo) => {
  const gev = window.__godsEyeView;
  const v = gev.viewer;
  const layer = gev.dataManager.layers.get('flights')?.module;
  if (!layer) return { err: 'no flights module' };
  if (!v) {
    // The engine path: mesh probes through engine.surface, excluding the
    // layer's own mover sets; the census from the probe's drawn().
    const geo = await import('/src/geo/index.js');
    const { engine } = gev;
    const center = geo.cartesian3.fromDegrees(window.__QA_SITE.lon, window.__QA_SITE.lat, 200);
    const nearby = layer.getNearby(center, 15000, 60);
    const exclude = engine.movers.list().map(({ id }) => id).filter((id) => id.startsWith('flights'));
    // The app's own ground floor (the scene's surface services, not a fresh
    // import of the module).
    const { cachedGroundFloor } = gev.surfaceServices.groundFloor;
    const out = [];
    // A contact a 3D model draws is measured where the model is (its sprite
    // is hidden and keeps the pre-floor height by design, T7).
    const drawnRows = new Map((gev.layers.drawn('flights') ?? []).map((row) => [row.id, row]));
    const drawnAt = (p) => {
      const model = drawnRows.get(p.icao24 ?? p.id)?.model;
      return model?.show && model.ready && model.position ? model.position : null;
    };
    for (const p of nearby) {
      const modelAt = drawnAt(p);
      const c = geo.cartographic.fromCartesian(modelAt ?? p.position);
      const answer = engine.surface.sampleHeightDetailed(
        geo.cartographic.fromRadians(c.longitude, c.latitude, 0),
        { exclude },
      );
      const meshH = answer?.source === 'tiles' && Number.isFinite(answer.height) ? answer.height : null;
      out.push({
        id: p.id,
        renderAltM: +c.height.toFixed(1),
        drawnBy: modelAt ? 'model' : 'sprite',
        meshM: meshH != null ? +meshH.toFixed(1) : null,
        aboveMeshM: meshH != null ? +(c.height - meshH).toFixed(1) : null,
        // Why a contact sits where it does: the probe's own
        // answer (source, tile size) and the coarse DEM floor (the prior).
        probe: answer ? { source: answer.source, tileSizeM: answer.tileSizeM ?? null } : null,
        demFloorM: cachedGroundFloor(c.latitude * 180 / Math.PI, c.longitude * 180 / Math.PI) ?? null,
      });
    }
    let shown = 0, hidden = 0;
    for (const row of gev.layers.drawn('flights') ?? []) {
      if (!row.position) continue;
      const cc = geo.cartographic.fromCartesian(row.position);
      const la = cc.latitude * 180 / Math.PI, lo = cc.longitude * 180 / Math.PI;
      if (Math.abs(la - window.__QA_SITE.lat) > 0.08 || Math.abs(lo - window.__QA_SITE.lon) > 0.10) continue;
      if (row.show) shown++; else hidden++;
    }
    return { ausContacts: out.length, contacts: out.slice(0, 16), spritesShown: shown, spritesHidden: hidden };
  }
  const C = qaGeo.cartographic;
  const center = qaGeo.cartographic.toCartesian(C.fromDegrees(window.__QA_SITE.lon, window.__QA_SITE.lat, 200));
  const nearby = layer.getNearby(center, 15000, 60);
  // Exclude EVERY billboard from the probes — sprites are pickable, so an
  // unexcluded probe can return another aircraft's height as "the mesh".
  // Exclude every fleet/tracked 3D Model too: getNearby() also returns contacts
  // whose billboard is hidden because a model owns the visual, and those probes
  // would otherwise land on aircraft geometry. `activeAnimations` +
  // `minimumPixelSize` are Model-only — the 3D-Tiles tileset has neither, and
  // excluding IT would leave sampleHeight with no mesh to read at all.
  const excludes = [];
  const walk = (coll) => {
    const n = coll.length;
    for (let i = 0; i < n; i++) {
      let pr; try { pr = coll.get(i); } catch { continue; }
      if (!pr) continue;
      if (typeof pr.length === 'number' && typeof pr.get === 'function') { walk(pr); continue; }
      if (pr.image !== undefined && pr.alignedAxis !== undefined) { excludes.push(pr); continue; }
      if (pr.activeAnimations !== undefined && pr.minimumPixelSize !== undefined) excludes.push(pr);
    }
  };
  walk(v.scene.primitives);
  const drawnRows = new Map((gev.layers?.drawn('flights') ?? []).map((row) => [row.id, row]));
  const drawnAt = (p) => {
    const model = drawnRows.get(p.icao24 ?? p.id)?.model;
    return model?.show && model.ready && model.position ? model.position : null;
  };
  const out = [];
  for (const p of nearby) {
    const modelAt = drawnAt(p);
    const c = qaGeo.cartographic.fromCartesian(modelAt ?? p.position);
    const latDeg = c.latitude * 180 / Math.PI, lonDeg = c.longitude * 180 / Math.PI;
    let meshH = null;
    try {
      const h = window.__godsEyeView.engine.surface.sampleHeight(C.fromDegrees(lonDeg, latDeg), excludes);
      if (Number.isFinite(h)) meshH = h;
    } catch { /* ignore */ }
    out.push({
      id: p.id,
      renderAltM: +c.height.toFixed(1),
      drawnBy: modelAt ? 'model' : 'sprite',
      meshM: meshH != null ? +meshH.toFixed(1) : null,
      aboveMeshM: meshH != null ? +(c.height - meshH).toFixed(1) : null,
      // A contact whose sprite hides under a model that is not (yet) drawn.
      model: drawnRows.get(p.icao24 ?? p.id)?.model
        ? { show: drawnRows.get(p.icao24 ?? p.id).model.show, ready: drawnRows.get(p.icao24 ?? p.id).model.ready }
        : null,
      spriteShown: drawnRows.get(p.icao24 ?? p.id)?.show ?? null,
      // The coarse floor (mesh cell ?? DEM prior) the layer reads here.
      demFloorM: gev.surfaceServices?.groundFloor.cachedGroundFloor(latDeg, lonDeg) ?? null,
    });
  }
  // Visibility census (round 6): getNearby only returns contacts a sprite or a
  // 3D model is actually drawing, so also count every glyph the layer holds
  // (the probe's drawn rows) — a culled "invisible plane" shows up here. The
  // engine's batched billboards keep hidden spares, so they are not counted.
  let shown = 0, hidden = 0;
  for (const row of gev.layers?.drawn('flights') ?? []) {
    if (!row.position || row.trackedModel) continue;
    const cc = qaGeo.cartographic.fromCartesian(row.position);
    const la = cc.latitude * 180 / Math.PI, lo = cc.longitude * 180 / Math.PI;
    if (Math.abs(la - window.__QA_SITE.lat) > 0.08 || Math.abs(lo - window.__QA_SITE.lon) > 0.10) continue;
    if (row.show) shown++; else hidden++;
  }
  return { ausContacts: out.length, contacts: out.slice(0, 16), spritesShown: shown, spritesHidden: hidden };
});
console.log(JSON.stringify(report, null, 1));

// verdict — plausible mesh readings only (a wild meshM means the probe ray
// missed the tileset entirely; those rows prove nothing either way)
// Trust only probes that read a plausible AUS-area surface (~100..250 m
// ellipsoidal) — anything else hit a coarse tile or nothing (proves nothing).
const lows = (report.contacts || []).filter((c) =>
  c.renderAltM < SITE.floorMax + 450 && c.aboveMeshM != null && c.meshM > SITE.floorMin && c.meshM < SITE.floorMax);
const buried = lows.filter((c) => c.aboveMeshM < -2);
console.log(`low contacts with plausible mesh readings: ${lows.length}; buried (< -2m): ${buried.length}`);
for (const b of buried) {
  console.log(`  BURIED ${b.id}: render ${b.renderAltM} m vs mesh ${b.meshM} m (${b.aboveMeshM} m)`);
}
const verdict = lows.length === 0 ? 'INCONCLUSIVE' : (buried.length === 0 ? 'PASS' : 'FAIL');
console.log(`VERDICT: ${verdict}`);
await closeBrowser(browser);
// Exit code (2026-08-19): this harness printed VERDICT: FAIL and still exited 0,
// so a real regression (taxiing contacts rendering under the mesh) stayed
// invisible to every automated caller. Now it reports like its siblings
// (qa-height-datum / qa-cctv-v2): 0 = PASS, 1 = FAIL, 2 = could-not-measure.
// INCONCLUSIVE is deliberately NOT 0 — a run that measured no usable contacts
// proves nothing, and must not read as a pass. The VERDICT line is unchanged,
// so anything scraping stdout (the L9 QA matrix) is unaffected.
process.exit(verdict === 'PASS' ? 0 : (verdict === 'FAIL' ? 1 : 2));
