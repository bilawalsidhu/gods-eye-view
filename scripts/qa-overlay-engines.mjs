#!/usr/bin/env node
/**
 * Layer labels on both engines, in the app (headless Chrome): the world
 * overlay host paints labels through engine.projector and the horizon test
 * projector.horizonVisible. At three camera poses the same label entries
 * (src/overlays/worldOverlay.js setOverlayEntries) are published on Cesium
 * and on Navara and their painted rectangles compared: each within 2 px of
 * Cesium's. Horizon (Navara and Cesium alike): a label on the far side of the
 * globe is not painted; one just past the limb whose render anchor sits
 * 40 m under the ellipsoid, with a cullPosition lifted 100 m, is painted
 * (worldOverlay's cullPosition rule).
 *
 *   node scripts/qa-overlay-engines.mjs --base-url=http://localhost:PORT/
 *
 * The server is the caller's (never on ports 4185–4189). Browsers are always
 * headless. Exits 1 on a failure.
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
    '--base-url=http://localhost:PORT/ (not 4185–4189) is required',
  );
  process.exit(2);
}
const TOLERANCE_PX = 2;

// Camera poses [lon, lat, height, heading, pitch] (degrees, metres).
const POSES = {
  city: [-73.99, 40.7, 3000, 20, -35],
  orbit: [-40, 30, 6_000_000, 0, -90],
  limb: [0, 0, 10_000, 90, -2],
};

async function runEngine(browser, engine) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
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
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.engine), {
    timeout: 180000,
    polling: 250,
  });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const result = {};
  for (const [name, pose] of Object.entries(POSES))
    result[name] = await page.evaluate(
      async ([lon, lat, height, heading, pitch], poseName) => {
        const geo = await import('/src/geo/index.js');
        // The module instance the app loaded (its URL may carry a version
        // query): a fresh import would be another, uninitialised host.
        const loaded = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => name.includes('/src/overlays/worldOverlay.js'));
        const overlay = await import(loaded ?? '/src/overlays/worldOverlay.js');
        const { engine } = window.__godsEyeView;
        const rad = geo.math.toRadians;
        engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(lon, lat, height),
          orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
        });
        // The horizon of a 10 km eye at the equator: ~3.2° away.
        const horizonDeg = geo.math.toDegrees(
          Math.acos(6378137 / (6378137 + 10_000)),
        );
        const entries =
          poseName === 'limb'
            ? [
                {
                  id: 'limb-lifted',
                  position: geo.cartesian3.fromDegrees(
                    horizonDeg + 0.02,
                    0,
                    -40,
                  ),
                  cullPosition: geo.cartesian3.fromDegrees(
                    horizonDeg + 0.02,
                    0,
                    100,
                  ),
                },
                {
                  id: 'limb-buried',
                  position: geo.cartesian3.fromDegrees(
                    horizonDeg + 0.02,
                    0.01,
                    -40,
                  ),
                },
                {
                  id: 'near',
                  position: geo.cartesian3.fromDegrees(1, 0, 0),
                },
              ]
            : [
                ...[-0.02, -0.01, 0, 0.01, 0.02].flatMap((dLon, i) =>
                  [-0.015, -0.005, 0.005, 0.015].map((dLat, j) => ({
                    id: `p${i}${j}`,
                    position: geo.cartesian3.fromDegrees(
                      lon + dLon * (poseName === 'orbit' ? 400 : 1),
                      lat + 0.03 + dLat * (poseName === 'orbit' ? 400 : 1),
                      0,
                    ),
                  })),
                ),
                {
                  id: 'far-side',
                  position: geo.cartesian3.fromDegrees(lon + 180, -lat, 0),
                },
              ];
        overlay.setOverlayEntries(
          'qa-engines',
          entries.map((entry) => ({
            ...entry,
            variant: 'label',
            title: entry.id.toUpperCase(),
            horizonCull: true,
          })),
          { cohortLimit: 64, collisionCapacity: 64 },
        );
        overlay.setOverlaySourceVisible('qa-engines', true);
        for (let frame = 0; frame < 20; frame++) {
          engine.render.request('qa-overlay-engines');
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const rects = {};
        for (const { id } of entries) {
          const rect = overlay.getOverlayPaintRect('qa-engines', id);
          // The label's projected anchor (where the host put the point the
          // card belongs to); the card's own slot is the solver's choice.
          rects[id] = rect ? { x: rect.anchorX, y: rect.anchorY } : null;
        }
        overlay.clearOverlaySource('qa-engines');
        return rects;
      },
      pose,
      name,
    );
  // A moving camera: the city labels are published once, then the camera
  // moves on (heading and position) and the painted labels are read at
  // each step, the same steps on both engines.
  const steps = await page.evaluate(async () => {
    const geo = await import('/src/geo/index.js');
    const loaded = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/src/overlays/worldOverlay.js'));
    const overlay = await import(loaded ?? '/src/overlays/worldOverlay.js');
    const { engine } = window.__godsEyeView;
    const rad = geo.math.toRadians;
    const at = (step) => ({
      destination: geo.cartesian3.fromDegrees(
        -73.99 + step * 0.002,
        40.7 + step * 0.001,
        3000 - step * 150,
      ),
      orientation: { heading: rad(20 + step * 4), pitch: rad(-35), roll: 0 },
    });
    engine.camera.setView(at(0));
    const ids = [];
    const entries = [];
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 4; j++) {
        const id = `m${i}${j}`;
        ids.push(id);
        entries.push({
          id,
          variant: 'label',
          title: id.toUpperCase(),
          horizonCull: true,
          position: geo.cartesian3.fromDegrees(
            -74.01 + i * 0.012,
            40.715 + j * 0.008,
            0,
          ),
        });
      }
    overlay.setOverlayEntries('qa-engines-moving', entries, {
      cohortLimit: 64,
      collisionCapacity: 64,
      moving: true,
    });
    overlay.setOverlaySourceVisible('qa-engines-moving', true);
    const frames = async (count) => {
      for (let frame = 0; frame < count; frame++) {
        engine.render.request('qa-overlay-engines');
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };
    await frames(20);
    const out = [];
    for (let step = 1; step <= 6; step++) {
      engine.camera.setView(at(step));
      await frames(4);
      const rects = {};
      for (const id of ids) {
        const rect = overlay.getOverlayPaintRect('qa-engines-moving', id);
        rects[id] = rect ? { x: rect.anchorX, y: rect.anchorY } : null;
      }
      out.push(rects);
    }
    overlay.clearOverlaySource('qa-engines-moving');
    return out;
  });
  result.moving = steps;
  await context.close();
  return result;
}

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal'],
});
let failures = 0;
const fail = (message) => {
  failures++;
  console.log(`[overlay-engines] FAIL ${message}`);
};
try {
  const runs = {};
  for (const engine of ['cesium', 'navara'])
    runs[engine] = await runEngine(browser, engine);
  for (const pose of Object.keys(POSES)) {
    const cesium = runs.cesium[pose];
    const navara = runs.navara[pose];
    let worst = 0;
    let compared = 0;
    for (const id of Object.keys(cesium)) {
      const a = cesium[id];
      const b = navara[id];
      if (Boolean(a) !== Boolean(b)) {
        fail(`${pose} ${id}: painted on ${a ? 'Cesium' : 'Navara'} only`);
        continue;
      }
      if (!a) continue;
      compared++;
      const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      worst = Math.max(worst, d);
      if (d > TOLERANCE_PX) fail(`${pose} ${id}: ${d.toFixed(2)} px apart`);
    }
    console.log(
      `[overlay-engines] ${pose}: ${compared} labels on both, worst ${worst.toFixed(2)} px`,
    );
  }
  {
    let worst = 0;
    let compared = 0;
    let onlyOne = 0;
    runs.cesium.moving.forEach((cesium, step) => {
      const navara = runs.navara.moving[step];
      for (const id of Object.keys(cesium)) {
        const a = cesium[id];
        const b = navara[id];
        // Which cards the solver paints while the camera moves depends on
        // its timing; the anchors of the ones both painted are compared.
        if (!a || !b) {
          if (a || b) onlyOne++;
          continue;
        }
        compared++;
        const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        worst = Math.max(worst, d);
        if (d > TOLERANCE_PX)
          fail(`moving step ${step + 1} ${id}: ${d.toFixed(2)} px apart`);
      }
    });
    console.log(
      `[overlay-engines] moving camera: ${compared} label anchors over 6 steps on both, worst ${worst.toFixed(2)} px (${onlyOne} painted on one engine only)`,
    );
  }
  for (const engine of ['cesium', 'navara']) {
    const { orbit, city, limb } = runs[engine];
    if (orbit['far-side'] || city['far-side'])
      fail(`${engine}: the far-side label was painted`);
    if (!limb['limb-lifted'])
      fail(`${engine}: the lifted label at the limb was not painted`);
    if (limb['limb-buried'])
      fail(`${engine}: the buried label past the limb was painted`);
    if (!limb.near) fail(`${engine}: the near label was not painted`);
    console.log(
      `[overlay-engines] ${engine} horizon: far side ${orbit['far-side'] ? 'shown' : 'hidden'}, limb lifted ${limb['limb-lifted'] ? 'shown' : 'hidden'}, limb buried ${limb['limb-buried'] ? 'shown' : 'hidden'}`,
    );
  }
} finally {
  await browser.close();
}
console.log(
  `[overlay-engines] ${failures ? `${failures} failure(s)` : 'all checks passed'}`,
);
process.exit(failures ? 1 : 0);
