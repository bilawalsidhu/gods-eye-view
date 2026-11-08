#!/usr/bin/env node
/**
 * render.mjs — deterministic frame capture for the Cosmos 2612 / ICEYE-X36 replay.
 *
 *   node tools/rpo-replay/render.mjs --format 16x9 --stills 2,9,24,32
 *   node tools/rpo-replay/render.mjs --format 9x16 --from 0 --to 675
 *   node tools/rpo-replay/render.mjs --format 16x9 --encode
 *
 * Frames are written to output/rpo-replay/<format>/frames/NNNNN.jpg; existing
 * frames are skipped, so interrupted renders resume. --encode muxes them to MP4.
 * Uses Playwright's Chromium with SwiftShader (no GPU needed).
 */
import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = process.env.GEV_PROJECT_ROOT || join(HERE, '../..');
const CESIUM = join(ROOT, 'node_modules/cesium/Build/Cesium');
const SKY = join(ROOT, 'src/data/local_data/sky');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const FORMATS = { '16x9': [1920, 1080], '9x16': [1080, 1920], preview: [960, 540], 'preview-v': [540, 960] };
const format = args.format || '16x9';
const [W, H] = FORMATS[format];
const FPS = Number(args.fps || 30);
const TAG = args.tag ? String(args.tag) : '';
const RS = Number(args.rs || 1);
const outDir = join(ROOT, 'output/rpo-replay', TAG, format);
const frameDir = join(outDir, 'frames');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.xml': 'application/xml', '.ktx2': 'image/ktx2', '.webp': 'image/webp',
};

function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    const file = p.startsWith('/cesium/')
      ? join(CESIUM, normalize(p.slice('/cesium/'.length)))
      : p.startsWith('/sky/')
        ? join(SKY, normalize(p.slice('/sky/'.length)))
        : join(HERE, normalize(p === '/' ? 'scene.html' : p.slice(1)));
    if (!file.startsWith(CESIUM) && !file.startsWith(SKY) && !file.startsWith(HERE)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function encode() {
  const out = join(outDir, `cosmos2612-iceye-x36-${TAG ? TAG + '-' : ''}${format}.mp4`);
  const r = spawnSync('ffmpeg', [
    '-y', '-framerate', String(FPS), '-i', join(frameDir, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-vf', 'format=yuv420p', out,
  ], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(out);
}

if (args.encode) {
  encode();
  process.exit(0);
}

const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/scene.html?w=${W}&h=${H}&rs=${RS}&settle=${args.stills ? 60 : Number(args.settle || 4)}&fps=${FPS}`);
await page.waitForFunction(() => window.rpo?.ready, null, { timeout: 180000 });
const total = Math.round((await page.evaluate(() => window.rpo.duration)) * FPS);

if (args.stills) {
  const dir = join(outDir, 'stills');
  await mkdir(dir, { recursive: true });
  for (const s of String(args.stills).split(',').map(Number)) {
    const t0 = Date.now();
    const info = await page.evaluate((x) => window.rpo.frame(x), s);
    await page.screenshot({ path: join(dir, `s${s.toFixed(2).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
    console.log(`still ${s}s  sep=${(info.sep / 1000).toFixed(3)} km  mag=${info.mag.toFixed(1)}  ${Date.now() - t0} ms`);
  }
} else {
  await mkdir(frameDir, { recursive: true });
  const from = Number(args.from || 0);
  const to = Math.min(Number(args.to || total), total);
  const t0 = Date.now();
  let done = 0;
  for (let f = from; f < to; f++) {
    const path = join(frameDir, `${String(f).padStart(5, '0')}.jpg`);
    if (await exists(path)) continue;
    const tf = Date.now();
    await page.evaluate((x) => window.rpo.frame(x), f / FPS);
    await page.screenshot({ path, type: 'jpeg', quality: 94 });
    done++;
      if (args.profile) console.log(`frame ${f} ${(Date.now() - tf) / 1000}s`);
    if (done % 25 === 0) {
      const per = (Date.now() - t0) / done;
      console.log(`${format} frame ${f}/${to}  ${(per / 1000).toFixed(2)} s/frame  eta ${(((to - f) * per) / 60000).toFixed(1)} min`);
    }
  }
}
await browser.close();
server.close();
