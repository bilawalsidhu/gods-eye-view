// The cockpit weather clouds on Navara: in cockpit mode with
// the cockpit weather on, Navara's own volumetric clouds take their cover
// from the weather under the camera (clear: none; overcast: a heavy deck),
// with no second canvas or WebGL context; leaving the cockpit gives the look
// its own clouds back. On Cesium the cockpit keeps its own cloud canvas and
// the engine draws none. The weather route is a fixture, the page clock is
// shifted to an Austin midday (the look shows clouds only in daylight), and
// cockpit mode is entered through its event (the cloud controllers listen
// to it; a real cockpit needs a tracked aircraft). Keyless preview under the
// strict default-deny network policy.
//
//   node scripts/qa-navara-cockpit-clouds.mjs http://127.0.0.1:<PORT>/ [--out=DIR]

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  capture,
  checker,
  diff,
  freeze,
  saveCapture,
  stats,
  visualPageUrl,
} from './qa/navaraVisual.mjs';

const base = localPreview(process.argv[2]);
const outDir = process.argv
  .find((arg) => arg.startsWith('--out='))
  ?.slice('--out='.length);
const LOW_VIEW =
  'v=2&lat=30.2672&lon=-97.7431&alt=2500&heading=90&pitch=-8&map=osm&l=';
const MIDDAY_UTC = '2026-07-15T18:00:00Z';
const WEATHER = {
  clear: { weatherCode: 0, cloudCoverPct: 0, windKph: 6, visibilityM: 20000 },
  overcast: {
    weatherCode: 3,
    cloudCoverPct: 100,
    windKph: 25,
    visibilityM: 15000,
  },
};
let weather = WEATHER.clear;
const asked = [];
const strict = createStrict({
  origin: base.origin,
  layers: [],
  time: MIDDAY_UTC,
  routes: [
    {
      pattern: `${base.origin}/api/weather-effects*`,
      respond: (request) => {
        asked.push(request.url);
        return {
          contentType: 'application/json',
          body: JSON.stringify({ status: 'live', weather }),
        };
      },
    },
  ],
});
const report = { checks: [] };
const check = checker(report, assert);
const save = (name, pixels) => saveCapture(outDir, name, pixels);

// Clouds grey the frame: the blue sky and the map's coloured lines go.
const saturation = (pixels) => stats(pixels).saturation;

// The temporal cloud pass converges over drawn frames.
async function converged(page, name) {
  await page.evaluate(async () => {
    const { engine } = window.__godsEyeView;
    engine.render.setContinuous(true);
    try {
      await new Promise((resolve, reject) => {
        let frames = 0;
        const timer = setTimeout(() => {
          remove();
          reject(new Error('Cloud convergence frames did not arrive'));
        }, 30000);
        const remove = engine.frames.postRender.addEventListener(() => {
          if (++frames < 120) return;
          remove();
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      engine.render.setContinuous(false);
    }
  });
  const pixels = await capture(page);
  save(name, pixels);
  return pixels;
}

const cockpit = (page, active) =>
  page.evaluate((active) => {
    document.body.classList.toggle('cockpit-mode', active);
    window.dispatchEvent(
      new CustomEvent('gev:cockpit-mode-changed', { detail: { active } }),
    );
  }, active);
const weatherToggle = (page, enabled) =>
  page.evaluate((enabled) => {
    window.dispatchEvent(
      new CustomEvent('gev:cockpit-weather-toggle', { detail: { enabled } }),
    );
  }, enabled);
const coverage = (page) =>
  page.evaluate(
    () => window.__godsEyeView.engine.render.cloudCover?.().coverage,
  );

await strict.run({}, async (browser) => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
  });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(visualPageUrl(base.origin, 'navara', '', LOW_VIEW), {
    waitUntil: 'domcontentloaded',
  });
  await waitForEngine(page, 'navara');
  await freeze(page);

  const setup = await page.evaluate(() => {
    const a = window.__godsEyeView;
    return {
      cover: a.engine.render.cloudCover?.() ?? null,
      canvas: Boolean(document.getElementById('cockpit-cloud-effects')),
      canvases: document.querySelectorAll('canvas').length,
    };
  });
  check(
    'Navara takes the cockpit cloud cover itself, no cloud canvas',
    setup.cover?.coverage === null && !setup.canvas,
    setup,
  );
  const lookOwn = await converged(page, 'look-own');

  await weatherToggle(page, true);
  await cockpit(page, true);
  await page.waitForFunction(
    () => window.__godsEyeView.engine.render.cloudCover().coverage === 0,
    { timeout: 10000, polling: 100 },
  );
  check('clear weather in the cockpit: no cloud cover', asked.length >= 1, {
    requests: asked.length,
  });
  const clear = await converged(page, 'cockpit-clear');

  // Overcast 30 km east: the movement makes the weather stale.
  weather = WEATHER.overcast;
  await page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    const place = engine.camera.pose().cartographic;
    const east = place.longitude + 30000 / (6378137 * Math.cos(place.latitude));
    const { sin, cos } = Math;
    // WGS84 Earth-fixed position of (east, latitude, height).
    const a = 6378137;
    const e2 = 0.00669437999014;
    const n = a / Math.sqrt(1 - e2 * sin(place.latitude) ** 2);
    const h = place.height;
    engine.camera.setView({
      destination: {
        x: (n + h) * cos(place.latitude) * cos(east),
        y: (n + h) * cos(place.latitude) * sin(east),
        z: (n * (1 - e2) + h) * sin(place.latitude),
      },
      orientation: { heading: Math.PI / 2, pitch: -0.14, roll: 0 },
    });
  });
  await page.waitForFunction(
    () => window.__godsEyeView.engine.render.cloudCover().coverage > 0.4,
    { timeout: 15000, polling: 100 },
  );
  const overcastCover = await coverage(page);
  const overcast = await converged(page, 'cockpit-overcast');
  const greyed = {
    lookOwn: saturation(lookOwn),
    clear: saturation(clear),
    overcast: saturation(overcast),
    clearToOvercast: diff(clear, overcast).mean,
  };
  check(
    'overcast weather covers the view with Navara clouds, clear leaves it open',
    overcastCover > 0.4 &&
      greyed.overcast < greyed.clear * 0.6 &&
      greyed.lookOwn < greyed.clear &&
      greyed.clearToOvercast > 15,
    { overcastCover, greyed, requests: asked.length },
  );
  const contexts = await page.evaluate(() => ({
    canvas: Boolean(document.getElementById('cockpit-cloud-effects')),
    canvases: document.querySelectorAll('canvas').length,
  }));
  check(
    'no second canvas or WebGL context in the cockpit',
    !contexts.canvas && contexts.canvases === setup.canvases,
    { before: setup.canvases, after: contexts },
  );

  await cockpit(page, false);
  check(
    'leaving the cockpit gives the look its own clouds back',
    (await coverage(page)) === null,
  );

  // Cesium keeps its own cockpit cloud canvas; its engine draws none.
  await strict.switchTo(page, 'cesium');
  await freeze(page);
  weather = WEATHER.overcast;
  await cockpit(page, true);
  await page.waitForFunction(
    () =>
      Number(
        document.getElementById('cockpit-cloud-effects')?.dataset.cloudStrength,
      ) > 0.3,
    { timeout: 15000, polling: 100 },
  );
  const cesium = await page.evaluate(() => {
    const canvas = document.getElementById('cockpit-cloud-effects');
    return {
      setCloudCover: typeof window.__godsEyeView.engine.render.setCloudCover,
      strength: Number(canvas.dataset.cloudStrength),
      cockpit: canvas.dataset.cockpit,
    };
  });
  check(
    'Cesium: the cockpit draws its own cloud canvas, the engine none',
    cesium.setCloudCover === 'undefined' && cesium.cockpit === 'true',
    cesium,
  );
  await cockpit(page, false);
  await weatherToggle(page, false);

  check('no page errors', errors.length === 0, errors);
  if (outDir)
    fs.writeFileSync(
      path.join(outDir, 'cockpit-clouds.json'),
      JSON.stringify(report, null, 2),
    );
});
