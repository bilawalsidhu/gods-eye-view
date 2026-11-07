#!/usr/bin/env node
/**
 * Draw the rasters that moved to engine.imagery's tile schemes, staged
 * sources and raised layers — the rain radar, lightning density, regional
 * and global satellite clouds, the wind field and the Bhote Koshi
 * before/after split — on both real engines, read the canvas back, and
 * compare two runs pixel by pixel (before and after a change), and the two
 * engines against each other. Run it against a keyless dev server of each
 * version, then compare:
 *
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 4291
 *   node scripts/qa-weather-compare.mjs shoot http://localhost:4291 --out=DIR
 *   node scripts/qa-weather-compare.mjs compare BEFORE_DIR AFTER_DIR
 *
 * The page must serve `/qa-cesium.js` (`export * from 'cesium';` at the
 * root of the served copy): older versions build their Cesium renderers
 * from the SDK. Every scene freezes the app clock at local noon and waits
 * for the map tiles. The weather tiles and images are generated here
 * (intercepted /api/weather/tile and /api/weather/image) from one field of
 * longitude and latitude, so a tile and a whole-extent image of the same
 * place agree; the wind is a fixed field, paused. Each scene is shot with
 * and without the raster: `overlay` is where the raster changed the frame.
 * Google and Cesium ion are blocked, so no engine draws photoreal tiles.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const BLOCKED_HOSTS =
  /(^|\.)(googleapis\.com|google\.com|gstatic\.com|cesium\.com)$/;
const args = process.argv.slice(2);
const [command, first, second] = args.filter((arg) => !arg.startsWith('--'));
const option = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const SIZE = { width: 1280, height: 800 };
const TIME = '2026-11-07T12:00:00.000Z';
const US = { west: -130, south: 20, east: -60, north: 55 };
const GLOBE = { west: -180, south: -90, east: 180, north: 90 };
const NEPAL = { west: 85.295, south: 28.135, east: 85.379, north: 28.292 };

const SCENES = [
  {
    id: 'radar',
    kind: 'weather',
    product: 'radar',
    bounds: US,
    alpha: 0.8,
    view: { lon: -95, lat: 37.5, height: 6_000_000 },
    noonUtc: 18,
  },
  {
    id: 'lightning',
    kind: 'weather',
    product: 'lightning',
    bounds: US,
    alpha: 0.8,
    view: { lon: -95, lat: 37.5, height: 6_000_000 },
    noonUtc: 18,
  },
  {
    id: 'clouds-regional',
    kind: 'weather',
    product: 'clouds-regional',
    bounds: US,
    alpha: 0.7,
    view: { lon: -95, lat: 37.5, height: 6_000_000 },
    noonUtc: 18,
  },
  {
    id: 'clouds-global',
    kind: 'weather',
    product: 'clouds',
    bounds: GLOBE,
    alpha: 0.7,
    view: { lon: -40, lat: 15, height: 14_000_000 },
    noonUtc: 14.5,
  },
  {
    id: 'wind',
    kind: 'wind',
    view: { lon: -40, lat: 20, height: 12_000_000 },
    noonUtc: 14.5,
  },
  {
    id: 'nepal-split',
    kind: 'nepal',
    view: { lon: 85.337, lat: 28.2135, height: 22_000 },
    noonUtc: 6.5,
  },
];

// The weather field at a longitude and latitude: blobs with soft edges
// (radar, lightning) or a grey sky to mask (the infrared products).
function weatherPixel(product, lon, lat, out, at) {
  const v =
    0.5 + 0.25 * Math.sin(lon * 0.35) + 0.25 * Math.cos(lat * 0.5 + lon * 0.1);
  if (product === 'clouds' || product === 'clouds-regional') {
    const grey = Math.round(255 * Math.max(0, Math.min(1, v)));
    out[at] = out[at + 1] = out[at + 2] = grey;
    out[at + 3] = 255;
    return;
  }
  out[at] = Math.round(255 * Math.max(0, Math.min(1, v)));
  out[at + 1] = Math.round(255 * Math.max(0, Math.min(1, 1 - v)));
  out[at + 2] = product === 'lightning' ? 220 : 90;
  out[at + 3] = Math.round(255 * Math.max(0, Math.min(1, (v - 0.45) * 4)));
}

async function weatherPng(product, box, width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const lat = box.north - ((row + 0.5) / height) * (box.north - box.south);
    for (let column = 0; column < width; column++) {
      const lon = box.west + ((column + 0.5) / width) * (box.east - box.west);
      weatherPixel(product, lon, lat, data, (row * width + column) * 4);
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

const LARGEST = {
  radar: [4096, 2048],
  lightning: [4096, 2048],
  'clouds-regional': [4096, 2048],
  clouds: [2048, 1024],
};
const pngCache = new Map();
// One generated /api/weather/tile or /api/weather/image response, or null.
async function weatherResponse(url) {
  const key = url.pathname + url.search;
  if (pngCache.has(key)) return pngCache.get(key);
  const query = url.searchParams;
  const product = query.get('product');
  const scene = SCENES.find((entry) => entry.product === product);
  if (!scene) return null;
  let png;
  if (url.pathname === '/api/weather/tile') {
    const z = +query.get('z');
    const x = +query.get('x');
    const y = +query.get('y');
    const span = 180 / 2 ** z;
    const size = +(query.get('size') ?? 256);
    png = await weatherPng(
      product,
      {
        west: -180 + x * span,
        east: -180 + (x + 1) * span,
        north: 90 - y * span,
        south: 90 - (y + 1) * span,
      },
      size,
      size,
    );
  } else {
    const bbox = query.get('bbox');
    const [west, south, east, north] = bbox
      ? bbox.split(',').map(Number)
      : [
          scene.bounds.west,
          scene.bounds.south,
          scene.bounds.east,
          scene.bounds.north,
        ];
    const [width, height] = query.get('size')
      ? query.get('size').split('x').map(Number)
      : bbox
        ? [4096, 2048]
        : LARGEST[product];
    png = await weatherPng(
      product,
      { west, south, east, north },
      width,
      height,
    );
  }
  pngCache.set(key, png);
  return png;
}

// A fixed 5° wind field: westerlies, trades and a jet.
function windSnapshot() {
  const nx = 72;
  const ny = 37;
  const u = new Float32Array(nx * ny);
  const v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = 90 - j * 5;
    for (let i = 0; i < nx; i++) {
      const lon = i * 5;
      u[j * nx + i] =
        14 * Math.cos((lat * Math.PI) / 60) +
        6 * Math.sin((lon * Math.PI) / 45);
      v[j * nx + i] = 5 * Math.sin(((lon + lat) * Math.PI) / 50);
    }
  }
  return {
    model: 'gfs',
    level: '10m',
    units: 'm/s',
    cycle: { runIso: TIME, validIso: TIME, forecastHour: 0 },
    grid: { nx, ny, lo1: 0, la1: 90, dx: 5, dy: 5 },
    u: Array.from(u),
    v: Array.from(v),
  };
}

async function shootScene(browser, origin, kind, scene) {
  const page = await browser.newPage();
  await page.setViewport(SIZE);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  let requests = 0;
  page.on('request', async (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/weather/')) {
      requests++;
      const png = await weatherResponse(url).catch(() => null);
      if (png)
        await request.respond({
          status: 200,
          contentType: 'image/png',
          body: png,
        });
      else await request.respond({ status: 404, body: '' });
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
  const version = await page.evaluate(
    async ({ scene, time, wind }) => {
      const { engine } = window.__godsEyeView;
      const geo = await import('/src/geo/index.js');
      const { appClock } = await import('/src/time/clock.js');
      appClock.freeze(Date.UTC(2026, 10, 7) + scene.noonUtc * 3_600_000);
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(
          scene.view.lon,
          scene.view.lat,
          scene.view.height,
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const frames = (count) =>
        new Promise((resolve) => {
          let left = count;
          const remove = engine.frames.postRender.addEventListener(() => {
            if (--left > 0) {
              setTimeout(() => engine.render.request('qa-weather'), 0);
              return;
            }
            remove();
            resolve();
          });
          engine.render.request('qa-weather');
        });
      const tryImport = async (url) => {
        try {
          return await import(url);
        } catch {
          return null;
        }
      };
      const viewer = engine.extensions?.cesium?.viewer ?? null;
      const native = engine.extensions?.navara ?? null;
      const cesium = viewer ? await import('/qa-cesium.js') : null;
      const qa = { frames };
      window.__qaWeather = qa;
      if (scene.kind === 'weather') {
        const snapshot = {
          schemaVersion: 1,
          product: scene.product,
          bounds: scene.bounds,
          times: [time],
          latest: time,
          tileSize: 256,
          maxLevel: 6,
          tilingScheme: 'geographic',
        };
        const display = await tryImport(
          '/src/layers/weather/render/display.js',
        );
        let renderer;
        let used;
        if (display) {
          renderer = display.createWeatherDisplay(engine, {});
          used = 'display';
        } else if (viewer) {
          const { createWeatherRendering } =
            await import('/src/layers/weather/rendering.js');
          renderer = createWeatherRendering({
            viewer,
            cesium,
            getHost: () => ({
              collection: viewer.imageryLayers,
              kind: 'globe',
            }),
          });
          used = 'cesium';
        } else {
          const { createWeatherNavaraRenderer } =
            await import('/src/layers/weather/render/navara.js');
          renderer = createWeatherNavaraRenderer(engine, native, {
            getHost: () => ({ kind: 'globe', collection: engine }),
          });
          used = 'navara';
        }
        renderer.setAlpha(scene.alpha);
        qa.show = () =>
          renderer.setFrame(snapshot, time, {
            infrared: scene.product.startsWith('clouds') ? 100 : 'filtered',
          });
        qa.state = () => renderer.getDiagnostics();
        return used;
      }
      if (scene.kind === 'wind') {
        const display = await tryImport('/src/layers/wind/render/display.js');
        const { createWindRendering } =
          await import('/src/layers/wind/rendering.js');
        const cesiumFlow = (options = {}) =>
          createWindRendering({
            cesium,
            container: viewer.container,
            getViewer: () => viewer,
            getHost: () => ({
              collection: viewer.imageryLayers,
              kind: 'globe',
            }),
            ...options,
          });
        let renderer;
        let used;
        if (display) {
          const navaraFlow = native
            ? (
                (await tryImport('/src/globe/navara/windFlow.js')) ??
                (await import('/src/layers/wind/render/navaraFlow.js'))
              ).createWindNavaraFlow
            : null;
          const createWindFlowMesh = native
            ? (await import('/src/globe/navara/windFlowMesh.js'))
                .createWindFlowMesh
            : null;
          renderer = display.createWindDisplay(engine, {
            flow: viewer
              ? () => cesiumFlow({ field: false })
              : (e) => navaraFlow(e, native, createWindFlowMesh),
          });
          used = 'display';
        } else if (viewer) {
          renderer = cesiumFlow();
          used = 'cesium';
        } else {
          const { createWindNavaraRenderer } =
            await import('/src/layers/wind/render/navara.js');
          renderer = createWindNavaraRenderer(engine, native);
          used = 'navara';
        }
        renderer.attach();
        renderer.setOptions({ overlay: 'none', paused: true });
        renderer.setField(wind);
        renderer.start();
        qa.show = () => renderer.setOptions({ overlay: 'speed', paused: true });
        qa.state = () => renderer.getDiagnostics();
        return used;
      }
      // The Bhote Koshi before and after images, split at the middle.
      const box = {
        west: 85.295,
        south: 28.135,
        east: 85.379,
        north: 28.292,
      };
      const urls = [
        '/events/bhote-koshi-2026/pre.webp',
        '/events/bhote-koshi-2026/post.webp',
      ].map((url) => new URL(url, location.href).href);
      const display = await tryImport(
        '/src/layers/bhoteKoshi/render/display.js',
      );
      if (display) {
        const renderer = display.createBhoteKoshiDisplay(engine);
        qa.show = async () => {
          await renderer.loadImages(box, urls);
          renderer.setSplit(0.5);
        };
        return 'display';
      }
      const Cesium = cesium ?? (await import('/qa-cesium.js'));
      const rectangle = Cesium.Rectangle.fromDegrees(
        box.west,
        box.south,
        box.east,
        box.north,
      );
      if (viewer) {
        qa.show = async () => {
          const providers = await Promise.all(
            urls.map((url) =>
              Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle }),
            ),
          );
          providers.forEach((provider, index) => {
            const layer = viewer.imageryLayers.addImageryProvider(provider);
            layer.splitDirection = index
              ? Cesium.SplitDirection.RIGHT
              : Cesium.SplitDirection.LEFT;
            layer.alpha = 0.96;
          });
          viewer.scene.splitPosition = 0.5;
        };
        return 'cesium';
      }
      const { createNepalEventDisplay } =
        await import('/src/layers/bhoteKoshi/render/navara.js');
      const renderer = createNepalEventDisplay(engine, native);
      qa.show = async () => {
        const providers = await Promise.all(
          urls.map((url) =>
            Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle }),
          ),
        );
        await renderer.loadImages(box, providers);
        renderer.setSplit(0.5);
      };
      return 'navara';
    },
    { scene, time: TIME, wind: windSnapshot() },
  );
  // Settle: the map tiles loaded, then requests quiet for 2 s.
  const settle = async () => {
    for (let round = 0; round < 120; round++) {
      const before = requests;
      await page.evaluate(() => window.__qaWeather.frames(10));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const loaded = await page.evaluate(() =>
        window.__godsEyeView.engine.surface.tilesLoaded(),
      );
      if (loaded && requests === before && round >= 4) break;
    }
    await page.evaluate(() => window.__qaWeather.frames(20));
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
  const shown = await page.evaluate(async () => {
    const result = await window.__qaWeather.show();
    return result === undefined ? null : result;
  });
  await settle();
  const withRaster = await read();
  const state = await page.evaluate(() => {
    try {
      return JSON.parse(JSON.stringify(window.__qaWeather.state?.() ?? null));
    } catch {
      return null;
    }
  });
  await page.close();
  return { without, with: withRaster, errors, version, shown, state };
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
          `${kind} ${scene.id}: ${shot.version}, shown ${JSON.stringify(shot.shown)}, error ${shot.state?.error ?? shot.state?.imageryError ?? null}${shot.errors.length ? ` (page errors: ${shot.errors.join('; ')})` : ''}`,
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
const shift = (values) =>
  Uint8Array.from(values, (value) => Math.max(0, Math.min(255, value + 128)));

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
      // The raster's own change, before and after: the base map drawn
      // differently between runs (tiles, lighting) cancels out.
      row[`${engine}: the raster's change, before vs after`] = difference(
        shift(contribution(loaded[`${engine}-before-without`], before)),
        shift(contribution(loaded[`${engine}-after-without`], after)),
        mask,
      );
      row[`${engine}: base map before vs after`] = difference(
        loaded[`${engine}-before-without`],
        loaded[`${engine}-after-without`],
      );
    }
    // Navara against Cesium, where Cesium's raster draws: each engine's
    // change of its own frame (the base maps are drawn differently).
    for (const version of ['before', 'after']) {
      const reference = loaded[`cesium-${version}-with`];
      const navara = loaded[`navara-${version}-with`];
      if (!reference || !navara) continue;
      const mask = overlayMask(loaded[`cesium-${version}-without`], reference);
      row[`navara vs cesium ${version}: the raster's change`] = difference(
        shift(contribution(loaded[`cesium-${version}-without`], reference)),
        shift(contribution(loaded[`navara-${version}-without`], navara)),
        mask,
      );
    }
  }
  return report;
}

if (command === 'shoot' && first) {
  await shoot(first, option('out') ?? 'qa-weather');
} else if (command === 'compare' && first && second) {
  const report = await compare(first, second);
  const json = option('json');
  if (json) fs.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  for (const [scene, rows] of Object.entries(report)) {
    console.log(scene);
    for (const [label, value] of Object.entries(rows))
      console.log(
        `  ${label}: ${value.pixels} px, mean ${value.meanMaxChannel}, >8 ${value.over8}%, >24 ${value.over24}%, max ${value.max}`,
      );
  }
} else {
  console.error(
    'Usage: node scripts/qa-weather-compare.mjs shoot <origin> [--out=DIR] [--engine=cesium,navara] [--only=scene,...]\n' +
      '       node scripts/qa-weather-compare.mjs compare <before> <after> [--json=FILE]',
  );
  process.exit(2);
}
