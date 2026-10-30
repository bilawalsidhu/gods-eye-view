#!/usr/bin/env node
/**
 * An aircraft layer on Cesium and Navara side by side (phase 3 Tasks 10b,
 * 11b; parity item 1): the same synthetic fleet (?qaFeed=…) at the global,
 * city, orbit and near poses on both engines. Writes each engine's canvas
 * and a side-by-side JPEG (Cesium left, Navara right) to --out, and compares
 * the colour drawn at the centre of known glyphs (the same objects on both
 * engines): every channel within --tolerance (default 3). With
 * --models=on, the near pose gates the 3D models: the pixels they cover
 * (against the same view with the layer off) within ±20 % of Cesium's, and
 * their median luminance within ±10 %.
 *
 *   node scripts/qa-flights-engines.mjs --base-url=http://localhost:PORT/
 *     [--layer=flights|military|local-adsb]
 *     [--out=docs/migration/phase3/<layer>]
 *     [--feed=flights:synthetic:10000] [--models=off|on] [--tolerance=3]
 *     [--near=lon,lat,height,heading,pitch]
 *
 * The server is the caller's (never ports 4185-4189). Headless only. Exits 1
 * on a failed check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { installTileCache } from './qa/tileCache.mjs';
import { redact, isExpectedPreviewSetupError } from './qa-browserEvidence.mjs';
import sharp from 'sharp';
import { frozenClockScript } from '../src/tooling/w1Baseline.js';
import { W1_FROZEN_MS, syntheticLocalReceivers } from '../src/bench/w1Feeds.js';

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
const layer = argument('layer') ?? 'flights';
const DEFAULT_FEEDS = {
  flights: 'flights:synthetic:10000',
  military: 'military:synthetic:1000',
  'local-adsb': 'local-adsb:fixture',
};
const outDir = path.resolve(
  repoRoot,
  argument('out') ??
    `docs/migration/phase3/${layer}${argument('models') === 'on' ? '/models' : ''}`,
);
// Each engine's full picture (git-ignored); --out keeps the side-by-side.
const shotDir = path.resolve(
  repoRoot,
  argument('shots') ?? `qa-artifacts/${layer}-engines`,
);
const feed = argument('feed') ?? DEFAULT_FEEDS[layer];
// A tinted layer's glyph fill (sRGB bytes); null: white glyphs (flights).
const FILL = { military: [255, 184, 0], 'local-adsb': [255, 79, 216] }[layer];
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
// Military's aircraft in the flights near view are on the ground, which
// stay glyphs until the ground is sampled: its near pose is 100 km over JFK,
// where its airborne fleet are models.
// The sparse local fixture needs a wider near view for at least three models.
const LAYER_NEAR = {
  military: [-73.78, 40.64, 100_000, 0, -90],
  'local-adsb': [-73.78, 40.64, 60_000, 0, -90],
};
// UAT rings are a separate graphic. Their contrast must not count as model area.
const localUatIds =
  layer === 'local-adsb'
    ? syntheticLocalReceivers()
        .records.filter((row) => row.band === '978')
        .map((row) => row.icao)
    : [];
if (LAYER_NEAR[layer]) POSES.near = LAYER_NEAR[layer];
// --near=lon,lat,height,heading,pitch: another near pose.
if (argument('near')) POSES.near = argument('near').split(',').map(Number);
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
  await blockPaidQaMaps(page);
  await installTileCache(page);
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  const errors = [];
  const expectedPreviewErrors = [];
  page.on('pageerror', (error) => errors.push(redact(error.message)));
  page.on('console', (message) => {
    if (
      isExpectedPreviewSetupError(message, {
        preview: process.argv.includes('--preview'),
        baseUrl,
      })
    ) {
      expectedPreviewErrors.push('/api/setup/status: 404');
      return;
    }
    if (message.type() === 'error')
      errors.push(redact(message.text()).slice(0, 200));
  });
  // The same instant on both engines: the synthetic fleet is where its
  // feed put it, not where 30 s of dead reckoning took it.
  await page.evaluateOnNewDocument(frozenClockScript(W1_FROZEN_MS + 5000));
  if (layer === 'local-adsb')
    await page.evaluateOnNewDocument(() => {
      // Its independent eligibility cadence needs a deterministic tick after
      // each camera move; the shared aircraft layers reset on moveEnd.
      window.__qaLocalPixelNow = Date.now();
      Date.now = () => window.__qaLocalPixelNow;
    });
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
  await page
    .waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
      timeout: 180_000,
      polling: 250,
    })
    .catch((error) => {
      throw new Error(
        `${engineKind} page did not start: ${errors.slice(0, 3).join(' | ')}`,
        { cause: error },
      );
    });
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await page.evaluate(
    async (models3d, layerId) => {
      const { layers, dataManager, styleManager } = window.__godsEyeView;
      await layers.enable(layerId);
      // Local ADS-B inherits the DISPLAY preference from Flights.
      const displayLayer = layerId === 'local-adsb' ? 'flights' : layerId;
      dataManager.setLayerParams?.(displayLayer, {
        models3d: models3d === 'on',
      });
      if (layerId === 'local-adsb' && !Array.isArray(layers.drawn(layerId)))
        throw new Error('Local ADS-B drawn-state probe is unavailable');
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
    },
    models,
    layer,
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const shots = {};
  for (const [pose, camera] of Object.entries(POSES)) {
    const known = await page.evaluate(
      async ([lon, lat, height, heading, pitch], layerId, uatIds) => {
        const geo = await import('/src/geo/index.js');
        const { engine, layers } = window.__godsEyeView;
        const rad = geo.math.toRadians;
        if (layerId === 'local-adsb') window.__qaLocalPixelNow += 100;
        engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(lon, lat, height),
          orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
        });
        // The page clock is frozen, so the layer's 12 Hz fleet tick runs only
        // when a camera move ends (it resets the tick): end one, as a user's
        // move would, so rotations are computed at this pose on both engines.
        // Models take a few ticks (load, then hand-off), so the move ends
        // every 10 frames while the view loads.
        const { viewer } = window.__godsEyeView;
        const moveEnd = () =>
          (viewer ? viewer.camera.moveEnd : engine.camera.moveEnd).raiseEvent();
        moveEnd();
        const started = performance.now();
        for (let frame = 1; ; frame++) {
          engine.render.request('qa-flights-engines');
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (frame % 10 === 0) moveEnd();
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
          .objects(layerId, 1_000_000)
          .filter(
            ({ screen }) =>
              screen &&
              screen.x >= 0 &&
              screen.y >= 0 &&
              screen.x <= width &&
              screen.y <= h,
          );
        // The glyphs' screen rotations as the layer drew them (the probe).
        const framed = new Set(inFrame.map(({ id }) => id));
        // Objects a 3D model draws (glyph hidden): their colour is the
        // engine's lighting of a glTF, compared apart.
        const modelled = (layers.drawn(layerId) ?? [])
          .filter((row) => row.model?.show && row.model?.ready)
          .map((row) => row.id);
        const rotations = Object.fromEntries(
          (layers.drawn(layerId) ?? [])
            .filter(
              (row) => !row.trackedModel && row.show && framed.has(row.id),
            )
            .map((row) => [row.id, row.rotation]),
        );
        return {
          rotations,
          modelled,
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
          // Every modelled object's screen point (the model gate).
          modelPoints: inFrame
            .filter(({ id }) => modelled.includes(id) && !uatIds.includes(id))
            .map(({ id, screen }) => ({ id, screen })),
          // The glyphs' drawn alpha (focus and limb fades).
          alphas: Object.fromEntries(
            (layers.drawn(layerId) ?? [])
              .filter((row) => !row.trackedModel)
              .map((row) => [row.id, row.alpha]),
          ),
          computedScales: Object.fromEntries(
            (layers.drawn(layerId) ?? [])
              .filter((row) => row.model?.show && row.model?.ready)
              .map((row) => [row.id, row.model.computedScale]),
          ),
        };
      },
      camera,
      layer,
      localUatIds,
    );
    const png = await page.screenshot({ type: 'png' });
    // The same view without the layer (the model gate's background): the
    // last pose only, then the layer is off.
    let background = null;
    if (pose === 'near' && models === 'on') {
      await page.evaluate(async (layerId) => {
        const { layers, engine } = window.__godsEyeView;
        await layers.disable(layerId);
        for (let frame = 0; frame < 30; frame++) {
          engine.render.request('qa-flights-engines');
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }, layer);
      background = await page.screenshot({ type: 'png' });
    }
    shots[pose] = {
      png,
      known: known.known,
      inFrame: known.inFrame,
      rotations: known.rotations,
      modelled: new Set(known.modelled),
      modelPoints: known.modelPoints,
      computedScales: known.computedScales,
      alphas: known.alphas,
      background,
    };
  }
  await context.close();
  return { shots, errors, expectedPreviewErrors };
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
  let bestScore = -Infinity;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const i = ((Math.round(y) + dy) * width + Math.round(x) + dx) * channels;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      // White glyphs (flights): the brightest pixel. A tinted layer's glyph
      // (military amber, local magenta) can be smaller than a bright map
      // pixel beside it: the pixel nearest its fill colour.
      const score = FILL
        ? -Math.hypot(rgb[0] - FILL[0], rgb[1] - FILL[1], rgb[2] - FILL[2])
        : 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      if (score > bestScore) {
        bestScore = score;
        best = rgb;
      }
    }
  return best;
}

// A browser per engine: after Cesium's models the same browser sometimes
// never brought up the Navara page (its WebGL context).
const capturedOn = async (engineKind) => {
  const own = await puppeteer.launch({
    headless: true,
    args: ['--use-angle=metal'],
  });
  try {
    return await capture(own, engineKind);
  } finally {
    await own.close();
  }
};
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal'],
});
let report;
try {
  const cesium = await capturedOn('cesium');
  const navara = await capturedOn('navara');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  report = {
    expectedPreviewErrors: {
      cesium: cesium.expectedPreviewErrors,
      navara: navara.expectedPreviewErrors,
    },
    feed,
    models,
    tolerance,
    poses: {},
  };
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
    const modelled = (id) => left.modelled.has(id) || right.modelled.has(id);
    const rows = pairs
      .filter(([l]) => !modelled(l.id))
      .map(([l, r]) => {
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
    check(
      `${pose}: known objects at the same screen points (≤ 2 px)`,
      worstScreen <= 2,
      `worst ${worstScreen.toFixed(2)} px`,
    );
    // Screen rotations of every glyph shown on both (the layer computes them
    // from each engine's camera basis): within 0.5°.
    let worstRotation = 0;
    let compared = 0;
    for (const [id, rotation] of Object.entries(left.rotations)) {
      const other = right.rotations[id];
      if (other === undefined) continue;
      compared++;
      const delta = Math.abs(
        Math.atan2(Math.sin(rotation - other), Math.cos(rotation - other)),
      );
      worstRotation = Math.max(worstRotation, delta);
    }
    report.poses[pose].rotation = {
      pairs: Object.entries(left.rotations)
        .filter(([id]) => right.rotations[id] !== undefined)
        .slice(0, 30)
        .map(([id, r]) => [
          id,
          +((r * 180) / Math.PI).toFixed(2),
          +((right.rotations[id] * 180) / Math.PI).toFixed(2),
        ]),
      compared,
      worstDeg: (worstRotation * 180) / Math.PI,
    };
    if (pairs.some(([l]) => modelled(l.id)))
      console.log(
        `  [INFO] ${pose}: ${pairs.filter(([l]) => modelled(l.id)).length} known objects drawn as 3D models (lit by each engine; not compared)`,
      );
    check(
      `${pose}: glyph screen rotations within 0.5°`,
      compared === 0 || (worstRotation * 180) / Math.PI <= 0.5,
      `${compared} glyphs, worst ${((worstRotation * 180) / Math.PI).toFixed(3)}°`,
    );
    if (rows.length) {
      // Translucent glyphs (focus or limb fades: the fill below 250 on
      // Cesium, or for a tinted layer more than 3 per channel off its fill)
      // blend with each engine's own map imagery; they are reported, not
      // compared.
      const opaque = rows.filter((row) =>
        FILL
          ? // The layer draws it opaque on both (its drawn alpha), and the
            // Cesium sample is its fill (a glyph a few pixels across can
            // lose its fill to filtering).
            left.alphas?.[row.id] >= 0.999 &&
            right.alphas?.[row.id] >= 0.999 &&
            row.cesium.every((value, c) => Math.abs(value - FILL[c]) <= 3)
          : Math.max(...row.cesium) >= 250,
      );
      const deltas = opaque.map((row) => row.delta).sort((x, y) => x - y);
      const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
      const exact = deltas.filter((delta) => delta <= tolerance).length;
      const summary = `${exact}/${opaque.length} opaque glyphs within ${tolerance}, median ${median}, worst ${deltas.at(-1) ?? 0}; ${rows.length - opaque.length} translucent`;
      if (layer === 'local-adsb' && models === 'off' && pose === 'city')
        check(
          'city: local palette has opaque glyph samples',
          opaque.length > 0,
          summary,
        );
      if (layer === 'local-adsb' && opaque.length === 0)
        console.log(
          `  [INFO] ${pose}: no opaque local glyph fill to compare (hidden or modelled)`,
        );
      else
        check(
          `${pose}: glyph fill colours within ${tolerance} per channel (median), every one within ${tolerance + 2}`,
          median <= tolerance &&
            deltas.every((delta) => delta <= tolerance + 2),
          summary,
        );
    }
  }
  if (models === 'on') {
    if (layer === 'local-adsb') {
      report.modelSample =
        'Non-UAT aircraft isolate model photometry from the UAT ring.';
      console.log(`  [INFO] ${report.modelSample}`);
    }
    // The 3D models at the near pose: the pixels each covers (the shot
    // against the same view with the layer off, max |Δ RGB| > 25 within
    // 26 px of its point) and their luminance, per object modelled on both.
    const left = cesium.shots.near;
    const right = navara.shots.near;
    for (const [kind, shot] of [
      ['cesium', left],
      ['navara', right],
    ]) {
      fs.writeFileSync(path.join(outDir, `near-${kind}.png`), shot.png);
      fs.writeFileSync(
        path.join(outDir, `near-${kind}-background.png`),
        shot.background,
      );
    }
    report.modelPoints = {
      cesium: left.modelPoints,
      navara: right.modelPoints,
    };
    const footprints = async (shot) => {
      const a = await pixelsOf(shot.png);
      const b = await pixelsOf(shot.background);
      const luma = (p, i) =>
        0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
      const rows = new Map();
      for (const { id, screen } of shot.modelPoints) {
        let pixels = 0;
        let sum = 0;
        const lumas = [];
        for (let y = Math.round(screen.y) - 26; y < screen.y + 26; y++)
          for (let x = Math.round(screen.x) - 26; x < screen.x + 26; x++) {
            if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
            const i = (y * a.width + x) * a.channels;
            // Equal-luminance magenta and imagery still differ in colour.
            const delta = Math.max(
              Math.abs(a.data[i] - b.data[i]),
              Math.abs(a.data[i + 1] - b.data[i + 1]),
              Math.abs(a.data[i + 2] - b.data[i + 2]),
            );
            if (delta > 25) {
              pixels++;
              sum += luma(a, i);
              lumas.push(luma(a, i));
            }
          }
        lumas.sort((p, q) => p - q);
        rows.set(id, {
          pixels,
          luminance: pixels ? sum / pixels : null,
          // The highlights: the brightest tenth, and the near-white pixels.
          p90: lumas.length ? lumas[Math.floor(lumas.length * 0.9)] : null,
          highlights: lumas.filter((value) => value >= 230).length,
        });
      }
      return rows;
    };
    const fl = await footprints(left);
    const fr = await footprints(right);
    const ids = [...fl.keys()].filter((id) => fr.has(id));
    const total = (rows) =>
      ids.reduce((sum, id) => sum + rows.get(id).pixels, 0);
    const median = (values) => {
      const sorted = values.filter(Number.isFinite).sort((x, y) => x - y);
      return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    };
    const lum = (rows) => median(ids.map((id) => rows.get(id).luminance));
    const p90 = (rows) => median(ids.map((id) => rows.get(id).p90));
    const highlights = (rows) =>
      ids.reduce((sum, id) => sum + rows.get(id).highlights, 0);
    // The drawn size: each model's scale after the minimum pixel size.
    const sizeRatios = ids
      .map((id) => right.computedScales[id] / left.computedScales[id])
      .filter(Number.isFinite);
    const models3d = {
      footprintMask: 'max RGB channel delta >25/255',
      perObject: ids.map((id) => ({
        id,
        cesium: fl.get(id),
        navara: fr.get(id),
      })),
      objects: ids.length,
      computedScaleRatio: {
        median: median(sizeRatios),
        min: Math.min(...sizeRatios),
        max: Math.max(...sizeRatios),
      },
      footprintPx: { cesium: total(fl), navara: total(fr) },
      medianLuminance: { cesium: lum(fl), navara: lum(fr) },
      p90Luminance: { cesium: p90(fl), navara: p90(fr) },
      highlightPx: { cesium: highlights(fl), navara: highlights(fr) },
    };
    report.poses.near.models = models3d;
    const ratio = models3d.footprintPx.navara / models3d.footprintPx.cesium;
    const lumRatio =
      models3d.medianLuminance.navara / models3d.medianLuminance.cesium;
    check(
      'near: 3D models on both engines',
      ids.length >= 5,
      `${ids.length} objects modelled on both`,
    );
    check(
      'near: model drawn size (computed scale) within ±5 % of Cesium',
      sizeRatios.length > 0 &&
        sizeRatios.every((value) => Math.abs(value - 1) <= 0.05),
      JSON.stringify(models3d.computedScaleRatio),
    );
    check(
      'near: model footprint within ±20 % of Cesium',
      Math.abs(ratio - 1) <= 0.2,
      `${models3d.footprintPx.navara} vs ${models3d.footprintPx.cesium} px (${(ratio * 100).toFixed(0)} %)`,
    );
    const p90Ratio =
      models3d.p90Luminance.navara / models3d.p90Luminance.cesium;
    check(
      'near: model highlights (p90 luminance) within ±10 % of Cesium',
      Math.abs(p90Ratio - 1) <= 0.1,
      `${models3d.p90Luminance.navara?.toFixed(1)} vs ${models3d.p90Luminance.cesium?.toFixed(1)}; near-white px ${models3d.highlightPx.navara} vs ${models3d.highlightPx.cesium}`,
    );
    check(
      'near: model luminance within ±10 % of Cesium (median)',
      Math.abs(lumRatio - 1) <= 0.1,
      `${models3d.medianLuminance.navara?.toFixed(1)} vs ${models3d.medianLuminance.cesium?.toFixed(1)}`,
    );
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
