#!/usr/bin/env node
/**
 * Compare the animated ground corridors with the Cesium drawing they
 * replace, on the Cesium engine (keyless, headless): Street Traffic's jam
 * heat lines (PolylineGlow, glowPower 0.25, alpha 0.55 ± 0.2 on
 * sin(now / 260 ms)) and the Directions route (the annotation route's
 * GevRouteFlow material, 9 px). One road and one route over Dubai, nadir,
 * drawn at fixed page times (performance.now() frozen), so every variant
 * shows the same phase of the pulse and the dashes:
 *
 *   --variant=old     the old drawing, rebuilt with Cesium directly: a
 *                     GroundPolylinePrimitive with PolylineGlow, its alpha
 *                     set from the frozen time, and the Directions route
 *                     entity with FlowMaterialProperty;
 *   --variant=engine  engine.ground: the jam as the traffic layer gives it
 *                     (glow and pulse when the build has them), the route
 *                     through the Directions display.
 *
 * Both drape on terrain and tiles ('both'): keyless there are no 3D tiles,
 * where the traffic layer drapes its heat lines.
 *
 * `--engine=navara` draws the engine variant on Navara (daylight app clock;
 * its frames at the live page time, 400 ms apart: Navara's frame loop stops
 * on a frozen one).
 *
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 4271
 *   node scripts/qa-ground-looks.mjs http://localhost:4271 --variant=old --out=DIR
 *   node scripts/qa-ground-looks.mjs --compare=DIR_A,DIR_B
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const args = process.argv.slice(2);
const option = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const BLOCKED_HOSTS =
  /(^|\.)(googleapis\.com|google\.com|gstatic\.com|cesium\.com)$/;
// Page times (ms) the frames are drawn at: across one pulse (1.63 s) and
// a few dash cells.
const TIMES = [100_000, 100_400, 100_800, 101_200];
const CROP = { left: 340, top: 200, width: 600, height: 400 };
// Metres over the ground: the road and the route fill the crop.
const ALTITUDE = 6000;

async function compare([a, b]) {
  const rows = [];
  for (const name of fs
    .readdirSync(a)
    .filter((file) => file.endsWith('.png'))) {
    if (!fs.existsSync(path.join(b, name))) continue;
    const read = (dir) =>
      sharp(path.join(dir, name))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const [left, right] = await Promise.all([read(a), read(b)]);
    let sum = 0;
    let over = 0;
    const pixels = left.info.width * left.info.height;
    for (let i = 0; i < left.data.length; i += 3) {
      let most = 0;
      for (let k = 0; k < 3; k++)
        most = Math.max(most, Math.abs(left.data[i + k] - right.data[i + k]));
      sum += most;
      if (most > 24) over++;
    }
    rows.push({
      image: name,
      meanDiff: +(sum / pixels).toFixed(2),
      over24: +(over / pixels).toFixed(4),
    });
  }
  console.table(rows);
}

async function draw(origin, variant, out, engineKind) {
  fs.mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 600_000,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (error) => console.log('page error:', error.message));
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (BLOCKED_HOSTS.test(new URL(request.url()).hostname)) request.abort();
      else request.continue();
    });
    await page.goto(
      `${origin}/?welcome=0&engine=${engineKind}#v=2&lat=25.2&lon=55.3&alt=${ALTITUDE}&heading=0&pitch=-90&map=osm&l=`,
    );
    await page.waitForFunction(
      (kind) =>
        window.__godsEyeView?.engine?.kind === kind &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 300_000, polling: 250 },
      engineKind,
    );
    await page.evaluate(
      async (variant, altitude) => {
        const { engine } = window.__godsEyeView;
        const { appClock } = await import('/src/time/clock.js');
        appClock.freeze(Date.UTC(2026, 10, 7, 8, 0));
        const frame = () =>
          new Promise((resolve) => {
            const remove = engine.frames.postRender.addEventListener(() => {
              remove();
              resolve();
            });
            engine.render.request('qa-ground-looks');
          });
        const geo = await import('/src/geo/index.js');
        engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(55.3, 25.2, altitude),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        // Tiles in.
        const started = performance.now();
        let loaded = 0;
        while (performance.now() - started < 60_000 && loaded < 30) {
          await frame();
          loaded = engine.surface.tilesLoaded() ? loaded + 1 : 0;
        }
        // A jam road across the view, and a route with turns below it.
        const road = [
          [55.288, 25.204],
          [55.296, 25.206],
          [55.304, 25.203],
          [55.312, 25.205],
        ];
        const route = [
          [55.286, 25.196],
          [55.294, 25.197],
          [55.297, 25.192],
          [55.306, 25.193],
          [55.314, 25.196],
        ];
        const policy = await import('/src/layers/traffic/policy.js');
        const jamRgba = policy.HEAT_JAM_COLOR.rgba();
        if (variant === 'old') {
          // The app's own Cesium module: the URL the dev server gave the
          // engine's import of it.
          const served = await (
            await fetch('/src/globe/cesium/ground.js')
          ).text();
          const Cesium = await import(
            served.match(/from\s+["']([^"']*cesium[^"']*)["']/)[1]
          );
          const { FlowMaterialProperty, ensureFlowFabricRegistered } =
            await import('/src/globe/cesium/annotations/worldAnnotationRenderer.js');
          const { viewer } = engine.extensions.cesium;
          const color = new Cesium.Color(...jamRgba.slice(0, 3), 0.55);
          const jam = viewer.scene.groundPrimitives.add(
            new Cesium.GroundPolylinePrimitive({
              geometryInstances: [
                new Cesium.GeometryInstance({
                  geometry: new Cesium.GroundPolylineGeometry({
                    positions: Cesium.Cartesian3.fromDegreesArray(road.flat()),
                    width: 9,
                  }),
                }),
              ],
              classificationType: Cesium.ClassificationType.BOTH,
              appearance: new Cesium.PolylineMaterialAppearance({
                material: Cesium.Material.fromType('PolylineGlow', {
                  color,
                  glowPower: 0.25,
                }),
              }),
            }),
          );
          ensureFlowFabricRegistered();
          viewer.entities.add({
            id: 'qa-route',
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(route.flat()),
              width: 9,
              material: new FlowMaterialProperty('#39d0ff'),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
          });
          // The traffic animation set the jam's alpha every frame.
          engine.frames.preRender.addEventListener(() => {
            jam.appearance.material.uniforms.color.alpha =
              policy.HEAT_JAM_BASE_ALPHA +
              policy.HEAT_JAM_PULSE_ALPHA * Math.sin(performance.now() / 260);
          });
          window.__qaReady = () => jam.ready;
        } else {
          const { createDirectionsDisplay } =
            await import('/src/layers/directions/render/display.js');
          const animated = policy.HEAT_JAM_GLOW_POWER !== undefined;
          const set = engine.ground.createSet({
            id: 'qa-jam',
            kind: 'corridor',
            drape: 'both',
          });
          // As src/layers/traffic/rendering.js gives the jam bucket.
          set.replace([
            {
              positions: road,
              widthPx: policy.HEAT_LINE_JAM_WIDTH,
              ...(animated
                ? {
                    color: [...jamRgba.slice(0, 3), 1],
                    glow: { power: policy.HEAT_JAM_GLOW_POWER },
                    pulse: {
                      periodMs: policy.HEAT_JAM_PULSE_PERIOD_MS,
                      min:
                        policy.HEAT_JAM_BASE_ALPHA -
                        policy.HEAT_JAM_PULSE_ALPHA,
                      max:
                        policy.HEAT_JAM_BASE_ALPHA +
                        policy.HEAT_JAM_PULSE_ALPHA,
                    },
                  }
                : {
                    color: [...jamRgba.slice(0, 3), policy.HEAT_JAM_BASE_ALPHA],
                  }),
            },
          ]);
          set.commit();
          const display = createDirectionsDisplay(engine);
          display.setRoute(route);
          window.__qaReady = () => set.ready();
        }
        const until = Date.now() + 60_000;
        while (!window.__qaReady() && Date.now() < until) await frame();
        loaded = 0;
        while (Date.now() < until + 60_000 && loaded < 30) {
          await frame();
          loaded = engine.surface.tilesLoaded() ? loaded + 1 : 0;
        }
      },
      variant,
      ALTITUDE,
    );
    for (const time of TIMES) {
      await page.evaluate(async (time) => {
        const { engine } = window.__godsEyeView;
        // Navara's frame loop stops on a frozen page clock: there the frames
        // are drawn at the live time, 400 ms apart.
        if (engine.kind === 'navara')
          await new Promise((resolve) => setTimeout(resolve, 400));
        else performance.now = () => time;
        for (let k = 0; k < 4; k++)
          await new Promise((resolve) => {
            const remove = engine.frames.postRender.addEventListener(() => {
              remove();
              resolve();
            });
            engine.render.request('qa-ground-looks');
          });
      }, time);
      await page.screenshot({
        path: path.join(out, `looks-${time}.png`),
        clip: {
          x: CROP.left,
          y: CROP.top,
          width: CROP.width,
          height: CROP.height,
        },
      });
    }
  } finally {
    await browser.close();
  }
}

const pair = option('compare');
if (pair) await compare(pair.split(','));
else {
  const origin = args.find((arg) => !arg.startsWith('--'));
  if (!origin) {
    console.error(
      'Usage: node scripts/qa-ground-looks.mjs <origin> --variant=old|engine --out=DIR | --compare=A,B',
    );
    process.exit(2);
  }
  const variant = option('variant') ?? 'engine';
  // The old drawing is Cesium's own; engine.ground also draws on Navara.
  const engineKind =
    variant === 'old' ? 'cesium' : (option('engine') ?? 'cesium');
  await draw(origin, variant, option('out') ?? 'qa-ground-looks', engineKind);
}
