import { whenSettled } from './qa/ready.mjs';
// The Cyber HUD sonar on Navara: with the Cyber HUD on, the
// sweep lights the contacts it passes and dims the rest to the opacity
// floor, by each contact's place on screen exactly as the CPU sampler of
// src/cyberSonar.js rates it; the sweep turns; with the sweep off every
// contact takes the neutral factor; a parked scene draws at the fleet
// cadence only while the sweep runs over contacts; leaving the Cyber HUD
// gives the contacts back unchanged. On Cesium the command adapter keeps the
// treatment and the engine draws none. The contacts are an engine point set
// (engine.movers) in a ring around the screen centre. Keyless preview under
// the strict default-deny network policy.
//
//   node scripts/qa-navara-sonar.mjs http://127.0.0.1:<PORT>/ [--out=DIR]

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import { checker, freeze, visualPageUrl } from './qa/navaraVisual.mjs';
import { sonarFactorAt } from '../src/globe/navara/sonar.js';

const base = localPreview(process.argv[2]);
const outDir = process.argv
  .find((arg) => arg.startsWith('--out='))
  ?.slice('--out='.length);
const strict = createStrict({ origin: base.origin, layers: [] });
const report = { checks: [] };
const check = checker(report, assert);
const WIDTH = 1280;
const HEIGHT = 800;

// 32 contacts on a ring at half the keyhole radius (11.25° apart: one is
// always well inside the 24° sector), and one outside the keyhole.
function contactPlaces() {
  const radius = Math.min(WIDTH * 0.4, HEIGHT * 0.52) * 0.5;
  const places = [];
  for (let i = 0; i < 32; i++) {
    const angle = (i / 32) * Math.PI * 2;
    places.push({
      x: Math.round(WIDTH / 2 + Math.sin(angle) * radius),
      y: Math.round(HEIGHT / 2 - Math.cos(angle) * radius),
    });
  }
  places.push({ x: 120, y: 110 });
  return places;
}

// The luma at each contact (a 3×3 mean) of the next drawn frame, and the
// sonar state that frame drew with.
const read = (page, places) =>
  page.evaluate(async (places) => {
    const { engine } = window.__godsEyeView;
    const canvas = document.createElement('canvas');
    const source = engine.host.canvas;
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let sonar = null;
    await new Promise((resolve) => {
      const off = engine.frames.postRender.addEventListener(() => {
        off();
        ctx.drawImage(source, 0, 0);
        sonar = engine.render.contactSonar?.() ?? null;
        resolve();
      });
      engine.render.request('qa-sonar');
    });
    const scale = source.width / engine.host.size().width;
    const luma = places.map(({ x, y }) => {
      const data = ctx.getImageData(
        Math.round(x * scale) - 1,
        Math.round(y * scale) - 1,
        3,
        3,
      ).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4)
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      return sum / 9;
    });
    return { luma, sonar };
  }, places);

// Frames the engine draws in `ms` without being asked.
const framesIn = async (page, ms) => {
  await page.evaluate(() => {
    const sample = (window.__qaSonarFrames = { frames: 0, at: performance.now() });
    sample.off = window.__godsEyeView.engine.frames.postRender.addEventListener(
      () => sample.frames++,
    );
  });
  await page.waitForFunction(
    (ms) => performance.now() - window.__qaSonarFrames.at >= ms,
    {},
    ms,
  );
  return page.evaluate(() => {
    window.__qaSonarFrames.off();
    return window.__qaSonarFrames.frames;
  });
};

const mean = (values) =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

await strict.run({}, async (browser) => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
  });
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.goto(visualPageUrl(base.origin, 'navara'), {
    waitUntil: 'domcontentloaded',
  });
  await waitForEngine(page, 'navara');
  await freeze(page);

  const places = contactPlaces();
  const placed = await page.evaluate((places) => {
    const { engine } = window.__godsEyeView;
    const set = engine.movers.createSet({
      id: 'qa-sonar-contacts',
      kind: 'point',
      capacity: places.length,
      depthTest: 'always',
      point: { sizePx: 14, outlinePx: 0 },
    });
    window.__qaSonarSet = set;
    let missing = 0;
    places.forEach((place, index) => {
      const position = engine.camera.pickEllipsoid(place);
      if (!position) missing++;
      set.set(index, { position, color: [1, 1, 1, 1] });
    });
    set.setCount(places.length);
    set.commit();
    return { missing, sonar: engine.render.contactSonar?.() ?? null };
  }, places);
  check(
    'Navara treats contacts itself; the sonar starts off',
    placed.missing === 0 && placed.sonar?.enabled === false,
    placed,
  );
  const baseline = await read(page, places);

  await page.evaluate(() => {
    const { styleManager } = window.__godsEyeView;
    styleManager._setHudVariant('cyber');
    // Normal keeps the contacts' own colours; the HUD stays on (in Normal
    // it would hide itself, and the sweep with it).
    styleManager.setStyle('normal');
    styleManager.hud.setMode('on');
    styleManager._setCyberSonarEnabled(true);
    styleManager._setCyberSonarSetting('opacity', 35);
  });
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.transitions.size === 0,
  );
  const theme = await page.evaluate(() => ({
    theme: document.documentElement.dataset.uiTheme,
    gpu: document.documentElement.dataset.cyberSonarGpu,
    hud: document.getElementById('intel-hud')?.classList.contains('active'),
  }));
  check(
    'the Cyber HUD runs with the contact adapter',
    theme.theme === 'cyber' && theme.gpu === 'supported' && theme.hud,
    theme,
  );

  const sweeps = [];
  for (let sample = 0; sample < 3; sample++) {
    if (sample)
      await page.waitForFunction(
        (previous) => {
          const angle = window.__godsEyeView.engine.render.contactSonar().angleDeg;
          return (angle - previous + 360) % 360 > 30;
        },
        {},
        sweeps.at(-1).angle,
      );
    const { luma, sonar } = await read(page, places);
    const expected = places.map(({ x, y }) =>
      sonarFactorAt(x, y, WIDTH, HEIGHT, sonar),
    );
    const lit = luma.filter((_, i) => expected[i] > 0.9);
    const dim = luma.filter((_, i) => expected[i] <= sonar.opacity / 100);
    sweeps.push({
      spread: Math.max(...luma.slice(0, 32)) - Math.min(...luma.slice(0, 32)),
      angle: sonar.angleDeg,
      lit: lit.length,
      litLuma: mean(lit),
      dimLuma: mean(dim),
      brightest: luma.indexOf(Math.max(...luma)),
      expectedBrightest: expected.indexOf(Math.max(...expected)),
      sonar,
    });
    check(
      `the sweep at ${Math.round(sonar.angleDeg)}° lights the contacts it passes, the rest sit at the floor`,
      sonar.enabled &&
        sonar.active &&
        sonar.opacity === 35 &&
        lit.length >= 1 &&
        dim.length >= 8 &&
        mean(lit) > mean(dim) + 20 &&
        expected[places.length - 1] === 0.35,
      sweeps.at(-1),
    );
  }
  check(
    'the sweep turns: another contact is lit',
    new Set(sweeps.map((s) => s.expectedBrightest)).size > 1 &&
      new Set(sweeps.map((s) => s.brightest)).size > 1,
    sweeps.map(({ angle, brightest, expectedBrightest }) => ({
      angle,
      brightest,
      expectedBrightest,
    })),
  );
  const cadence = await framesIn(page, 1500);
  check(
    'a parked scene draws at the fleet cadence while the sweep runs over contacts',
    cadence >= 8,
    { frames: cadence },
  );

  await page.evaluate(() =>
    window.__godsEyeView.styleManager._setCyberSonarEnabled(false),
  );
  const neutral = await read(page, places);
  const spread =
    Math.max(...neutral.luma.slice(0, 32)) -
    Math.min(...neutral.luma.slice(0, 32));
  await whenSettled(page);
  const idle = await framesIn(page, 1500);
  check(
    'with the sweep off every contact takes the neutral factor and the scene rests',
    neutral.sonar.enabled &&
      !neutral.sonar.active &&
      // What still differs is the map under the translucent contacts.
      spread < Math.min(...sweeps.map((sweep) => sweep.spread)) * 0.6 &&
      idle <= 3,
    { spread, sweeping: sweeps.map((sweep) => sweep.spread), frames: idle },
  );

  await page.evaluate(() => {
    const { styleManager } = window.__godsEyeView;
    styleManager._setCyberSonarEnabled(true);
    styleManager._setHudVariant('tactical');
    styleManager.setStyle('normal');
    styleManager.hud.setMode('auto');
  });
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.transitions.size === 0,
  );
  const after = await read(page, places);
  const drift = Math.max(
    ...after.luma.map((value, i) => Math.abs(value - baseline.luma[i])),
  );
  check(
    'leaving the Cyber HUD gives the contacts back unchanged',
    after.sonar.enabled === false && drift < 3,
    { drift },
  );
  await page.evaluate(() => window.__qaSonarSet.destroy());

  // Cesium draws contact sonar through its engine command adapter.
  await strict.switchTo(page, 'cesium');
  await page.evaluate(() => {
    const { styleManager } = window.__godsEyeView;
    styleManager._setHudVariant('cyber');
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.cyberSonarGpu,
    { timeout: 10000 },
  );
  const cesium = await page.evaluate(() => ({
    setContactSonar: typeof window.__godsEyeView.engine.render.setContactSonar,
    gpu: document.documentElement.dataset.cyberSonarGpu,
  }));
  check(
    'Cesium: the engine command adapter treats contacts',
    cesium.setContactSonar === 'function' && cesium.gpu === 'supported',
    cesium,
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager._setHudVariant('tactical'),
  );

  check('no page errors', errors.length === 0, errors);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'sonar.json'),
      JSON.stringify(report, null, 2),
    );
  }
});
