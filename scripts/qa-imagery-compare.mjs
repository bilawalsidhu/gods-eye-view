#!/usr/bin/env node
/**
 * Draw the rasters that moved to engine.imagery — the Active Fires far-zoom
 * heatmap and Recent Imagery — on both real engines, read the canvas back,
 * and compare two runs pixel by pixel (before and after a change), and the
 * two engines against each other. Run it against a keyless dev server of
 * each version, then compare:
 *
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 4291
 *   node scripts/qa-imagery-compare.mjs shoot http://localhost:4291 --out=DIR
 *   node scripts/qa-imagery-compare.mjs compare BEFORE_DIR AFTER_DIR
 *
 * Every scene freezes the app clock at local noon (Navara lights the scene
 * with the app clock's sun) and waits for the map tiles. The heatmap is a
 * fixed set of fires through the layer's own raster builder; Recent Imagery
 * draws generated tiles (a gradient per tile, intercepted at qa-tiles.test)
 * through the layer's renderer from the registry, falling back to the
 * renderers of older versions. Each scene is shot with and without the
 * raster: `overlay` is where the raster changed the frame. Google and
 * Cesium ion are blocked, so no engine draws photoreal tiles.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const BLOCKED_HOSTS =
  /(^|\.)(googleapis\.com|google\.com|gstatic\.com|cesium\.com)$/;
const TILE_HOST = 'qa-tiles.test';
const args = process.argv.slice(2);
const [command, first, second] = args.filter((arg) => !arg.startsWith('--'));
const option = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const SIZE = { width: 1280, height: 800 };

// Fires on three continents, a dense cluster and a sparse field each.
const FIRES = [
  ...Array.from({ length: 400 }, (_, i) => ({
    lat: 8 + (i % 20) * 0.08,
    lon: 18 + Math.floor(i / 20) * 0.09,
    frp: 40 + (i % 7) * 30,
  })),
  ...Array.from({ length: 120 }, (_, i) => ({
    lat: -12 + (i % 12) * 0.9,
    lon: 22 + Math.floor(i / 12) * 1.1,
    frp: 8 + (i % 5) * 6,
  })),
  ...Array.from({ length: 60 }, (_, i) => ({
    lat: 4 + (i % 6) * 0.5,
    lon: 30 + Math.floor(i / 6) * 0.4,
    frp: 200,
  })),
];

const SCENES = [
  {
    id: 'heat-orbit',
    kind: 'heat',
    view: { lon: 22, lat: 2, height: 12_000_000 },
    noonUtc: 10.5,
  },
  {
    id: 'heat-regional',
    kind: 'heat',
    view: { lon: 19, lat: 8.8, height: 1_500_000 },
    noonUtc: 10.5,
  },
  {
    id: 'imagery-box',
    kind: 'imagery',
    view: { lon: -97.75, lat: 30.25, height: 16_000 },
    noonUtc: 18.5,
    slots: [{ id: 'a', product: 'S30', alpha: 1, split: 'none' }],
  },
  {
    id: 'imagery-swipe',
    kind: 'imagery',
    view: { lon: -97.75, lat: 30.25, height: 16_000 },
    noonUtc: 18.5,
    split: 0.5,
    slots: [
      { id: 'a', product: 'S30', alpha: 0.7, split: 'left' },
      { id: 'b', product: 'VIIRS', alpha: 1, split: 'right' },
    ],
  },
];
const BOX = { west: -97.8, south: 30.2, east: -97.7, north: 30.3 };

// A 256 px tile: red across, green down, blue by the tile's parity; the
// VIIRS product (JPEG on GIBS) is a darker variant.
const tileCache = new Map();
async function tile(z, x, y, dark) {
  const key = `${z}/${x}/${y}/${dark}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const data = Buffer.alloc(256 * 256 * 4);
  const parity = (x + y) % 2 ? 200 : 40;
  for (let row = 0; row < 256; row++)
    for (let column = 0; column < 256; column++) {
      const i = (row * 256 + column) * 4;
      const scale = dark ? 0.6 : 1;
      data[i] = column * scale;
      data[i + 1] = row * scale;
      data[i + 2] = parity * scale;
      data[i + 3] = 255;
    }
  const png = await sharp(data, {
    raw: { width: 256, height: 256, channels: 4 },
  })
    .png()
    .toBuffer();
  tileCache.set(key, png);
  return png;
}

async function shootScene(browser, origin, kind, scene) {
  const page = await browser.newPage();
  await page.setViewport(SIZE);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  let tiles = 0;
  page.on('request', async (request) => {
    const url = new URL(request.url());
    if (url.hostname === TILE_HOST) {
      tiles++;
      const [, product, z, y, x] = url.pathname.match(
        /^\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.png$/,
      );
      await request.respond({
        status: 200,
        contentType: 'image/png',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: await tile(+z, +x, +y, product === 'VIIRS'),
      });
    } else if (BLOCKED_HOSTS.test(url.hostname)) request.abort();
    else request.continue();
  });
  const { lon, lat, height } = scene.view;
  await page.goto(
    `${origin}/?welcome=0&engine=${kind}#v=2&lat=${lat}&lon=${lon}&alt=${height}&heading=0&pitch=-90&map=osm&l=`,
  );
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView?.engine?.kind === expected &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 300_000, polling: 250 },
    kind,
  );
  await page.waitForFunction(
    () => !window.__godsEyeView.engine.camera.flightActive(),
    { timeout: 60_000, polling: 250 },
  );
  // The scene: the view, noon, and helpers the shots below use.
  await page.evaluate(
    async ({ scene, fires, box, tileHost }) => {
      const { engine } = window.__godsEyeView;
      const geo = await import('/src/geo/index.js');
      const { appClock } = await import('/src/time/clock.js');
      const noon = Date.UTC(2026, 10, 7) + scene.noonUtc * 3_600_000;
      appClock.freeze(noon);
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(
          scene.view.lon,
          scene.view.lat,
          scene.view.height,
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      // `count` frames, each asked for (a scene at rest draws only on request).
      const frames = (count) =>
        new Promise((resolve) => {
          let left = count;
          const remove = engine.frames.postRender.addEventListener(() => {
            if (--left > 0) {
              setTimeout(() => engine.render.request('qa-imagery'), 0);
              return;
            }
            remove();
            resolve();
          });
          engine.render.request('qa-imagery');
        });
      const { rendererFor } = await import('/src/app/layers/renderers.js');
      const qa = { frames, raster: null };
      window.__qaImagery = qa;
      if (scene.kind === 'heat') {
        const [{ buildHeatRaster }, { HEAT_RASTER }] = await Promise.all([
          import('/src/data/firmsHeatRaster.js'),
          import('/src/layers/firms/policy.js'),
        ]);
        const display = rendererFor('local-firms', engine, { id: 'qa-firms' });
        const heat = display.createHeatImagery();
        const raster = buildHeatRaster(fires, HEAT_RASTER);
        qa.show = () => {
          heat.setRaster(raster);
          heat.setOpacity(1);
          heat.setShow(true);
        };
        qa.hide = () => heat.setShow(false);
        return;
      }
      const options = {
        tileTemplate: (product) =>
          `https://${tileHost}/${product}/{z}/{y}/{x}.png`,
        credit: 'QA tiles',
      };
      let renderer = rendererFor('recent-imagery', engine, options);
      const viewer = engine.extensions?.cesium?.viewer;
      if (!renderer) {
        // Versions before engine.imagery: Cesium's own renderer on the globe.
        const { createRecentImageryRenderer } =
          await import('/src/layers/recentImagery/rendering.js');
        renderer = createRecentImageryRenderer({
          ...options,
          requestRender: () => engine.render.request('qa-imagery'),
        });
        renderer.rebind({ collection: viewer.imageryLayers, kind: 'globe' });
      } else renderer.rebind(renderer.resolveHost());
      const candidate = (product) => ({
        key: `${product}:2026-10-28`,
        product,
        day: '2026-10-28',
      });
      qa.show = () => {
        if (scene.split != null) {
          renderer.setSplit?.(scene.split);
          if (viewer) viewer.scene.splitPosition = scene.split;
        }
        for (const slot of scene.slots)
          renderer.showSlot(slot.id, candidate(slot.product), box, {
            alpha: slot.alpha,
            splitDirection: slot.split,
          });
      };
      qa.hide = () => {
        for (const slot of scene.slots) renderer.hideSlot(slot.id);
      };
    },
    { scene, fires: FIRES, box: BOX, tileHost: TILE_HOST },
  );
  // Settle: the map tiles loaded, then tile requests quiet for 2 s.
  const settle = async () => {
    for (let round = 0; round < 120; round++) {
      const before = tiles;
      await page.evaluate(() => window.__qaImagery.frames(10));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const loaded = await page.evaluate(() =>
        window.__godsEyeView.engine.surface.tilesLoaded(),
      );
      if (loaded && tiles === before && round >= 4) break;
    }
    await page.evaluate(() => window.__qaImagery.frames(20));
  };
  const read = () =>
    page.evaluate(() => {
      const { engine } = window.__godsEyeView;
      const canvas = engine.host.canvas;
      const scratch = document.createElement('canvas');
      scratch.width = canvas.clientWidth;
      scratch.height = canvas.clientHeight;
      const context = scratch.getContext('2d');
      context.drawImage(canvas, 0, 0, scratch.width, scratch.height);
      return scratch.toDataURL('image/png');
    });
  await settle();
  const without = await read();
  await page.evaluate(() => window.__qaImagery.show());
  await settle();
  const withRaster = await read();
  await page.close();
  return { without, with: withRaster, errors };
}

async function shoot(origin, out) {
  fs.mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 600_000,
    args: ['--use-angle=metal', '--enable-gpu', '--no-sandbox'],
  });
  const engines = (option('engine') ?? 'cesium,navara').split(',');
  const only = option('only')?.split(',') ?? null;
  try {
    for (const kind of engines)
      for (const scene of SCENES) {
        if (only && !only.includes(scene.id)) continue;
        const shot = await shootScene(browser, origin, kind, scene);
        for (const name of ['without', 'with'])
          fs.writeFileSync(
            path.join(out, `${kind}-${scene.id}-${name}.png`),
            Buffer.from(shot[name].split(',')[1], 'base64'),
          );
        console.log(
          `${kind} ${scene.id}: shot${shot.errors.length ? ` (page errors: ${shot.errors.join('; ')})` : ''}`,
        );
      }
  } finally {
    await browser.close();
  }
}

const raw = async (file) =>
  (await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }))
    .data;

// Where the raster changed the frame (any channel by more than 6).
function overlayMask(without, withRaster) {
  const mask = new Uint8Array(without.length / 4);
  for (let p = 0; p < mask.length; p++)
    for (let k = 0; k < 3; k++)
      if (Math.abs(without[p * 4 + k] - withRaster[p * 4 + k]) > 6) {
        mask[p] = 1;
        break;
      }
  return mask;
}

// Per-pixel differences of two frames inside `mask` (or everywhere).
function difference(a, b, mask) {
  let count = 0,
    sum = 0,
    over8 = 0,
    over24 = 0,
    max = 0;
  for (let p = 0; p < a.length / 4; p++) {
    if (mask && !mask[p]) continue;
    let worst = 0;
    for (let k = 0; k < 3; k++)
      worst = Math.max(worst, Math.abs(a[p * 4 + k] - b[p * 4 + k]));
    count++;
    sum += worst;
    if (worst > 8) over8++;
    if (worst > 24) over24++;
    max = Math.max(max, worst);
  }
  return {
    pixels: count,
    meanMaxChannel: count ? +(sum / count).toFixed(2) : 0,
    over8: count ? +((100 * over8) / count).toFixed(2) : 0,
    over24: count ? +((100 * over24) / count).toFixed(2) : 0,
    max,
  };
}

// The raster's own change of the frame: with minus without, per channel.
function contribution(without, withRaster) {
  const out = new Int16Array(without.length);
  for (let i = 0; i < without.length; i++) out[i] = withRaster[i] - without[i];
  return out;
}

async function compare(beforeDir, afterDir) {
  const report = {};
  const engines = ['cesium', 'navara'];
  for (const scene of SCENES) {
    const row = (report[scene.id] = {});
    const loaded = {};
    for (const engine of engines)
      for (const [version, dir] of [
        ['before', beforeDir],
        ['after', afterDir],
      ])
        for (const name of ['without', 'with']) {
          const file = path.join(dir, `${engine}-${scene.id}-${name}.png`);
          if (fs.existsSync(file))
            loaded[`${engine}-${version}-${name}`] = await raw(file);
        }
    for (const engine of engines) {
      const before = loaded[`${engine}-before-with`];
      const after = loaded[`${engine}-after-with`];
      if (!before || !after) continue;
      const mask = overlayMask(loaded[`${engine}-before-without`], before);
      row[`${engine}: before vs after, where the raster draws`] = difference(
        before,
        after,
        mask,
      );
      row[`${engine}: before vs after, whole frame`] = difference(
        before,
        after,
      );
      row[`${engine}: base map before vs after`] = difference(
        loaded[`${engine}-before-without`],
        loaded[`${engine}-after-without`],
      );
    }
    // Navara against Cesium: the raster's change of each frame (the base
    // maps are drawn differently), where Cesium's raster draws.
    const reference = loaded['cesium-after-with'];
    const navara = loaded['navara-after-with'];
    if (reference && navara) {
      const mask = overlayMask(loaded['cesium-after-without'], reference);
      const a = contribution(loaded['cesium-after-without'], reference);
      const b = contribution(loaded['navara-after-without'], navara);
      const shift = (values) =>
        Uint8Array.from(values, (value) =>
          Math.max(0, Math.min(255, value + 128)),
        );
      row['navara vs cesium after: the raster’s change of the frame'] =
        difference(shift(a), shift(b), mask);
      row['navara vs cesium after: frames with the raster'] = difference(
        reference,
        navara,
        mask,
      );
      const beforeReference = loaded['cesium-before-with'];
      const beforeNavara = loaded['navara-before-with'];
      if (beforeReference && beforeNavara)
        row['navara vs cesium before: frames with the raster'] = difference(
          beforeReference,
          beforeNavara,
          overlayMask(loaded['cesium-before-without'], beforeReference),
        );
    }
  }
  return report;
}

if (command === 'shoot' && first) {
  await shoot(first, option('out') ?? 'qa-imagery');
} else if (command === 'compare' && first && second) {
  const report = await compare(first, second);
  const json = option('json');
  if (json) fs.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  for (const [scene, rows] of Object.entries(report)) {
    console.log(scene);
    for (const [label, stats] of Object.entries(rows))
      console.log(
        `  ${label}: ${stats.pixels} px, mean ${stats.meanMaxChannel}, >8 ${stats.over8}%, >24 ${stats.over24}%, max ${stats.max}`,
      );
  }
} else {
  console.error(
    'Usage: node scripts/qa-imagery-compare.mjs shoot <origin> [--out=DIR] [--engine=cesium,navara] [--only=scene,...]\n' +
      '       node scripts/qa-imagery-compare.mjs compare <beforeDir> <afterDir> [--json=FILE]',
  );
  process.exit(2);
}
