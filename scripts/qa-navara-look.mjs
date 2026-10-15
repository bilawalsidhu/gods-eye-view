#!/usr/bin/env node
/**
 * The Navara look gallery: each scene photographed on Cesium, on Navara's
 * `photoreal` look and on its `cinematic` look (the app's default), at the
 * same pose and the same sun, then composed side by side into one JPEG per
 * scene (docs/migration/navara-look/<scene>.jpg, each under 500 KB).
 *
 *   node scripts/qa-navara-look.mjs [--scene=name,...] [--base-url=URL]
 *     [--out=DIR]
 *
 * Starts this checkout's Vite dev server on a free port (never 4185 or 4186)
 * unless --base-url names a running server. Headless Chrome with
 * --use-angle=metal, never a visible window. The page's clock is shifted to
 * each scene's UTC time (Date only; performance.now is untouched), so the
 * sun, the HUD and Navara's atmosphere agree. Each capture is the engine's
 * own canvas (no HTML chrome): the camera is set once the boot flight has
 * ended, the tiles load and stay loaded for 2.5 s, then 1.5 s of continuous
 * rendering lets temporal effects (clouds) converge. Provider keys are never
 * printed. Exits 1 when a capture fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

/** Poses in degrees and metres; `utc` sets the sun. */
const SCENES = {
  manhattan: {
    title: 'Lower Manhattan, 900 m, 12:00 EDT',
    pose: { lat: 40.706, lon: -74.013, height: 900, heading: 30, pitch: -25 },
    utc: '2026-10-15T16:00:00Z',
  },
  austin: {
    title: 'Austin, the startup view (600 m), 13:00 CDT',
    pose: { lat: 30.2672, lon: -97.7431, height: 600, heading: 15, pitch: -30 },
    utc: '2026-10-15T18:00:00Z',
  },
  coast: {
    title: 'Rio de Janeiro, Sugarloaf and the bay, 1,200 m, 12:00 BRT',
    pose: { lat: -22.985, lon: -43.18, height: 1200, heading: 25, pitch: -12 },
    utc: '2026-10-15T15:00:00Z',
  },
  mountains: {
    title: 'Grand Canyon from the South Rim, 3,000 m, 12:00 MST',
    pose: { lat: 36.04, lon: -112.12, height: 3000, heading: 340, pitch: -14 },
    utc: '2026-10-15T19:00:00Z',
  },
  globe: {
    title: 'The globe from 8,000 km, 18:00 UTC (sunset over West Africa)',
    pose: { lat: 15, lon: -40, height: 8000000, heading: 0, pitch: -90 },
    utc: '2026-10-15T18:00:00Z',
  },
  'golden-hour': {
    title: 'San Francisco at golden hour, 700 m, 18:05 PDT',
    pose: { lat: 37.8, lon: -122.36, height: 700, heading: 250, pitch: -10 },
    utc: '2026-10-16T01:05:00Z',
  },
  dusk: {
    title: 'Manhattan at dusk, 900 m, 18:25 EDT (sun just below the horizon)',
    pose: { lat: 40.72, lon: -73.99, height: 900, heading: 255, pitch: -10 },
    utc: '2026-10-15T22:25:00Z',
  },
};
const VARIANTS = [
  { label: 'Cesium', query: '?engine=cesium' },
  { label: 'Navara photoreal', query: '?engine=navara&look=photoreal' },
  { label: 'Navara cinematic (default)', query: '?engine=navara' },
];
const SHOT = { width: 1280, height: 800 };
const TILE = { width: 640, height: 400 };
const MAX_BYTES = 500 * 1024;
const RESERVED_PORTS = new Set([4185, 4186]);

const sceneNames = (argument('scene') ?? Object.keys(SCENES).join(','))
  .split(',')
  .filter(Boolean);
for (const name of sceneNames) {
  if (!SCENES[name]) {
    console.error(
      `Unknown scene "${name}"; known: ${Object.keys(SCENES).join(', ')}`,
    );
    process.exit(2);
  }
}
const outDir = path.resolve(
  repoRoot,
  argument('out') ?? 'docs/migration/navara-look',
);

const redact = (text) =>
  String(text)
    .replace(/([?&](?:key|token|access_token|apiKey)=)[^&\s"')]+/gi, '$1…')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…')
    .replace(/eyJ[0-9A-Za-z_.-]{20,}/g, 'eyJ…');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() =>
        RESERVED_PORTS.has(port) ? resolve(freePort()) : resolve(port),
      );
    });
  });
}

async function startServer() {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules/vite/bin/vite.js'),
      '--port',
      String(port),
      '--strictPort',
      '--host',
      'localhost',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const url = `http://localhost:${port}/`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      if ((await fetch(url)).ok) return { url, stop: () => child.kill() };
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`dev server did not answer ${url}\n${redact(stderr)}`);
}

// --- In-page --------------------------------------------------------------

/** Installed before the app loads: Date runs from `utc` on. */
function shiftClock(utc) {
  try {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
  } catch {
    /* storage blocked */
  }
  const offset = Date.parse(utc) - Date.now();
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}

/** Waits out the boot flight, sets the pose, waits for its tiles, converges. */
async function settleAt(pose) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { engine } = window.__godsEyeView;
  const still = async (ms, limit) => {
    const start = performance.now();
    let last = null;
    let since = performance.now();
    while (performance.now() - start < limit) {
      await sleep(100);
      const { position } = engine.camera.pose();
      const read = [position.x, position.y, position.z];
      if (!last || read.some((value, i) => Math.abs(value - last[i]) > 1e-3))
        since = performance.now();
      last = read;
      if (performance.now() - since >= ms) return;
    }
  };
  await still(1500, 20000);
  const a = 6378137;
  const e2 = 0.0066943799901413165;
  const phi = (pose.lat * Math.PI) / 180;
  const lambda = (pose.lon * Math.PI) / 180;
  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  engine.camera.setView({
    destination: {
      x: (n + pose.height) * Math.cos(phi) * Math.cos(lambda),
      y: (n + pose.height) * Math.cos(phi) * Math.sin(lambda),
      z: (n * (1 - e2) + pose.height) * Math.sin(phi),
    },
    orientation: {
      heading: (pose.heading * Math.PI) / 180,
      pitch: (pose.pitch * Math.PI) / 180,
      roll: 0,
    },
  });
  engine.render.request('navara-look-gallery');
  const start = performance.now();
  let loadedSince = null;
  while (performance.now() - start < 90000) {
    await sleep(200);
    if (!engine.surface.tilesLoaded()) loadedSince = null;
    else if (loadedSince == null) loadedSince = performance.now();
    else if (performance.now() - loadedSince >= 2500) break;
  }
  engine.render.setContinuous(true);
  await sleep(1500);
  engine.render.setContinuous(false);
  engine.render.request('navara-look-gallery');
  await sleep(500);
  const canvas = [...document.querySelectorAll('#cesiumContainer canvas')].sort(
    (x, y) => y.width * y.height - x.width * x.height,
  )[0];
  return canvas.toDataURL('image/png');
}

/** Draws the captures side by side with labels; returns JPEG bytes (base64). */
async function compose({ images, labels, title, tile, maxBytes }) {
  const header = 34;
  const caption = 30;
  const canvas = document.createElement('canvas');
  canvas.width = tile.width * images.length;
  canvas.height = header + tile.height + caption;
  const context = canvas.getContext('2d');
  context.fillStyle = '#101214';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '600 17px -apple-system, Helvetica, Arial, sans-serif';
  context.textBaseline = 'middle';
  for (const [index, source] of images.entries()) {
    const image = new Image();
    image.src = source;
    await image.decode();
    const x = index * tile.width;
    context.drawImage(image, x, header, tile.width, tile.height);
    context.fillStyle = '#e8eaed';
    context.fillText(labels[index], x + 12, header / 2);
  }
  context.fillStyle = '#9aa0a6';
  context.font = '15px -apple-system, Helvetica, Arial, sans-serif';
  context.fillText(title, 12, header + tile.height + caption / 2);
  for (let quality = 0.88; quality >= 0.5; quality -= 0.04) {
    const data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if ((data.length * 3) / 4 <= maxBytes) return data;
  }
  throw new Error('the gallery does not fit the size budget');
}

// --- Runner -----------------------------------------------------------------

const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (await puppeteer.executablePath().catch(() => null));
if (!executablePath || !fs.existsSync(executablePath))
  throw new Error('Puppeteer Chrome for Testing is unavailable');

const server = argument('base-url')
  ? { url: argument('base-url'), stop: () => {} }
  : await startServer();
const baseUrl = server.url.endsWith('/') ? server.url : `${server.url}/`;
const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: [
    '--use-angle=metal',
    `--window-size=${SHOT.width},${SHOT.height}`,
  ],
});

async function capture(scene, variant) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport(SHOT);
    const errors = [];
    page.on('pageerror', (error) =>
      errors.push(redact(error.message).slice(0, 200)),
    );
    await page.evaluateOnNewDocument(shiftClock, scene.utc);
    await page.goto(`${baseUrl}${variant.query}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => Boolean(window.__godsEyeView?.engine), {
      timeout: 180000,
      polling: 250,
    });
    const image = await page.evaluate(settleAt, scene.pose);
    if (errors.length) throw new Error(errors.join('; '));
    return image;
  } finally {
    await context.close();
  }
}

let failed = 0;
try {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of sceneNames) {
    const scene = SCENES[name];
    try {
      const images = [];
      for (const variant of VARIANTS)
        images.push(await capture(scene, variant));
      const page = await browser.newPage();
      const jpeg = await page.evaluate(compose, {
        images,
        labels: VARIANTS.map((variant) => variant.label),
        title: scene.title,
        tile: TILE,
        maxBytes: MAX_BYTES,
      });
      await page.close();
      const file = path.join(outDir, `${name}.jpg`);
      fs.writeFileSync(file, Buffer.from(jpeg, 'base64'));
      console.log(
        `ok   ${name}: ${path.relative(repoRoot, file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`,
      );
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}: ${redact(error.stack || error.message)}`);
    }
  }
} finally {
  await browser.close();
  server.stop();
}
process.exit(failed ? 1 : 0);
