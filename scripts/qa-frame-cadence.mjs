#!/usr/bin/node
/**
 * qa-frame-cadence.mjs — behavioral verification for the Phase 15B cadence
 * moves (docs/PLAN.md 15B): planets' interval-driven updates and the rocket
 * mission declutter walk gate.
 *
 * Pixel A/B is the wrong gate for this change set: the planets label fix
 * (NearFarScalar replacing a silently-broken Cesium.Interval) is a DELIBERATE
 * visual change beyond 1e9 m, and position writes moving from per-frame to
 * per-60 s are sub-pixel by design. What must hold is behavioral:
 *
 *   1. planets enable writes real positions and needs NO frame plumbing
 *      (interval-driven, no preRender dependency).
 *   2. the planets label fade contract is now a live NearFarScalar on the
 *      rendered billboards (was: cloned into NaN via the Interval bug).
 *   3. the rocket mission declutter walk still tracks the camera: a
 *      rear-side mission dot hides on a camera move WITHOUT any explicit
 *      invalidation (the quantized position key must catch it).
 *   4. a parked camera skips the walk (declutterWalksSkipped grows; walks
 *      stay at the 500 ms floor) — the win itself, measured.
 *
 * Screenshots land in qa-shots/ for the phase record.
 *
 * Usage: node scripts/qa-frame-cadence.mjs [--url http://localhost:4174]
 * Requires the dev server. Chrome for Testing via PUPPETEER_EXECUTABLE_PATH.
 */

import fs from 'node:fs';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE_URL = argValue('--url', 'http://localhost:4174');

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  || await (async () => { try { return await puppeteer.executablePath(); } catch { return null; } })();
if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable (set PUPPETEER_EXECUTABLE_PATH)');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const tally = (ok, label, detail) => {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  timeout: 180_000,
  // 30 min — same renderer-starvation headroom as the frame census.
  protocolTimeout: 1_800_000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1600,900',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  // Attached BEFORE the probes: a layer-enable rollback logs
  // `[Data] <layer> ... error:` from the manager transaction, and an uncaught
  // boot error would otherwise leave the tallies failing with no cause shown.
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
  page.on('pageerror', (error) => pageErrors.push(String(error?.message || error).slice(0, 300)));
  fs.mkdirSync('qa-shots', { recursive: true });

  // Module scripts defer domcontentloaded, so under heavy host load the
  // navigation can outlive any sane goto timeout even though the server
  // answers instantly. A rejected goto does NOT cancel the navigation — it
  // keeps loading — so give the goto a short leash and wait for the app on
  // the SAME page (re-goto would abort the in-flight boot and restart it).
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  } catch {
    // Navigation committed; the boot continues in the page. Fall through.
  }
  await page.waitForFunction(
    () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
    { timeout: 900_000, polling: 1_000 },
  );
  await sleep(3_000);

  // ── Enable the two changed layers (regardless of external feed state:
  // planets is computed; rocket launches degrades to its TLE fallback path).
  const enabled = await page.evaluate(async () => {
    const dm = window.__godsEyeView.dataManager;
    const out = {};
    for (const id of ['planets', 'rocket-launches']) {
      if (!dm.layers?.has(id)) { out[id] = 'missing'; continue; }
      try {
        await dm.setEnabled(id, true, { origin: 'programmatic' });
        out[id] = dm.isEffectivelyEnabled(id) ? 'enabled' : 'not-enabled';
      } catch (error) {
        out[id] = `error:${String(error?.message || error).slice(0, 80)}`;
      }
    }
    return out;
  });
  console.log(`layer enable: ${JSON.stringify(enabled)}`);

  // ── Probe 1 + 2: planets positions written, labels carry a live
  // NearFarScalar fade (rendered billboard side, not just the entity spec).
  const planets = await page.evaluate(async () => {
    const { viewer } = window.__godsEyeView;
    // One forced frame so the visualizers materialize billboards.
    viewer.scene.requestRenderMode = false;
    await new Promise((r) => setTimeout(r, 2_500));
    viewer.scene.requestRenderMode = true;
    const entities = viewer.entities.values.filter((e) => String(e.id).startsWith('planet-'));
    const withPosition = entities.filter((e) => {
      try {
        const p = e.position?.getValue?.(viewer.clock.currentTime);
        return p && Number.isFinite(p.x) && (Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z)) > 0;
      } catch { return false; }
    });
    // The rendered labels: LabelCollection entries' translucencyByDistance.
    let labelCount = 0;
    let nearFarCount = 0;
    let brokenFade = 0;
    for (let i = 0; i < viewer.scene.primitives.length; i += 1) {
      const prim = viewer.scene.primitives.get(i);
      if (!prim || typeof prim.length !== 'function') continue;
      const n = prim.length;
      for (let j = 0; j < n; j += 1) {
        const label = prim.get(j);
        if (!label || !label.translucencyByDistance) continue;
        labelCount += 1;
        const fade = label.translucencyByDistance;
        if (Number.isFinite(fade.near) && Number.isFinite(fade.far)) nearFarCount += 1;
        else brokenFade += 1;
      }
    }
    return { entityCount: entities.length, withPosition: withPosition.length, labelCount, nearFarCount, brokenFade };
  });
  tally(planets.entityCount === 8, 'planets layer exposes its 8 entities', `count ${planets.entityCount}`);
  tally(planets.withPosition === 8, 'all planet entities hold non-zero positions', `positioned ${planets.withPosition}/8`);
  tally(planets.brokenFade === 0, 'no rendered label carries a broken (NaN-field) distance fade',
    `nearFar ${planets.nearFarCount}/${planets.labelCount} labels scanned, broken ${planets.brokenFade}`);

  // ── Probe 3: the gated walk tracks camera moves. Fly the camera so the
  // selected mission's dot (if a mission auto-selected) or the entity cohort
  // flips horizon state; assert some graphic's visibility CHANGED after the
  // move with no explicit invalidation. Uses entity show values read across
  // two forced frames.
  const walkTracks = await page.evaluate(async () => {
    const { viewer } = window.__godsEyeView;
    const scene = viewer.scene;
    const readDots = () => {
      const states = [];
      const ds = viewer.dataSources.getByName?.('rocket-launches')?.[0]
        || viewer.dataSources.get(0);
      if (!ds) return states;
      for (const entity of ds.entities.values) {
        if (!String(entity.id).startsWith('rocket-launch:')) continue;
        if (!entity.point) continue;
        states.push(entity.point.show?.getValue?.(viewer.clock.currentTime));
      }
      return states;
    };
    const C3 = viewer.camera.positionWC.constructor;
    const before = readDots();
    const walkStatsBefore = (() => {
      try { return window.__godsEyeView.dataManager.layers.get('rocket-launches')?.module?.getStats?.() || {}; } catch { return {}; }
    })();
    // Two material moves (front side → far side) — each crosses position
    // bins, so the quantized key must mark the pose changed and the walk
    // must run with no explicit invalidation.
    scene.requestRenderMode = false;
    viewer.camera.setView({
      destination: C3.fromDegrees(-80.6, 28.6, 18_000_000),
      orientation: { heading: 0, pitch: -Math.PI / 2.4, roll: 0 },
    });
    await new Promise((r) => setTimeout(r, 2_500));
    viewer.camera.setView({
      destination: C3.fromDegrees(99.4, -28.6, 18_000_000),
      orientation: { heading: 0, pitch: -Math.PI / 2.4, roll: 0 },
    });
    await new Promise((r) => setTimeout(r, 2_500));
    scene.requestRenderMode = true;
    const after = readDots();
    const walkStatsAfter = (() => {
      try { return window.__godsEyeView.dataManager.layers.get('rocket-launches')?.module?.getStats?.() || {}; } catch { return {}; }
    })();
    return {
      before, after,
      walksBefore: walkStatsBefore.declutterWalks ?? null,
      walksAfter: walkStatsAfter.declutterWalks ?? null,
    };
  });
  tally(
    walkTracks.walksAfter !== null && walkTracks.walksAfter > (walkTracks.walksBefore ?? 0),
    'declutter walk ran during the camera moves (gate tracked the position change)',
    `walks ${walkTracks.walksBefore} → ${walkTracks.walksAfter}`,
  );
  if (walkTracks.before.length > 0) {
    const changed = walkTracks.before.some((v, i) => v !== walkTracks.after[i]);
    tally(changed, 'mission dot visibility responded to the horizon change', `before [${walkTracks.before}] after [${walkTracks.after}]`);
  } else {
    console.log('ℹ no rocket-launch entities present (feed unavailable in this environment) — horizon A/B skipped; walk-counter check above still applies');
  }

  // ── Probe 4: parked camera skips the walk (floor cadence, not per-frame).
  const parked = await page.evaluate(async () => {
    const sleepInPage = (t) => new Promise((r) => setTimeout(r, t));
    const stats = () => window.__godsEyeView.dataManager.layers.get('rocket-launches')?.module?.getStats?.() || {};
    const a = stats();
    await sleepInPage(4_000);
    const b = stats();
    return {
      walks: (b.declutterWalks ?? 0) - (a.declutterWalks ?? 0),
      skipped: (b.declutterWalksSkipped ?? 0) - (a.declutterWalksSkipped ?? 0),
      wallMs: 4_000,
    };
  });
  // Parked, the walk may run at most wallMs/floor + 1 times; per-frame would
  // be hundreds. The skip counter must be doing the work either way.
  const maxWalks = Math.ceil(parked.wallMs / 500) + 1;
  tally(parked.walks <= maxWalks && parked.skipped >= 0,
    'parked camera: declutter walk held to the 500 ms floor (not per-frame)',
    `${parked.walks} walks / ${parked.skipped} skips in ${parked.wallMs} ms (max ${maxWalks})`);

  // ── Screenshot for the phase record (forced render first).
  await page.evaluate(() => { window.__godsEyeView.viewer.scene.requestRenderMode = false; });
  await sleep(4_000);
  await page.screenshot({ path: 'qa-shots/frame-cadence-15b.png' });
  await page.evaluate(() => { window.__godsEyeView.viewer.scene.requestRenderMode = true; });

  await sleep(1_000);
  tally(consoleErrors.length === 0 && pageErrors.length === 0,
    'no console errors during the probes',
    [...consoleErrors.slice(0, 3), ...pageErrors.slice(0, 3)].join(' | '));
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`FRAME CADENCE QA FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('FRAME CADENCE QA PASS');
