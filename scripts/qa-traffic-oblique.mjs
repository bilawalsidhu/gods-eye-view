#!/usr/bin/env node
/** Reticle coverage on oblique arrivals: source requests, toggle oracle and zoom revisits. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import {
  moveCamera,
  createScreencast,
  installFrameProbe,
} from './qa-journey-recorder.mjs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/qa-traffic-oblique.mjs <url> [--baseline] [--mode=hybrid|osm|tomtom]',
  );
  process.exit(0);
}
const baseline = args.includes('--baseline');
const modeArg = args.find((a) => a.startsWith('--mode='))?.split('=')[1];
const modes = modeArg ? [modeArg] : ['tomtom', 'osm', 'hybrid'];
const out = `qa-shots/oblique-${baseline ? 'before' : 'after'}`;
fs.mkdirSync(out, { recursive: true });
const result = { views: [], errors: [], forbidden: [], failures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: [
    '--use-angle=metal',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
try {
  for (const mode of modes) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const counts = { ofm: 0, tomtom: 0 };
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (
        u.hostname === 'tiles.openfreemap.org' &&
        /\/\d+\/\d+\/\d+(\.pbf)?$/.test(u.pathname)
      )
        counts.ofm++;
      if (u.pathname.startsWith('/api/tomtom/flow/')) counts.tomtom++;
      if (
        /overpass/i.test(u.hostname) ||
        u.hostname === 'nominatim.openstreetmap.org'
      )
        result.forbidden.push(u.hostname);
    });
    page.on('pageerror', (e) => result.errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') result.errors.push(m.text());
    });
    await page.evaluateOnNewDocument(() =>
      sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
    );
    const url = new URL(args.find((a) => /^https?:/.test(a)));
    url.searchParams.set('trafficRoads', mode);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.dataManager &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 120000 },
    );
    await page.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const g = window.__godsEyeView;
      for (const [id] of g.dataManager.layers)
        await g.dataManager.setEnabled(id, false);
      g.styleManager.setDetection({ enabled: false });
      g.viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    });
    const snap = () =>
      page.evaluate(() => {
        const { viewer, dataManager } = window.__godsEyeView;
        let upper = 0,
          lower = 0,
          near = 0;
        const camera = viewer.camera.positionWC;
        dataManager.layers
          .get('traffic')
          .module.visitMotionDots((id, key, p) => {
            if (!p.show) return;
            const s = viewer.scene.cartesianToCanvasCoordinates(p.position);
            if (s && s.x >= 240 && s.x <= 1040 && s.y >= 0 && s.y <= 800) {
              if (s.y < 400) upper++;
              else lower++;
            }
          });
        return {
          upper,
          lower,
          ...dataManager.layers.get('traffic').module.getStats(),
        };
      });
    const settle = async () => {
      await sleep(700);
      await page
        .waitForFunction(
          () => {
            const s = window.__godsEyeView.dataManager.layers
              .get('traffic')
              .module.getStats();
            return !s.loading;
          },
          { timeout: 15000 },
        )
        .catch(() => {});
      await sleep(1200);
      return snap();
    };
    for (const [name, lat, lon, height] of [
      ['dubai', 24.964, 55.037, 276],
      ['austin', 30.2672, -97.7431, 300],
      ['london', 51.507, -0.128, 300],
    ]) {
      const before = { ...counts };
      await moveCamera(page, { lat, lon, height: 3000, pitch: -45 }, 0);
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('traffic', true),
      );
      await moveCamera(page, { lat, lon, height, pitch: -15 }, 1.4);
      const settled = await settle();
      const load = {
        ofm: counts.ofm - before.ofm,
        tomtom: counts.tomtom - before.tomtom,
      };
      await page.screenshot({ path: `${out}/${name}-${mode}.png` });
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('traffic', false),
      );
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('traffic', true),
      );
      const toggled = await settle();
      const oracle =
        Math.abs(settled.upper - toggled.upper) / Math.max(1, toggled.upper);
      const preZoom = { ...counts };
      await moveCamera(page, { lat, lon, height: 3000, pitch: -15 }, 0.7);
      await settle();
      const atWide = { ...counts };
      await moveCamera(page, { lat, lon, height, pitch: -15 }, 0.7);
      await settle();
      const revisit = {
        ofm: counts.ofm - atWide.ofm,
        tomtom: counts.tomtom - atWide.tomtom,
      };
      const row = {
        mode,
        name,
        load,
        settled,
        toggled,
        oracle,
        revisit,
        zoomOut: {
          ofm: atWide.ofm - preZoom.ofm,
          tomtom: atWide.tomtom - preZoom.tomtom,
        },
      };
      result.views.push(row);
      console.log(JSON.stringify(row));
      if (oracle > 0.15)
        result.failures.push(`${name}/${mode}: upper oracle ${oracle}`);
      if (revisit.ofm || revisit.tomtom)
        result.failures.push(`${name}/${mode}: revisit requests`);
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('traffic', false),
      );
    }
    const locationView = { lat: 24.973, lon: 55.037 };
    await moveCamera(
      page,
      { lat: 24.964, lon: 55.037, height: 3000, pitch: -45 },
      0,
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('traffic', true),
    );
    const dir = `${out}/dubai-${mode}-journey`;
    const recording =
      mode === 'hybrid' ? await createScreencast(page, dir, { fps: 24 }) : null;
    await installFrameProbe(page);
    await page.evaluate(() => {
      const { viewer, dataManager } = window.__godsEyeView;
      window.__obliqueFrames = [];
      window.__obliqueMoving = true;
      viewer.scene.postRender.addEventListener(() => {
        const s = dataManager.layers.get('traffic').module.getStats();
        let upper = 0,
          lower = 0,
          near = 0;
        const camera = viewer.camera.positionWC;
        dataManager.layers
          .get('traffic')
          .module.visitMotionDots((id, key, p) => {
            if (!p.show) return;
            const q = viewer.scene.cartesianToCanvasCoordinates(p.position);
            if (q && q.x >= 240 && q.x <= 1040 && q.y >= 0 && q.y <= 800) {
              if (q.y < 400) upper++;
              else lower++;
              const dx = p.position.x - camera.x,
                dy = p.position.y - camera.y,
                dz = p.position.z - camera.z;
              if (dx * dx + dy * dy + dz * dz <= 1500 * 1500) near++;
            }
          });
        window.__obliqueFrames.push({
          t: performance.now(),
          moving: window.__obliqueMoving,
          count: s.count,
          loading: s.loading,
          upper,
          lower,
          near,
          publishes: s.motion.publishes,
          rebuilds: s.motion.rebuilds,
        });
      });
    });
    await recording?.start();
    await page.evaluate(async (v) => {
      const { flyToLandmark } = await import('/src/locations.js');
      await new Promise((resolve) =>
        flyToLandmark(window.__godsEyeView.viewer, v.lat, v.lon, {
          range: 1000,
          pitch: -15,
          heading: 0,
          duration: 1.6,
          buildingHeight: 0,
          onComplete: resolve,
          onCancel: resolve,
        }),
      );
      window.__obliqueMoving = false;
    }, locationView);
    const arrived = await settle();
    await page.evaluate(() => {
      window.__obliqueMoving = true;
    });
    await moveCamera(
      page,
      { lat: 24.964, lon: 55.042, height: 300, pitch: -15 },
      1.2,
    );
    await page.evaluate(() => {
      window.__obliqueMoving = false;
    });
    const panned = await settle();
    await sleep(1800);
    const frames = await page.evaluate(() => window.__obliqueFrames);
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('traffic', false),
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('traffic', true),
    );
    const fresh = await settle();
    const oracle =
      Math.abs(panned.upper - fresh.upper) / Math.max(1, fresh.upper);
    const stops = frames.flatMap((f, i) =>
      i && !f.moving && frames[i - 1].moving ? [i] : [],
    );
    const nearSettles = stops.map((start, index) => {
      let end = start + 1;
      while (end < frames.length && !frames[end].moving) end++;
      const phase = frames.slice(start, end),
        target = phase.at(-1).near;
      const reached = phase.find((f) => f.near >= target * 0.85);
      const ms = reached ? Math.round(reached.t - phase[0].t) : Infinity;
      if (target && ms > 1100)
        result.failures.push(
          `dubai-location-pan/${mode}/${index}: near settle ${ms} ms`,
        );
      return {
        phase: index === 0 ? 'arrival' : 'pan',
        ms,
        target,
        first: phase[0].near,
      };
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/metrics.json`, JSON.stringify(frames));
    const clip = await recording?.stop();
    result.views.push({
      mode,
      name: 'dubai-location-pan',
      nearSettles,
      arrived,
      settled: panned,
      toggled: fresh,
      oracle,
      clip,
    });
    if (oracle > 0.15)
      result.failures.push(
        `dubai-location-pan/${mode}: upper oracle ${oracle}`,
      );
    await page.close();
  }
} finally {
  fs.writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
if (
  !baseline &&
  (result.failures.length || result.errors.length || result.forbidden.length)
)
  process.exitCode = 1;
