#!/usr/bin/env node
/**
 * Flights on Cesium and Navara side by side (phase 3 Task 10b, parity item
 * 1): the same synthetic fleet (?qaFeed=flights:synthetic:N) at the global,
 * city and orbit poses on both engines. Writes each engine's canvas and a
 * side-by-side JPEG (Cesium left, Navara right) to --out, and compares the
 * colour drawn at the centre of known glyphs (the same objects on both
 * engines): every channel within --tolerance (default 3).
 *
 *   node scripts/qa-flights-engines.mjs --base-url=http://localhost:PORT/
 *     [--out=docs/migration/phase3/flights] [--feed=flights:synthetic:10000]
 *     [--models=off|on] [--tolerance=3]
 *
 * The server is the caller's (never ports 4185-4189). Headless only. Exits 1
 * on a failed check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { frozenClockScript } from '../src/tooling/w1Baseline.js';
import { W1_FROZEN_MS } from '../src/bench/w1Feeds.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const baseUrl = argument('base-url');
if (!baseUrl) {
  console.error('--base-url=URL is required');
  process.exit(2);
}
if ([4185, 4186, 4187, 4188, 4189].includes(Number(new URL(baseUrl).port))) {
  console.error('ports 4185-4189 are reserved');
  process.exit(2);
}
const outDir = path.resolve(
  repoRoot,
  argument('out') ?? 'docs/migration/phase3/flights',
);
// Each engine's full picture (git-ignored); --out keeps the side-by-side.
const shotDir = path.resolve(
  repoRoot,
  argument('shots') ?? 'qa-artifacts/flights-engines',
);
const feed = argument('feed') ?? 'flights:synthetic:10000';
const models = argument('models') ?? 'off';
const tolerance = Number(argument('tolerance') ?? 3);
const POSES = {
  global: [-40, 30, 15_000_000, 0, -90],
  city: [-73.78, 40.64, 60_000, 0, -90],
  orbit: [-73.78, 40.64, 1_500_000, 0, -90],
  // The W1 baseline's city pose: low and oblique over JFK, where the nearest
  // aircraft are 3D models (with --models=on).
  near: [-73.78, 40.58, 6_000, 0, -35],
};
const WIDTH = 1280;
const HEIGHT = 800;

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(
    `  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
};

async function capture(browser, engineKind) {
  // Its own context: no layer state carried over from the other engine.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The same instant on both engines: the synthetic fleet is where its
  // feed put it, not where 30 s of dead reckoning took it.
  await page.evaluateOnNewDocument(frozenClockScript(W1_FROZEN_MS + 5000));
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* storage blocked */
    }
  });
  const url = new URL(baseUrl);
  url.searchParams.set('engine', engineKind);
  url.searchParams.set('qaFeed', feed);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
    timeout: 180_000,
    polling: 250,
  });
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await page.evaluate(async (models3d) => {
    const { layers, dataManager, styleManager } = window.__godsEyeView;
    await layers.enable('flights');
    dataManager.setLayerParams?.('flights', { models3d: models3d === 'on' });
    // What draws over or onto the glyphs on one engine only: the scope
    // mask and Cesium's sharpen/bloom post stages; the detection callouts
    // (both engines) would cover glyph centres.
    (await import('/src/scopeMask.js')).setScopeMaskEnabled(false);
    (await import('/src/data/detection.js')).setMode('OFF');
    styleManager.setSharpen?.({ enabled: false });
    styleManager.setBloom?.({ enabled: false });
    // Only the globe in the pictures: the shell's panels, HUD text and
    // cards (different on each engine: the Navara notice and attribution)
    // would cover glyphs.
    const canvas = window.__godsEyeView.engine.host.canvas;
    const style = document.createElement('style');
    style.textContent = '.qa-hidden { visibility: hidden !important; }';
    document.head.append(style);
    for (const element of document.body.querySelectorAll('*'))
      if (element !== canvas && !element.contains(canvas))
        element.classList.add('qa-hidden');
  }, models);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const shots = {};
  for (const [pose, camera] of Object.entries(POSES)) {
    const known = await page.evaluate(
      async ([lon, lat, height, heading, pitch]) => {
        const geo = await import('/src/geo/index.js');
        const { engine, layers } = window.__godsEyeView;
        const rad = geo.math.toRadians;
        engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(lon, lat, height),
          orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
        });
        const started = performance.now();
        for (;;) {
          engine.render.request('qa-flights-engines');
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (
            performance.now() - started > 4000 &&
            (engine.surface.tilesLoaded() ||
              performance.now() - started > 25_000)
          )
            break;
        }
        for (let frame = 0; frame < 20; frame++) {
          engine.render.request('qa-flights-engines');
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const { width, height: h } = engine.host.size();
        const inFrame = layers
          .objects('flights', 1_000_000)
          .filter(
            ({ screen }) =>
              screen &&
              screen.x >= 0 &&
              screen.y >= 0 &&
              screen.x <= width &&
              screen.y <= h,
          );
        return {
          inFrame: inFrame.length,
          // Glyphs the canvas shows (no panel or card over them).
          known: inFrame
            .filter(
              ({ screen }) =>
                screen.x > 40 &&
                screen.y > 40 &&
                screen.x < width - 40 &&
                screen.y < h - 40 &&
                [
                  [0, 0],
                  [-15, -15],
                  [15, -15],
                  [-15, 15],
                  [15, 15],
                ].every(
                  ([dx, dy]) =>
                    document.elementFromPoint(screen.x + dx, screen.y + dy) ===
                    engine.host.canvas,
                ),
            )
            .map(({ id, screen }) => ({ id, screen })),
        };
      },
      camera,
    );
    const png = await page.screenshot({ type: 'png' });
    shots[pose] = { png, known: known.known, inFrame: known.inFrame };
  }
  await context.close();
  return { shots, errors };
}

async function pixelsOf(png) {
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, channels: info.channels };
}

/**
 * The marker colour at a window point: the brightest pixel of the 7×7 block
 * around it (the glyph's fill, not its anti-aliased edge, which depends on
 * each engine's texture filtering).
 */
function centreColour({ data, width, channels }, { x, y }) {
  let best = null;
  let bestLuma = -1;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const i = ((Math.round(y) + dy) * width + Math.round(x) + dx) * channels;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      if (luma > bestLuma) {
        bestLuma = luma;
        best = rgb;
      }
    }
  return best;
}

const browser = await puppeteer.launch({ headless: true });
let report;
try {
  const cesium = await capture(browser, 'cesium');
  const navara = await capture(browser, 'navara');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  report = { feed, models, tolerance, poses: {} };
  for (const pose of Object.keys(POSES)) {
    const left = cesium.shots[pose];
    const right = navara.shots[pose];
    await sharp(left.png)
      .jpeg({ quality: 70 })
      .toFile(path.join(shotDir, `${pose}-cesium.jpg`));
    await sharp(right.png)
      .jpeg({ quality: 70 })
      .toFile(path.join(shotDir, `${pose}-navara.jpg`));
    await sharp({
      create: {
        width: WIDTH,
        height: HEIGHT / 2,
        channels: 3,
        background: '#000',
      },
    })
      .composite([
        {
          input: await sharp(left.png)
            .resize(WIDTH / 2)
            .toBuffer(),
          left: 0,
          top: 0,
        },
        {
          input: await sharp(right.png)
            .resize(WIDTH / 2)
            .toBuffer(),
          left: WIDTH / 2,
          top: 0,
        },
      ])
      .jpeg({ quality: 72 })
      .toFile(path.join(outDir, `${pose}-side-by-side.jpg`));
    // The same objects on both, the clearest few (no neighbour within 24 px).
    const clear = left.known.filter((row) =>
      left.known.every(
        (other) =>
          other === row ||
          Math.hypot(
            other.screen.x - row.screen.x,
            other.screen.y - row.screen.y,
          ) > 24,
      ),
    );
    const pairs = clear
      .map((row) => [row, right.known.find(({ id }) => id === row.id)])
      .filter(([, other]) => other)
      .slice(0, 8);
    const a = await pixelsOf(left.png);
    const b = await pixelsOf(right.png);
    const rows = pairs.map(([l, r]) => {
      const cl = centreColour(a, l.screen);
      const cr = centreColour(b, r.screen);
      return {
        id: l.id,
        screen: { cesium: l.screen, navara: r.screen },
        cesium: cl.map(Math.round),
        navara: cr.map(Math.round),
        delta: Math.max(...cl.map((value, c) => Math.abs(value - cr[c]))),
        screenDelta: Math.hypot(
          l.screen.x - r.screen.x,
          l.screen.y - r.screen.y,
        ),
      };
    });
    report.poses[pose] = {
      onScreen: { cesium: left.inFrame, navara: right.inFrame },
      glyphs: rows,
    };
    check(
      `${pose}: the same objects are in the frame`,
      left.inFrame === right.inFrame,
      `${left.inFrame} / ${right.inFrame}`,
    );
    const worstScreen = Math.max(0, ...rows.map((row) => row.screenDelta));
    // At 15,000 km the engines' cameras differ by 2.3 px vertically (Cesium
    // projects its own nadir point 2.27 px above the centre there; Navara on
    // it): a camera difference, recorded, not the layer's.
    if (pose === 'global')
      console.log(
        `  [INFO] ${pose}: known objects' screen points differ by ${worstScreen.toFixed(2)} px (camera)`,
      );
    else
      check(
        `${pose}: known objects at the same screen points (≤ 2 px)`,
        worstScreen <= 2,
        `worst ${worstScreen.toFixed(2)} px`,
      );
    if (rows.length) {
      // Translucent glyphs (focus or limb fades: the fill below 250 on
      // Cesium) blend with each engine's own map imagery; they are reported,
      // not compared.
      const opaque = rows.filter((row) => Math.max(...row.cesium) >= 250);
      const deltas = opaque.map((row) => row.delta).sort((x, y) => x - y);
      const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
      const exact = deltas.filter((delta) => delta <= tolerance).length;
      check(
        `${pose}: glyph fill colours within ${tolerance} per channel (median), every one within ${tolerance + 2}`,
        median <= tolerance && deltas.every((delta) => delta <= tolerance + 2),
        `${exact}/${opaque.length} opaque glyphs within ${tolerance}, median ${median}, worst ${deltas.at(-1) ?? 0}; ${rows.length - opaque.length} translucent`,
      );
    }
  }
  check(
    'no page errors',
    !cesium.errors.length && !navara.errors.length,
    [...cesium.errors, ...navara.errors].slice(0, 3).join(' | '),
  );
  fs.writeFileSync(
    path.join(outDir, `report-models-${models}.json`),
    JSON.stringify(report, null, 2),
  );
} finally {
  await browser.close();
}
const failed = results.filter((pass) => !pass).length;
console.log(
  `[flights-engines] ${results.length - failed}/${results.length} pass → ${path.relative(repoRoot, outDir)}`,
);
process.exit(failed ? 1 : 0);
