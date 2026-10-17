#!/usr/bin/env node
/**
 * Vessels side by side on both engines (phase 3 Task 13b): the 12 000-row
 * vessel fixture (?qaFeed=vessels:fixture) at the global, city, orbit and
 * port poses, the same page clock on both. Writes each engine's picture and
 * a side-by-side JPEG (Cesium left, Navara right) per pose to
 * docs/migration/phase3/vessels/, and checks per pose:
 *   - the same vessels in the frame;
 *   - the clearest known vessels at the same screen points (≤ 2 px; the
 *     global pose's 2.27 px camera offset is reported, see
 *     qa-flights-engines);
 *   - the chevron screen rotations within 0.5°, the same scale and alpha;
 *   - the chevron fill colour (the pixel nearest its type colour) within
 *     --tolerance (3) per channel;
 *   - the same cards (vessel ids) with their anchors at the same screen
 *     points (≤ 2 px), and the card count.
 *
 *   node scripts/qa-vessels-engines.mjs --base-url=http://localhost:PORT/
 *     [--out=docs/migration/phase3/vessels] [--tolerance=3]
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
  argument('out') ?? 'docs/migration/phase3/vessels',
);
const shotDir = path.resolve(repoRoot, 'qa-artifacts/vessels-engines');
const tolerance = Number(argument('tolerance') ?? 3);
const POSES = {
  global: [-40, 30, 15_000_000, 0, -90],
  city: [-73.78, 40.64, 60_000, 0, -90],
  orbit: [-73.78, 40.64, 1_500_000, 0, -90],
  // The fixture's vessels off JFK, 20 km up: chevrons and cards.
  port: [-73.9, 40.5, 20_000, 0, -90],
};
const WIDTH = 1280;
const HEIGHT = 800;
const LAYER = 'ais-live-vessels';

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(
    `  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
};

async function capture(engineKind) {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text().slice(0, 200));
    });
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
    url.searchParams.set('qaFeed', 'vessels:fixture');
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
      timeout: 180_000,
      polling: 250,
    });
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const shots = {};
    let first = true;
    for (const [pose, camera] of Object.entries(POSES)) {
      const read = await page.evaluate(
        async ([lon, lat, height, heading, pitch], layerId, enable) => {
          const geo = await import('/src/geo/index.js');
          const { engine, layers, dataManager, styleManager } =
            window.__godsEyeView;
          const rad = geo.math.toRadians;
          const frames = async (count) => {
            for (let frame = 0; frame < count; frame++) {
              engine.render.request('qa-vessels-engines');
              await new Promise((resolve) => requestAnimationFrame(resolve));
            }
          };
          engine.camera.setView({
            destination: geo.cartesian3.fromDegrees(lon, lat, height),
            orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
          });
          await frames(10);
          if (enable) {
            await layers.enable(layerId);
            (await import('/src/scopeMask.js')).setScopeMaskEnabled(false);
            (await import('/src/data/detection.js')).setMode('OFF');
            styleManager.setSharpen?.({ enabled: false });
            styleManager.setBloom?.({ enabled: false });
            const canvases = [
              engine.host.canvas,
              document.getElementById('world-overlay-canvas'),
            ].filter(Boolean);
            const style = document.createElement('style');
            style.textContent = '.qa-hidden { visibility: hidden !important; }';
            document.head.append(style);
            for (const element of document.body.querySelectorAll('*'))
              if (!canvases.some((c) => element === c || element.contains(c)))
                element.classList.add('qa-hidden');
          }
          const module = dataManager.layers.get(layerId).module;
          const started = performance.now();
          await frames(20);
          while (
            module.getStats().loading &&
            performance.now() - started < 20_000
          )
            await new Promise((resolve) => setTimeout(resolve, 100));
          for (;;) {
            await frames(10);
            if (
              performance.now() - started > 4000 &&
              (engine.surface.tilesLoaded() ||
                performance.now() - started > 25_000)
            )
              break;
          }
          // Two card passes (800 ms) and the overlay's paint.
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await frames(20);
          const { width, height: h } = engine.host.size();
          const screenOf = (position) => {
            if (!position || !engine.projector.horizonVisible(position))
              return null;
            const s = engine.projector.worldToWindow(position);
            return s ? { x: s.x, y: s.y } : null;
          };
          const drawn = layers.drawn(layerId);
          const inFrame = drawn.chevrons
            .filter((row) => row.show)
            .map((row) => ({ ...row, screen: screenOf(row.position) }))
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
            chevrons: Object.fromEntries(
              inFrame.map((row) => [
                row.id,
                {
                  screen: row.screen,
                  rotation: row.rotation,
                  scale: row.scale,
                  alpha: row.alpha,
                  css: row.css,
                },
              ]),
            ),
            cards: drawn.cards.map((card) => ({
              id: card.id,
              screen: screenOf(card.position),
            })),
            known: inFrame
              .filter(
                ({ screen }) =>
                  screen.x > 40 &&
                  screen.y > 40 &&
                  screen.x < width - 40 &&
                  screen.y < h - 40,
              )
              .map(({ id, screen }) => ({ id, screen })),
          };
        },
        camera,
        LAYER,
        first,
      );
      first = false;
      shots[pose] = { ...read, png: await page.screenshot({ type: 'png' }) };
    }
    return { shots, errors };
  } finally {
    await browser.close();
  }
}

async function pixelsOf(png) {
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, channels: info.channels };
}

const hexRgb = (css) => {
  const hex = css.replace('#', '');
  return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
};

/** The pixel nearest the chevron's fill colour in the 7×7 block around it. */
function fillColour({ data, width, channels }, { x, y }, fill) {
  let best = null;
  let bestScore = -Infinity;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const i = ((Math.round(y) + dy) * width + Math.round(x) + dx) * channels;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      const score = -Math.hypot(
        rgb[0] - fill[0],
        rgb[1] - fill[1],
        rgb[2] - fill[2],
      );
      if (score > bestScore) {
        bestScore = score;
        best = rgb;
      }
    }
  return best;
}

const cesium = await capture('cesium');
const navara = await capture('navara');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(shotDir, { recursive: true });
const report = { tolerance, poses: {} };
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

  const entry = { onScreen: { cesium: left.inFrame, navara: right.inFrame } };
  report.poses[pose] = entry;
  check(
    `${pose}: the same vessels are in the frame`,
    left.inFrame === right.inFrame,
    `${left.inFrame} / ${right.inFrame}`,
  );
  // Screen points of the clearest known vessels (no neighbour within 24 px).
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
  const worstScreen = Math.max(
    0,
    ...pairs.map(([l, r]) =>
      Math.hypot(l.screen.x - r.screen.x, l.screen.y - r.screen.y),
    ),
  );
  entry.known = pairs.length;
  entry.worstScreenPx = worstScreen;
  if (pose === 'global')
    console.log(
      `  [INFO] ${pose}: known vessels' screen points differ by ${worstScreen.toFixed(2)} px (camera)`,
    );
  else
    check(
      `${pose}: known vessels at the same screen points (≤ 2 px)`,
      pairs.length > 0 && worstScreen <= 2,
      `${pairs.length} vessels, worst ${worstScreen.toFixed(2)} px`,
    );
  // Rotations, scale, alpha of every chevron in the frame on both.
  let worstRotation = 0;
  let worstScale = 0;
  let worstAlpha = 0;
  let compared = 0;
  for (const [id, row] of Object.entries(left.chevrons)) {
    const other = right.chevrons[id];
    if (!other) continue;
    compared++;
    worstRotation = Math.max(
      worstRotation,
      Math.abs(
        Math.atan2(
          Math.sin(row.rotation - other.rotation),
          Math.cos(row.rotation - other.rotation),
        ),
      ),
    );
    worstScale = Math.max(worstScale, Math.abs(row.scale - other.scale));
    worstAlpha = Math.max(worstAlpha, Math.abs(row.alpha - other.alpha));
  }
  entry.rotation = { compared, worstDeg: (worstRotation * 180) / Math.PI };
  check(
    `${pose}: chevron screen rotations within 0.5°, the same scale and alpha`,
    compared > 0 &&
      (worstRotation * 180) / Math.PI <= 0.5 &&
      worstScale < 1e-9 &&
      worstAlpha < 1e-6,
    `${compared} chevrons, worst ${((worstRotation * 180) / Math.PI).toFixed(3)}°, scale Δ ${worstScale}, alpha Δ ${worstAlpha}`,
  );
  // Fill colours at the known vessels (not at the global pose: a chevron
  // there is a few pixels across and the cameras differ by 2.27 px).
  const a = await pixelsOf(left.png);
  const b = await pixelsOf(right.png);
  const colours = pairs.map(([l, r]) => {
    const fill = hexRgb(left.chevrons[l.id].css);
    const cl = fillColour(a, l.screen, fill);
    const cr = fillColour(b, r.screen, fill);
    return {
      id: l.id,
      fill,
      cesium: cl,
      navara: cr,
      delta: Math.max(...cl.map((value, c) => Math.abs(value - cr[c]))),
    };
  });
  entry.colours = colours;
  // Chevrons whose Cesium sample is not their fill (map pixels showing
  // through the anti-aliased edge of a small chevron) are reported only.
  const solid = colours.filter((row) =>
    row.cesium.every((value, c) => Math.abs(value - row.fill[c]) <= 3),
  );
  const worstColour = Math.max(0, ...solid.map((row) => row.delta));
  if (pose === 'global')
    console.log(
      `  [INFO] ${pose}: chevron fill colours — worst ${worstColour} over ${solid.length}`,
    );
  else
    check(
      `${pose}: chevron fill colours within ${tolerance} per channel`,
      solid.length > 0 && worstColour <= tolerance,
      `${solid.length}/${colours.length} solid samples, worst ${worstColour}`,
    );
  // Cards: the same vessels carded, anchors at the same screen points.
  const leftCards = new Map(left.cards.map((card) => [card.id, card]));
  const rightCards = new Map(right.cards.map((card) => [card.id, card]));
  const sameIds =
    leftCards.size === rightCards.size &&
    [...leftCards.keys()].every((id) => rightCards.has(id));
  let worstCard = 0;
  for (const [id, card] of leftCards) {
    const other = rightCards.get(id);
    if (!other?.screen || !card.screen) continue;
    worstCard = Math.max(
      worstCard,
      Math.hypot(
        card.screen.x - other.screen.x,
        card.screen.y - other.screen.y,
      ),
    );
  }
  entry.cards = {
    cesium: leftCards.size,
    navara: rightCards.size,
    sameIds,
    worstPx: worstCard,
  };
  check(
    `${pose}: the same cards (${leftCards.size} / ${rightCards.size}), anchors within 2 px`,
    sameIds && (pose === 'global' || worstCard <= 2),
    `worst ${worstCard.toFixed(2)} px`,
  );
}
check(
  'no page errors on either engine',
  cesium.errors.length === 0 && navara.errors.length === 0,
  [...cesium.errors, ...navara.errors].slice(0, 3).join(' | ') || '0',
);
fs.writeFileSync(
  path.join(shotDir, 'report.json'),
  JSON.stringify(report, null, 2),
);
const failed = results.filter((pass) => !pass).length;
console.log(
  `[vessels-engines] ${results.length - failed}/${results.length} passed → ${path.relative(repoRoot, outDir)}`,
);
process.exit(failed ? 1 : 0);
