#!/usr/bin/env node
/**
 * qa-weather-journey — drive the Weather layers the way a person would and
 * keep the evidence: numbered screenshots plus per-step layer diagnostics.
 *
 * Starts at the Earth view, opens Data Layers, switches Wind on from its real
 * row button, cycles the wind fields/models, switches radar, satellite clouds,
 * lightning and cyclones on, follows "View storm" and "View US radar", zooms
 * into a regional view, a city view and a street view, replays history, and
 * ends with real wheel/drag input. Every step records the enabled layers'
 * diagnostics (imagery tiles loaded, shown observation time, wind geometry)
 * and a 2 s `scene.postRender` count so a stalled renderer cannot pass as a
 * healthy screenshot.
 *
 * Usage:
 *   node scripts/qa-weather-journey.mjs [--url http://localhost:4173]
 *     [--label google] [--headless] [--out qa-shots/weather-journey]
 *
 * Requires a running dev server. Screenshots and steps.json land in
 * <out>/<label>/.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : fallback;
};
const flag = (name) => argv.includes(name);
const rawUrl = arg('--url', 'http://localhost:4173');
const url = rawUrl.includes('welcome=')
  ? rawUrl
  : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}welcome=0`;
const label = arg('--label', 'journey');
const outDir = path.resolve(arg('--out', 'qa-shots/weather-journey'), label);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEATHER = ['weather-radar', 'weather-satellite', 'weather-lightning'];

const browser = await puppeteer.launch({
  headless: flag('--headless') ? 'new' : false,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) =>
      existsSync(p),
    ),
  protocolTimeout: 300_000,
  defaultViewport: null,
  args: [
    '--no-sandbox',
    '--window-size=1400,1000',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

const steps = [];
let index = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 920, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  // Non-2xx responses, counted per path so a burst of throttled tiles reads
  // as one line instead of one console error per tile.
  const failures = new Map();
  page.on('response', (r) => {
    const status = r.status();
    if (status < 400) return;
    const key = `${status} ${new URL(r.url()).pathname}`;
    failures.set(key, (failures.get(key) || 0) + 1);
  });
  const reportFailures = () => {
    if (!failures.size) return;
    console.log(
      '  [http failures] ' +
        [...failures].map(([k, n]) => `${k} ×${n}`).join(' · '),
    );
    failures.clear();
  };
  page.on('console', (m) => {
    if (m.type() === 'error')
      console.log('  [console.error]', m.text().slice(0, 200));
  });
  // The Data Layers panel remembers its collapsed state; start it open.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('godsEyeView.v6.panelCollapsed.data-panel', '0');
    } catch {
      /* storage may be unavailable */
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, {
    timeout: 120_000,
  });
  await sleep(12_000);

  const diagnostics = () =>
    page.evaluate(
      ({ WEATHER }) => {
        const gev = window.__godsEyeView;
        const dm = gev.dataManager;
        const out = {
          basemap: gev.tileset ? 'google-3d' : 'keyless-globe',
          globeShown: gev.viewer.scene.globe.show,
          heightM: Math.round(gev.viewer.camera.positionCartographic.height),
          summaryHeight: Math.round(
            document.querySelector('.weather-summary')?.getBoundingClientRect()
              .height ?? 0,
          ),
        };
        for (const id of ['wind', ...WEATHER, 'weather-cyclones']) {
          const entry = dm.layers.get(id);
          if (!entry?.enabled) continue;
          const d = entry.module?.getDiagnostics?.() || {};
          const s = entry.module?.getStats?.() || {};
          out[id] =
            id === 'wind'
              ? {
                  mode: d.renderMode,
                  ready: d.gpu?.ready,
                  paths: d.gpu?.pathCount,
                  visibleCells: d.gpu?.visibleCells,
                  heightFade: d.gpu?.heightFade,
                  overlay: d.overlay,
                  imagery: d.imageryActive,
                  error: s.error,
                }
              : id === 'weather-cyclones'
                ? { count: s.count, error: s.error }
                : {
                    time: d.time,
                    playing: d.playing,
                    loading: d.loading,
                    loadedTiles: d.loadedTiles,
                    frameLoadMs: d.frameLoadMs && Math.round(d.frameLoadMs),
                    error: d.error,
                  };
        }
        return out;
      },
      { WEATHER },
    );

  const renders = (ms = 2000) =>
    page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const scene = window.__godsEyeView.viewer.scene;
          let n = 0;
          const off = scene.postRender.addEventListener(() => {
            n += 1;
          });
          setTimeout(() => {
            off();
            resolve(n);
          }, ms);
        }),
      ms,
    );

  const shot = async (name, note = '') => {
    index += 1;
    const file = `${String(index).padStart(2, '0')}-${name}.png`;
    const d = await diagnostics();
    const r = await renders(2000);
    await page.screenshot({ path: path.join(outDir, file) });
    reportFailures();
    steps.push({ index, name, note, file, renders2s: r, ...d });
    console.log(`  ${file}  renders/2s=${r}  ${note} ${JSON.stringify(d)}`);
  };

  const clickRow = async (id) => {
    const ok = await page.evaluate((id) => {
      const btn = document.querySelector(
        `[data-layer-id="${id}"] .data-toggle-btn`,
      );
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }, id);
    if (!ok) console.log(`  !! no row button for ${id}`);
  };
  const clickChip = async (id, chip) => {
    const ok = await page.evaluate(
      ({ id, chip }) => {
        const btn = document.querySelector(
          `[data-layer-id="${id}"] [data-chip-id="${chip}"]`,
        );
        if (!btn || btn.disabled) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      },
      { id, chip },
    );
    if (!ok) console.log(`  !! chip ${id}/${chip} missing or disabled`);
    return ok;
  };
  const waitReady = (ids, timeout = 90_000) =>
    page
      .waitForFunction(
        (ids) => {
          const dm = window.__godsEyeView.dataManager;
          for (const id of ids) {
            const entry = dm.layers.get(id);
            if (!entry?.enabled) return false;
            const d = entry.module?.getDiagnostics?.() || {};
            if (id === 'wind') {
              if (d.renderMode === 'gpu-streamlines' && !d.gpu?.ready)
                return false;
            } else if (id !== 'weather-cyclones') {
              if (d.loading || (!d.time && !d.error)) return false;
            }
          }
          return true;
        },
        { timeout, polling: 250 },
        ids,
      )
      .catch(() =>
        console.log(`  !! ${ids.join(',')} not ready within ${timeout} ms`),
      );
  const fly = async (
    lon,
    lat,
    height,
    pitch = -90,
    heading = 0,
    duration = 2,
  ) => {
    await page.evaluate(
      ({ lon, lat, height, pitch, heading, duration }) => {
        const v = window.__godsEyeView.viewer;
        const d2r = Math.PI / 180;
        v.camera.cancelFlight();
        v.camera.flyTo({
          destination: v.scene.ellipsoid.cartographicToCartesian({
            longitude: lon * d2r,
            latitude: lat * d2r,
            height,
          }),
          orientation: { heading: heading * d2r, pitch: pitch * d2r, roll: 0 },
          duration,
        });
      },
      { lon, lat, height, pitch, heading, duration },
    );
    await sleep(duration * 1000 + 3000);
  };

  console.log(`\nqa-weather-journey · ${label} · ${url}`);
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    for (const [id, entry] of gev.dataManager.layers)
      if (entry.enabled)
        await gev.dataManager.setEnabled(id, false, { origin: 'user' });
    document.querySelector('#data-panel')?.classList.remove('collapsed');
  });

  // 1. Earth view, clean.
  await fly(-97.7431, 30.2672, 17_368_000);
  await shot('globe-clean', 'Earth view, no layers');

  // 2. Wind from its row, then each field, then ECMWF.
  await clickRow('wind');
  await waitReady(['wind']);
  await sleep(1500);
  await shot('globe-wind-trails', 'Wind on (trails, no field)');
  await clickChip('wind', 'overlay-speed');
  await sleep(2500);
  await shot('globe-wind-speed', 'Wind speed field');
  await clickChip('wind', 'overlay-temperature');
  await sleep(2500);
  await waitReady(['wind']);
  await shot('globe-wind-temperature', 'Wind + 2 m temperature');
  await clickChip('wind', 'overlay-pressure');
  await sleep(2500);
  await waitReady(['wind']);
  await shot('globe-wind-pressure', 'Wind + MSL pressure');
  await clickChip('wind', 'model-ifs');
  await waitReady(['wind']);
  await sleep(2500);
  await shot('globe-wind-ecmwf-pressure', 'ECMWF IFS model');
  await clickChip('wind', 'model-gfs');
  await clickChip('wind', 'overlay-speed');
  await waitReady(['wind']);
  await sleep(1500);

  // 3. Observed products.
  for (const id of WEATHER) await clickRow(id);
  await clickRow('weather-cyclones');
  await waitReady([...WEATHER]);
  await sleep(2500);
  await shot(
    'globe-all-weather',
    'Wind speed + radar + regional IR + lightning + cyclones',
  );
  await clickChip('weather-satellite', 'clouds');
  await waitReady(['weather-satellite']);
  await sleep(2500);
  await shot('globe-global-infrared', 'Satellite: global infrared mosaic');
  await clickChip('weather-satellite', 'clouds-regional');
  await waitReady(['weather-satellite']);

  // 4. Follow a storm if there is one (advisories arrive a few seconds after enable).
  await page
    .waitForFunction(
      () =>
        !!document.querySelector(
          '[data-layer-id="weather-cyclones"] .data-toggle-chip:not([data-chip-id="focus"]):not([data-chip-id="advisory"])',
        ),
      { timeout: 25_000, polling: 500 },
    )
    .catch(() => {});
  const storm = await page.evaluate(() => {
    const first = document.querySelector(
      '[data-layer-id="weather-cyclones"] .data-toggle-chip:not([data-chip-id="focus"]):not([data-chip-id="advisory"])',
    );
    if (!first) return null;
    first.click();
    return first.textContent.trim();
  });
  if (storm) {
    await sleep(1500);
    if (await clickChip('weather-cyclones', 'focus')) {
      await sleep(6000);
      await shot('storm-view', `View storm: ${storm}`);
      await page.evaluate(() =>
        window.__godsEyeView.viewer.camera.zoomIn(400_000),
      );
      await sleep(4000);
      await shot('storm-closer', 'Zoomed toward the storm');
    }
  } else console.log('  (no active cyclone advisories to follow)');

  // 5. US radar, then regional → city → street over the same spot.
  await clickChip('weather-radar', 'coverage');
  await sleep(6000);
  await shot('us-radar', 'View US radar');
  await fly(-94.6, 37.5, 600_000);
  await shot('regional-600km', 'Regional 600 km');
  await fly(-94.6, 37.5, 120_000);
  await shot('regional-120km', 'Regional 120 km');
  await fly(-97.7431, 30.2672, 12_000, -60, 20);
  await shot('city-12km', 'Austin 12 km oblique');
  await fly(-97.7431, 30.2672, 1_200, -45, 20);
  await shot('city-1200m', 'Austin 1.2 km oblique (the perf route pose)');
  await fly(-97.7431, 30.2672, 350, -30, 60);
  await shot('street-350m', 'Austin 350 m street level');

  // 6. History playback at the city pose (panel behavior while frames swap).
  await clickChip('weather-radar', 'play');
  const heights = [];
  for (let i = 0; i < 4; i++) {
    await sleep(2200);
    heights.push(
      await page.evaluate(() =>
        Math.round(
          document.querySelector('.weather-summary')?.getBoundingClientRect()
            .height ?? 0,
        ),
      ),
    );
  }
  await shot(
    'city-history-playing',
    `History playing; summary heights ${heights.join('/')}`,
  );
  await clickChip('weather-radar', 'play');
  await clickChip('weather-radar', 'latest');

  // 7. Real input: wheel-zoom out, drag, wheel-zoom in.
  await fly(-97.7431, 30.2672, 40_000, -55, 0, 1.5);
  const canvas = await page.$(
    'canvas.cesium-widget-canvas, .cesium-widget canvas',
  );
  const box = canvas
    ? await canvas.boundingBox()
    : { x: 700, y: 460, width: 0, height: 0 };
  const cx = box.x + (box.width || 0) / 2;
  const cy = box.y + (box.height || 0) / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel({ deltaY: 240 });
    await sleep(120);
  }
  await sleep(3000);
  await shot('wheel-out', 'Wheel zoom out ×12');
  await page.mouse.move(cx - 200, cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(cx - 200 + i * 20, cy + i * 4, { steps: 2 });
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(2500);
  await shot('drag-pan', 'Drag pan');
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel({ deltaY: -240 });
    await sleep(120);
  }
  await sleep(4000);
  await shot('wheel-in', 'Wheel zoom in ×10');

  // 8. Back to Earth with everything on.
  await fly(-97.7431, 30.2672, 17_368_000, -90, 0, 2.5);
  await shot('globe-return', 'Return to Earth view');

  writeFileSync(
    path.join(outDir, 'steps.json'),
    JSON.stringify({ label, url, steps }, null, 2),
  );
  console.log(`\nWrote ${steps.length} steps to ${outDir}`);
} finally {
  await browser.close();
}
