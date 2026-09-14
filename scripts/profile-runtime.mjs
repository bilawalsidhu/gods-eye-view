#!/usr/bin/node
/**
 * profile-runtime.mjs — main-thread runtime profiler for God's Eye View.
 *
 * Companion to docs/PERFORMANCE.md. That page records ONE hardware baseline;
 * this script is the repeatable instrument behind it: it drives the REAL app
 * (default http://localhost:4173) in headless Chrome and, per scene, samples
 *
 *   - frame production   (rAF cadence → motion/rest FPS)
 *   - main-thread jank   (PerformanceObserver 'longtask' count/total/max)
 *   - JS heap            (performance.memory usedJSHeapSize, before/after)
 *   - CPU self-time      (CDP `Profiler` sampling profiler → ranked hot spots)
 *
 * Scenes (docs/PLAN.md Phase 5 asked for exactly these three + idle):
 *   boot      fresh load → viewer ready → 6 s settle
 *   storm     heavy layer set enabled, scripted camera orbit, 12 s sample
 *   detection flights (synthetic feed) + detection density 100%, 12 s sample
 *   idle      parked camera, no extra layers, 8 s sample (render-governor check)
 * Added since (same instrument, later candidates):
 *   firms / firms-entities  FIRMS cells band, WASM splat vs entity A/B pair
 *   satellitesDense         Starlink shell — the SGP4 WASM-candidate baseline
 *
 * Usage:
 *   node scripts/profile-runtime.mjs                     # all scenes
 *   node scripts/profile-runtime.mjs --scene storm       # one scene
 *   node scripts/profile-runtime.mjs --url http://...    # other dev server
 *   node scripts/profile-runtime.mjs --json out.json     # machine-readable dump
 *
 * The ranked hot-spot lists are the input to the "algorithmic wins before
 * WASM" rule in docs/PLAN.md — a candidate must appear here (or in a DevTools
 * trace a workstation captured) before anyone rewrites it in Rust.
 *
 * Environment caveats, stated plainly:
 *   - Headless runs render through SwiftShader (software GL), so absolute FPS
 *     is NOT comparable to the hardware baseline in docs/PERFORMANCE.md. The
 *     CPU self-time rankings and long-task counts are the portable signals.
 *   - Live external feeds are NOT mocked here (except the flights/detection
 *     scene, which installs the same synthetic-aircraft fetch shim as
 *     scripts/track-regression.mjs so the detection path has work to do on a
 *     machine without OpenSky reachability). Layers that need missing keys
 *     report their configured keyless state and are skipped naturally.
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE_URL = argValue('--url', 'http://localhost:4173');
const ONLY_SCENE = argValue('--scene', 'all');
const JSON_OUT = argValue('--json', null);

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore inaccessible candidates and let Puppeteer fall back to its cache.
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bound any page/CDP call so one slow network fetch can't stall a scene. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/** Install long-task observation before any app script runs. */
const LONGTASK_BOOTSTRAP = `
  window.__gevProfile = { longTasks: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__gevProfile.longTasks.push({
          start: Math.round(entry.startTime),
          duration: Math.round(entry.duration),
        });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* longtask not supported — counts stay empty */ }
`;

/** Snapshot the page's counters (long tasks, heap, layer population). */
async function snapshot(page) {
  return page.evaluate(() => {
    const memory = performance.memory
      ? { usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) }
      : {};
    const dm = window.__godsEyeView?.dataManager;
    return {
      longTasks: window.__gevProfile ? window.__gevProfile.longTasks.length : 0,
      longTaskTotalMs: window.__gevProfile
        ? window.__gevProfile.longTasks.reduce((sum, task) => sum + task.duration, 0)
        : 0,
      longestTaskMs: window.__gevProfile
        ? window.__gevProfile.longTasks.reduce((max, task) => Math.max(max, task.duration), 0)
        : 0,
      ...memory,
      liveLayers: dm && dm.layers ? dm.layers.size : 0,
    };
  });
}

/**
 * Sample rAF cadence for `ms` while `drive(t, dt)` (optional) animates.
 * Returns motion/rest FPS the same way the docs/PERFORMANCE.md captures
 * label them: motion = frames while the driver is active, rest = frames in
 * the tail after it stops.
 */
async function sampleFps(page, ms, driveScript = null) {
  return page.evaluate(async ({ ms, driveScript }) => {
    const sleepInPage = (t) => new Promise((resolve) => setTimeout(resolve, t));
    let frames = 0;
    let running = true;
    const loop = () => {
      if (!running) return;
      frames += 1;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    if (driveScript) await eval(`(${driveScript})(async () => sleepInPage(100))`);
    else await sleepInPage(ms);
    running = false;
    const motionSeconds = ms / 1000;
    return {
      fps: Math.round((frames / Math.max(motionSeconds, 0.001)) * 10) / 10,
      frames,
    };
  }, { ms, driveScript });
}

/** Enable layers one at a time; tolerate keyed/absent/slow sources. */
async function enableLayers(page, layerIds) {
  const perLayer = [];
  for (const id of layerIds) {
    const t0 = Date.now();
    let outcome;
    try {
      outcome = await withTimeout(page.evaluate(async (layerId) => {
        const dm = window.__godsEyeView?.dataManager;
        if (!dm || !dm.layers?.has(layerId)) return 'missing';
        try {
          await dm.setEnabled(layerId, true, { origin: 'programmatic' });
          return dm.isEffectivelyEnabled(layerId) ? 'enabled' : 'not-enabled';
        } catch (error) {
          return `error:${String(error?.message || error).slice(0, 80)}`;
        }
      }, id), 45_000, `enable ${id}`);
    } catch (error) {
      outcome = `timeout:${String(error?.message || error).slice(0, 60)}`;
    }
    perLayer.push({ id, ms: Date.now() - t0, outcome });
  }
  return perLayer;
}

/**
 * Make sure the app is booted on this page (scenes run on fresh pages so one
 * scene's failure can't poison the next). Profiling for this preparatory load
 * is NOT part of the scene's numbers — the caller starts the sampler after.
 */
async function ensureLoaded(page) {
  const ready = await page
    .waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 5_000, polling: 200 },
    )
    .then(() => true)
    .catch(() => false);
  if (ready) return;
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
    { timeout: 90_000, polling: 200 },
  );
  await sleep(3_000);
}

/** Synthetic-aircraft shim (same shapes as scripts/track-regression.mjs). */
const FLIGHT_SHIM = `
  (() => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const plane = (lat, lon, baro) => ({
      callsign: ['GEV001', 'GEV002', 'GEV003', 'GEV004', 'GEV005', 'GEV006'][Math.abs(Math.round(lat * 100)) % 6],
      latitude: lat, longitude: lon,
      baro_altitude: baro, geo_altitude: baro, on_ground: false,
      velocity: 220, true_track: 90, vertical_rate: 0,
      icao24: 'a' + Math.abs(Math.round(lat * 1e4)).toString(16).padStart(6, '0'),
      position_source: 0,
    });
    const stateVector = (p) => [
      p.icao24, p.callsign, p.true_track, p.longitude, p.latitude,
      p.baro_altitude, false, p.geo_altitude, 0, p.velocity, 0.5,
      p.vertical_rate, null, null, null, 'GEV', 0,
    ];
    const box = (center, spread, count, base) => Array.from({ length: count }, (_, i) =>
      plane(center[0] + (Math.sin(i * 2.399) * spread), center[1] + (Math.cos(i * 1.309) * spread), base + (i % 60) * 30));
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (url.includes('/api/opensky')) {
        const rows = box([37.6, -122.1], 1.6, 700, 9000).map(stateVector);
        return new Response(JSON.stringify({ time: Math.floor(Date.now() / 1000), states: rows }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/adsblol')) {
        const ac = box([37.6, -122.1], 1.2, 120, 11000).map((p, i) => ({
          hex: 'ae' + i.toString(16).padStart(4, '0'),
          flight: 'MIL' + i, lat: p.latitude, lon: p.longitude,
          alt_baro: p.baro_altitude, gs: 260, track: p.true_track, baro_rate: 0,
          type: 'C17', r: 'USAF', t: 'C17',
        }));
        return new Response(JSON.stringify({ now: Date.now(), ac }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input, init);
    };
  })();
`;

// Scenes ----------------------------------------------------------------------

const SCENES = {
  /** Fresh load: navigation milestones, boot CPU profile, settle jank. */
  async boot(page, cdp) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const bootStart = Date.now();
    await page.waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 90_000, polling: 200 },
    );
    const readyMs = Date.now() - bootStart;
    await sleep(6_000);
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
      };
    });
    const snap = await snapshot(page);
    const fps = await sampleFps(page, 5_000);
    return { name: 'boot', milestones: { viewerReadyMs: readyMs, ...timing }, ...snap, ...fps, profile: await stopProfiler(cdp, 'boot') };
  },

  /** Heavy bundled + cheap-live layers, scripted camera orbit. */
  async storm(page, cdp) {
    await ensureLoaded(page);
    // Bundled-static layers (datacenters/cables/dams) plus cheap-live layers.
    // `flights` is deliberately excluded — its live OpenSky fetch is unbounded
    // and is exercised deterministically by the `detection` scene's shim.
    const enabled = await enableLayers(page, [
      'local-datacenters', 'telegeography-submarine-cables', 'local-dams',
      'radio', 'bikeshare', 'earthquakes', 'satellites', 'planets',
      'rocket-launches',
    ]);
    await sleep(4_000); // first poll + first solve settle
    // Orbit the camera from Cesium's own preRender event instead of a
    // page-side timer loop: under SwiftShader a rendered frame can take
    // seconds, so timer-driven ticks stretch a nominal 12 s window past the
    // CDP protocol timeout. A preRender callback advances exactly once per
    // rendered frame, whatever that frame costs. (window.Cesium is not
    // exposed in the bundled app, so Cartesian3 comes off an instance.)
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const C3 = viewer.camera.positionWC.constructor;
      window.__gevOrbit = {
        last: performance.now(),
        elapsed: 0,
        remove: null,
        // ~30° of heading per second, 12 s to a full circle.
        listener: (_scene, _time) => {
          const now = performance.now();
          window.__gevOrbit.elapsed += now - window.__gevOrbit.last;
          window.__gevOrbit.last = now;
          viewer.camera.setView({
            destination: C3.fromDegrees(-122.4, 37.6, 2.2e6),
            orientation: { heading: (window.__gevOrbit.elapsed / 1000) * (Math.PI / 6), pitch: -Math.PI / 2.4 },
          });
        },
      };
      window.__gevOrbit.remove = viewer.scene.preRender.addEventListener(window.__gevOrbit.listener);
    });
    const fps = await sampleFps(page, 12_000);
    await page.evaluate(() => {
      window.__gevOrbit?.remove?.();
      window.__gevOrbit = null;
    });
    const snap = await snapshot(page);
    return {
      name: 'storm',
      layerEnable: enabled,
      ...snap,
      ...fps,
      profile: await stopProfiler(cdp, 'storm'),
    };
  },

  /** Synthetic flights + detection density 100% (PERFORMANCE.md's worst case). */
  async detection(page, cdp) {
    await ensureLoaded(page);
    await page.evaluate(FLIGHT_SHIM);
    await enableLayers(page, ['flights', 'military']);
    await sleep(3_000); // let the synthetic fleet land
    const tuned = await page.evaluate(() => {
      const sm = window.__godsEyeView?.styleManager;
      if (sm && typeof sm.setDetection === 'function') {
        sm.setDetection({ enabled: true, densityPct: 100 });
        return 'styleManager.setDetection';
      }
      return 'unavailable';
    });
    await sleep(2_000);
    const fps = await sampleFps(page, 12_000);
    const snap = await snapshot(page);
    const detection = await page.evaluate(() => {
      const sm = window.__godsEyeView?.styleManager;
      const d = sm?.getDetection?.();
      return d ? { mode: d.detectionMode ?? d.mode ?? null, densityPct: d.densityPct ?? null } : null;
    });
    return { name: 'detection', detectionTuning: tuned, detectionState: detection, ...snap, ...fps, profile: await stopProfiler(cdp, 'detection') };
  },

  /** Parked camera, no layers touched — the render-governor idle contract. */
  async idle(page, cdp) {
    await ensureLoaded(page);
    await sleep(4_000);
    const fps = await sampleFps(page, 8_000);
    const snap = await snapshot(page);
    return { name: 'idle', ...snap, ...fps, profile: await stopProfiler(cdp, 'idle') };
  },

  /**
   * FIRMS cells band at global view. Runs against the dev server's real
   * FIRMS proxy (keyless mode serves NASA's public 24h VIIRS CSV; keyed mode
   * uses the MAP_KEY — either way the data is real, nothing here is mocked).
   *
   * Two variants isolate the render path under test:
   *   firms           — default: WASM splat texture replaces the per-cell
   *                     rectangles once the module loads (getStats().renderer
   *                     reports 'wasm-texture').
   *   firms-entities  — `?firmsWasm=0` forces the legacy per-cell rectangle
   *                     entity path (the fallback and the A/B baseline).
   * The pair is the before/after capture docs/PLAN.md Phase 5 requires for
   * the FIRMS WASM candidate.
   */
  async firms(page, cdp) {
    return firmsScene(page, cdp, 'firms', '');
  },

  async firmsEntities(page, cdp) {
    return firmsScene(page, cdp, 'firms-entities', '?firmsWasm=0');
  },

  /**
   * Dense satellite catalog (Starlink shell) — the SGP4 WASM-candidate scene
   * docs/PLAN.md Phase 5 requires before any Rust rewrite qualifies (the same
   * bar the FIRMS pair met). Runs against the dev server's real CelesTrak
   * proxy: real TLEs, real satellite.js propagation, nothing mocked.
   *
   * Evidence the scene produces (the WASM question is settled by these
   * numbers, not instinct):
   *   - densePurePassMs — one full pure-SGP4 pass over the loaded shell,
   *     timed by the module at load completion (getStats). This is the
   *     "what would full-cadence dense propagation cost" input.
   *   - corePassMs / denseChunkMs — the steady-state costs the tick paths
   *     actually incur (1 s core pass; per-frame round-robin slice).
   *   - CPU self-time attribution over the sample window (top list).
   * If the amortized round-robin design already keeps SGP4 out of the frame
   * budget, the candidate does not qualify no matter how large the full pass
   * is — that verdict lives in docs/PLAN.md next to this scene.
   */
  async satellitesDense(page, cdp) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 90_000, polling: 200 },
    );
    await sleep(3_000);
    const enabled = await enableLayers(page, ['satellites']);
    const flip = await page.evaluate(() => {
      const dm = window.__godsEyeView?.dataManager;
      try {
        return dm?.setLayerParams?.('satellites', { catalog: 'dense' }, { origin: 'programmatic' })
          ? 'setLayerParams ok'
          : 'setLayerParams unavailable';
      } catch (error) {
        return `error:${String(error?.message || error).slice(0, 80)}`;
      }
    });
    // The Starlink shell is a multi-megabyte TLE fetch plus ~7-9k satrec
    // builds in 1.5k chunks; a CelesTrak 502 reverts to core and the chip
    // says so (captured below) — a bare timeout must not be the only signal.
    const loaded = await withTimeout(page.waitForFunction(() => {
      const s = window.__godsEyeView?.dataManager?.layers?.get?.('satellites')?.module?.getStats?.();
      return s && s.denseCount > 0 && s.densePurePassMs != null;
    }, { timeout: 150_000, polling: 500 }).then(() => true).catch(() => false), 155_000, 'dense load');
    await sleep(2_000);
    const chip = await page.evaluate(() => {
      const controls = window.__godsEyeView?.dataManager?.layers?.get?.('satellites')
        ?.module?.getRowControls?.();
      const c = controls?.chips?.find?.((x) => x.id === 'catalog');
      return c ? { label: c.label, state: c.state } : null;
    });
    // Slow global orbit: keeps the scene in continuous render so the
    // preRender tick (core pass + dense round-robin) actually runs during the
    // sample window — the same pattern the storm scene uses.
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const C3 = viewer.camera.positionWC.constructor;
      window.__gevOrbit = {
        last: performance.now(),
        elapsed: 0,
        remove: null,
        listener: (_scene, _time) => {
          const now = performance.now();
          window.__gevOrbit.elapsed += now - window.__gevOrbit.last;
          window.__gevOrbit.last = now;
          viewer.camera.setView({
            destination: C3.fromDegrees(-100, 30, 2.2e7),
            orientation: { heading: (window.__gevOrbit.elapsed / 1000) * (Math.PI / 6), pitch: -Math.PI / 2.1 },
          });
        },
      };
      window.__gevOrbit.remove = viewer.scene.preRender.addEventListener(window.__gevOrbit.listener);
    });
    const fps = await sampleFps(page, 12_000);
    await page.evaluate(() => {
      window.__gevOrbit?.remove?.();
      window.__gevOrbit = null;
    });
    const snap = await snapshot(page);
    const sgp4 = await page.evaluate(() => {
      const s = window.__godsEyeView?.dataManager?.layers?.get?.('satellites')?.module?.getStats?.() || {};
      return {
        count: s.count,
        corePassMs: s.corePassMs,
        denseCount: s.denseCount,
        denseChunkMs: s.denseChunkMs,
        densePurePassMs: s.densePurePassMs,
        densePurePassCount: s.densePurePassCount,
      };
    });
    return {
      name: 'satellites-dense',
      layerEnable: enabled,
      denseFlip: flip,
      denseLoaded: loaded,
      denseChip: chip,
      sgp4,
      ...snap,
      ...fps,
      profile: await stopProfiler(cdp, 'satellites-dense'),
    };
  },
};

/** Shared driver for the two FIRMS scenes (see SCENES.firms). */
async function firmsScene(page, cdp, name, query) {
  await page.goto(`${BASE_URL}/${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
    { timeout: 90_000, polling: 200 },
  );
  await sleep(3_000);
  const enabled = await enableLayers(page, ['local-firms']);
  // Park at global altitude — the `global` cells band (2° grid, ≤1800 cells).
  // The app's boot/home camera FLIGHT animates the camera every frame and
  // overrides a one-shot setView (observed: camera settles back to the 600 m
  // home view), so re-issue the view on an interval until the height sticks.
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const C3 = viewer.camera.positionWC.constructor;
    const apply = () => viewer.camera.setView({ destination: C3.fromDegrees(20, 15, 2.2e7) });
    apply();
    let tries = 0;
    window.__gevGlobalHold = setInterval(() => {
      tries += 1;
      if (viewer.camera.positionCartographic.height > 9.0e6 || tries > 20) {
        clearInterval(window.__gevGlobalHold);
        window.__gevGlobalHold = null;
        return;
      }
      apply();
    }, 700);
  });
  // Wait until real fires are loaded and rendered (the keyless proxy fetch
  // can take a few seconds the first time; it is cached to disk afterwards).
  const loaded = await withTimeout(page.waitForFunction(() => {
    const stats = window.__godsEyeView?.dataManager?.layers?.get?.('local-firms')?.module?.getStats?.();
    return stats && stats.count > 0 && stats.cells > 0;
  }, { timeout: 60_000, polling: 500 }).then(() => true).catch(() => false), 65_000, 'firms load');
  // Give the async WASM upgrade a beat to land after the entity first paint.
  await sleep(5_000);
  // Make sure the boot flight's hold is released before sampling FPS.
  await page.evaluate(() => {
    if (window.__gevGlobalHold) { clearInterval(window.__gevGlobalHold); window.__gevGlobalHold = null; }
  });
  const stats = await page.evaluate(() => {
    const s = window.__godsEyeView?.dataManager?.layers?.get?.('local-firms')?.module?.getStats?.() || {};
    return {
      count: s.count,
      cells: s.cells,
      renderer: s.renderer,
      wasmRenderMs: s.wasmRenderMs,
      textureSize: s.textureSize,
      wasmError: s.wasmError,
    };
  });
  const fps = await sampleFps(page, 12_000);
  const snap = await snapshot(page);
  return { name, firmsLoaded: loaded, firms: stats, layerEnable: enabled, ...snap, ...fps, profile: await stopProfiler(cdp, name) };
}

// CDP sampling profiler -------------------------------------------------------

function newProfilerState() {
  return { nodes: new Map(), samples: [], deltas: [], active: false };
}
const PROFILER = newProfilerState();

async function startProfiler(cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); // µs between samples
  await cdp.send('Profiler.start');
  PROFILER.active = true;
}

/** Stop the profiler and return the top self-time entries for this window. */
async function stopProfiler(cdp, label) {
  if (!PROFILER.active) return null;
  const { profile } = await cdp.send('Profiler.stop');
  PROFILER.active = false;
  // Self time = hits per node × sampling interval; hit counts come from the
  // sample list, nodes from the profile node map (id → callFrame).
  const hits = new Map();
  for (const id of profile.samples) hits.set(id, (hits.get(id) ?? 0) + 1);
  const sampleCount = profile.samples.length;
  const byFunction = new Map();
  for (const node of profile.nodes) {
    const count = hits.get(node.id);
    if (!count) continue;
    const frame = node.callFrame;
    const url = (frame.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const key = `${frame.functionName || '(anonymous)'} @ ${url || '(vm)'}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + count);
  }
  const totalHits = [...byFunction.values()].reduce((sum, n) => sum + n, 0);
  const top = [...byFunction.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([fn, hits2]) => ({
      function: fn,
      selfPct: Math.round((hits2 / Math.max(totalHits, 1)) * 1000) / 10,
    }));
  return { label, sampleCount, intervalUs: 500, approxSelfSeconds: Math.round(totalHits * 0.5) / 1000, top };
}

// Driver ----------------------------------------------------------------------

/** Fresh page + CDP session: a scene that wedges the renderer or saturates
 * the protocol must not take the remaining scenes down with it. */
async function newSession(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(LONGTASK_BOOTSTRAP);
  const cdp = await page.createCDPSession();
  return { page, cdp };
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 300_000,
    ...(findChromeExecutable() ? { executablePath: findChromeExecutable() } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  let session = await newSession(browser);

  const sceneNames = ONLY_SCENE === 'all' ? Object.keys(SCENES) : [ONLY_SCENE];
  const results = [];
  for (const name of sceneNames) {
    const scene = SCENES[name];
    if (!scene) {
      console.error(`Unknown scene: ${name} (known: ${Object.keys(SCENES).join(', ')})`);
      await browser.close();
      process.exit(2);
    }
    console.log(`\n=== scene: ${name} ===`);
    await startProfiler(session.cdp);
    try {
      const result = await scene(session.page, session.cdp);
      results.push(result);
      console.log(JSON.stringify({ ...result, profile: undefined }, null, 2));
      const top = result.profile?.top?.slice(0, 10) ?? [];
      if (top.length) {
        console.log(`  top self-time (${name}):`);
        for (const entry of top) console.log(`   ${String(entry.selfPct).padStart(5)}%  ${entry.function}`);
      }
    } catch (error) {
      console.error(`scene ${name} failed:`, error?.message || error);
      try { await session.cdp.send('Profiler.stop'); } catch { /* already stopped */ }
      PROFILER.active = false;
      session = await newSession(browser);
    }
  }

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify({ url: BASE_URL, capturedAt: new Date().toISOString(), results }, null, 2));
    console.log(`\nJSON written: ${JSON_OUT}`);
  }
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
