#!/usr/bin/env node
/**
 * A map-stack switch at the whole-globe view draws the new picture by
 * itself, on both engines (headless Chrome, the app): the camera parks
 * 18 000 km up, the stack switches (cycling photoreal / Esri / OSM), and
 * once the engine reports its tiles loaded for 1 s the picture is hashed;
 * then frames are forced and it is hashed again. A different hash means
 * the engine had stopped drawing with a stale picture (it showed the new
 * map only when something else asked for a frame). Also reports how long
 * after the switch the picture last changed.
 *
 *   node scripts/qa-map-switch.mjs --base-url=http://localhost:PORT/
 *     [--engine=cesium|navara|both] [--switches=6]
 *
 * The server is the caller's (never ports 4185-4189). Headless only. Exits
 * 1 on a stale picture.
 */
import puppeteer from 'puppeteer';

const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const RESERVED_PORTS = new Set([4185, 4186, 4187, 4188, 4189]);
const baseUrl = argument('base-url');
if (!baseUrl || RESERVED_PORTS.has(Number(new URL(baseUrl).port))) {
  console.error(
    '--base-url=http://localhost:PORT/ (not 4185-4189) is required',
  );
  process.exit(2);
}
const engineArg = argument('engine') ?? 'both';
const engines = engineArg === 'both' ? ['cesium', 'navara'] : [engineArg];
const SWITCHES = Number(argument('switches') ?? 6);

let failures = 0;
const browser = await puppeteer.launch({ headless: true });
try {
  for (const engine of engines) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
      } catch {
        /* storage blocked */
      }
    });
    const url = new URL(baseUrl);
    url.searchParams.set('engine', engine);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
      timeout: 180_000,
      polling: 250,
    });
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const runs = await page.evaluate(async (switches) => {
      const geo = await import('/src/geo/index.js');
      const { engine, mapStackController: stacks } = window.__godsEyeView;
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(-40, 20, 18_000_000),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const small = document.createElement('canvas');
      small.width = 64;
      small.height = 40;
      const context = small.getContext('2d', { willReadFrequently: true });
      // The drawn picture, reduced (Navara and the app's Cesium keep their
      // drawing buffer).
      const hash = () => {
        context.drawImage(engine.host.canvas, 0, 0, 64, 40);
        const data = context.getImageData(0, 0, 64, 40).data;
        let value = 0;
        for (let i = 0; i < data.length; i += 4)
          value =
            (value * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) >>> 0;
        return value;
      };
      // Tiles loaded continuously for 1 s (bounded).
      const settle = async (maxMs) => {
        const started = performance.now();
        let since = null;
        while (performance.now() - started < maxMs) {
          await sleep(100);
          if (!engine.surface.tilesLoaded()) since = null;
          else if (since === null) since = performance.now();
          else if (performance.now() - since >= 1000) return true;
        }
        return false;
      };
      await settle(20_000);
      const ids = stacks
        .getStacks()
        .filter(({ available }) => available)
        .map(({ id }) => id);
      const results = [];
      for (let index = 0; index < switches; index++) {
        const to = ids[(ids.indexOf(stacks.getActiveId()) + 1) % ids.length];
        const started = performance.now();
        let last = hash();
        let lastChangeMs = 0;
        const watch = setInterval(() => {
          const now = hash();
          if (now !== last) {
            last = now;
            lastChangeMs = Math.round(performance.now() - started);
          }
        }, 100);
        await stacks.setStack(to);
        const settled = await settle(20_000);
        await sleep(1000);
        clearInterval(watch);
        const drawn = hash();
        for (let frame = 0; frame < 6; frame++) {
          engine.render.request('qa-map-switch');
          await sleep(150);
        }
        const forced = hash();
        results.push({
          to,
          settled,
          lastChangeMs,
          stale: drawn !== forced,
        });
      }
      return results;
    }, SWITCHES);
    const stale = runs.filter(({ stale }) => stale).length;
    failures += stale;
    for (const run of runs)
      console.log(
        `[map-switch] ${engine} → ${run.to}: picture last changed ${run.lastChangeMs} ms after the switch${run.settled ? '' : ' (tiles never settled)'}${run.stale ? '; STALE: forced frames changed it' : ''}`,
      );
    console.log(
      `[map-switch] ${engine}: ${runs.length - stale}/${runs.length} switches drew the new picture by themselves`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
