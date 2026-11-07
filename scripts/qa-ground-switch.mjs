#!/usr/bin/env node
/**
 * Show and hide of ground fills on Navara before and after an engine switch
 * (Navara → Cesium → Navara, the parked view taken up again): Navara 0.2.1
 * dropped the first `show: false` of a vector layer added right after a
 * switch. For engine.ground's screen pass and the vector-layer prototype
 * (hidden by layer.update with show false, or by deleting its layers): a
 * magenta cell hidden right after its commit must not show, then show, then
 * hide again. The pixels are read from the engine canvas.
 *
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 4271
 *   node scripts/qa-ground-switch.mjs http://localhost:4271
 */
import puppeteer from 'puppeteer';
import { pickEngine, waitForEngine } from './qa-strict-harness.mjs';

const BLOCKED_HOSTS =
  /(^|\.)(googleapis\.com|google\.com|gstatic\.com|cesium\.com)$/;
const origin = process.argv[2];
if (!origin) {
  console.error('Usage: node scripts/qa-ground-switch.mjs <origin>');
  process.exit(2);
}
const APPROACHES = ['pass', 'vector-update', 'vector-delete'];

async function trial(page, approach, round) {
  return page.evaluate(
    async (approach, round) => {
      const { engine } = window.__godsEyeView;
      const geo = await import('/src/geo/index.js');
      const frame = () =>
        new Promise((resolve) => {
          const remove = engine.frames.postRender.addEventListener(() => {
            remove();
            resolve();
          });
          engine.render.request('ground-switch');
        });
      let ground = engine.ground;
      let owner = null;
      if (approach !== 'pass') {
        const { createNavaraVectorGround } =
          await import('/src/globe/navara/ground/vector.js');
        owner = createNavaraVectorGround(engine.extensions.navara.view, {
          hide: approach === 'vector-update' ? 'update' : 'delete',
        });
        ground = owner.ground;
      }
      const lon = 20 + round * 1.5 + APPROACH_INDEX[approach] * 0.5;
      const spot = engine.projector.worldToWindow(
        geo.cartesian3.fromDegrees(lon + 0.15, 10),
      );
      const magenta = () => {
        const canvas = engine.host.canvas;
        const copy = document.createElement('canvas');
        copy.width = 16;
        copy.height = 16;
        const context = copy.getContext('2d');
        const scale = canvas.width / canvas.clientWidth;
        context.drawImage(
          canvas,
          (spot.x - 8) * scale,
          (spot.y - 8) * scale,
          16 * scale,
          16 * scale,
          0,
          0,
          16,
          16,
        );
        const data = context.getImageData(0, 0, 16, 16).data;
        let lit = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            data[i] > 150 &&
            data[i + 2] > 150 &&
            data[i + 1] < Math.min(data[i], data[i + 2]) - 60
          )
            lit++;
        return lit / 256;
      };
      // Frames until `want` (shown or not) holds, up to 4 s.
      const until = async (want) => {
        const started = performance.now();
        while (performance.now() - started < 4000) {
          await frame();
          if (magenta() > 0.5 === want) return true;
        }
        return false;
      };
      const set = ground.createSet({
        id: `switch-${approach}-${round}`,
        kind: 'cell',
      });
      set.replace([
        {
          west: lon,
          south: 9.85,
          east: lon + 0.3,
          north: 10.15,
          fill: [1, 0, 1, 1],
        },
      ]);
      set.commit();
      set.show(false);
      // Hidden right after the commit: never drawn.
      let drawnWhileHidden = false;
      for (let index = 0; index < 90; index++) {
        await frame();
        if (magenta() > 0.5) drawnWhileHidden = true;
      }
      set.show(true);
      const shows = await until(true);
      set.show(false);
      const hides = await until(false);
      set.destroy();
      owner?.destroy();
      return { hiddenAfterCommit: !drawnWhileHidden, shows, hides };
    },
    approach,
    round,
  );
}

const browser = await puppeteer.launch({ headless: true });
let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (error) => console.log('  page error:', error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (BLOCKED_HOSTS.test(new URL(request.url()).hostname)) request.abort();
    else request.continue();
  });
  await page.evaluateOnNewDocument((approaches) => {
    window.APPROACH_INDEX = Object.fromEntries(
      approaches.map((name, index) => [name, index]),
    );
  }, APPROACHES);
  await page.goto(
    `${origin}/?welcome=0&engine=navara#v=2&lat=10&lon=21&alt=900000&heading=0&pitch=-90&map=osm&l=`,
  );
  await waitForEngine(page, 'navara', { timeout: 300_000 });
  await page.evaluate(async () => {
    const { appClock } = await import('/src/time/clock.js');
    appClock.freeze(Date.UTC(2026, 10, 7, 11, 0));
  });
  const report = (label, result) => {
    const ok = result.hiddenAfterCommit && result.shows && result.hides;
    if (!ok) failed = true;
    console.log(
      `  ${label}: hidden right after commit ${result.hiddenAfterCommit ? 'yes' : 'NO'}, shows ${result.shows ? 'yes' : 'NO'}, hides again ${result.hides ? 'yes' : 'NO'}`,
    );
  };
  console.log('before a switch:');
  for (const approach of APPROACHES)
    report(approach, await trial(page, approach, 0));
  await pickEngine(page, 'cesium');
  await waitForEngine(page, 'cesium', { timeout: 300_000 });
  await pickEngine(page, 'navara');
  await waitForEngine(page, 'navara', { timeout: 300_000 });
  await page.evaluate(async () => {
    const geo = await import('/src/geo/index.js');
    window.__godsEyeView.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(21, 10, 900000),
    });
  });
  console.log('after Navara → Cesium → Navara:');
  for (const approach of APPROACHES)
    report(approach, await trial(page, approach, 1));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
