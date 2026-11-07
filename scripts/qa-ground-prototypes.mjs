#!/usr/bin/env node
/**
 * The engine.ground prototypes of earthquakes and fire perimeters
 * (src/layers/earthquakes/render/ground.js,
 * src/layers/perimeters/render/ground.js) against what each engine draws
 * today, on fixed data over California in daylight. Per engine: the canvas
 * without the layers, with today's renderers, with the ground prototypes;
 * the pixels each drawing changed (a channel off by more than 24), and
 * their overlap (intersection over union) with today's Cesium drawing; a
 * pick of a quake and of a perimeter through engine.picker. Writes the
 * images and a side-by-side to --out.
 *
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 4271
 *   node scripts/qa-ground-prototypes.mjs http://localhost:4271 --out=DIR
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const BLOCKED_HOSTS =
  /(^|\.)(googleapis\.com|google\.com|gstatic\.com|cesium\.com)$/;
const args = process.argv.slice(2);
const origin = args.find((arg) => !arg.startsWith('--'));
const option = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option('out') ?? 'qa-ground-prototypes';
if (!origin) {
  console.error(
    'Usage: node scripts/qa-ground-prototypes.mjs <origin> --out=DIR',
  );
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const VIEW = { lon: -119.6, lat: 37.2, alt: 700000 };

async function capture(page, kind) {
  const ui = await page.evaluate(
    async (kind, view) => {
      const { engine } = window.__godsEyeView;
      const frame = () =>
        new Promise((resolve) => {
          const remove = engine.frames.postRender.addEventListener(() => {
            remove();
            resolve();
          });
          engine.render.request('ground-prototypes');
        });
      const settle = async () => {
        let loaded = 0;
        const started = performance.now();
        while (loaded < 20 && performance.now() - started < 60000) {
          await frame();
          loaded = engine.surface.tilesLoaded() ? loaded + 1 : 0;
        }
      };
      const shot = async () => {
        await settle();
        const canvas = engine.host.canvas;
        const copy = document.createElement('canvas');
        copy.width = canvas.clientWidth;
        copy.height = canvas.clientHeight;
        copy.getContext('2d').drawImage(canvas, 0, 0, copy.width, copy.height);
        return copy.toDataURL('image/png');
      };
      const geo = await import('/src/geo/index.js');
      const { depthColor } = await import('/src/layers/earthquakes/model.js');
      // Fixed quakes and perimeters (one with a hole) in the view.
      const quakes = [
        [-121.8, 36.6, 3.1, 8],
        [-120.6, 35.9, 4.6, 12],
        [-118.4, 37.6, 5.4, 9],
        [-117.6, 36.2, 2.8, 120],
        [-121.0, 38.4, 3.9, 400],
        [-119.0, 38.9, 6.0, 15],
      ].map(([lon, lat, mag, depthKm], index) => ({
        stableId: `q${index}`,
        usgsId: `q${index}`,
        position: geo.cartesian3.fromDegrees(lon, lat),
        baseRadius: 2 ** mag * 1000,
        color: depthColor(depthKm),
        isSignificant: mag >= 5,
        fillAlpha: mag >= 5 ? 0.4 : 0.3,
        outlineAlpha: mag >= 5 ? 1 : 0.8,
        mag,
        place: `fixture ${index}`,
        time: 0,
        depthKm,
      }));
      const blob = (lon, lat, rx, ry, count = 40) => {
        const ring = [];
        for (let k = 0; k < count; k++) {
          const angle = (k / count) * 2 * Math.PI;
          const wobble = 1 + 0.18 * Math.sin(angle * 5);
          ring.push([
            lon + rx * wobble * Math.cos(angle),
            lat + ry * wobble * Math.sin(angle),
          ]);
        }
        ring.push(ring[0]);
        return ring;
      };
      const perimeters = [
        {
          stableId: 'p0',
          containedPct: 10,
          polygons: [
            [blob(-120.2, 37.9, 0.35, 0.25), blob(-120.2, 37.9, 0.12, 0.08)],
          ],
        },
        {
          stableId: 'p1',
          containedPct: 60,
          polygons: [[blob(-118.9, 36.6, 0.25, 0.3)]],
        },
        {
          stableId: 'p2',
          containedPct: 100,
          polygons: [
            [blob(-121.4, 37.4, 0.15, 0.12)],
            [blob(-121.1, 37.1, 0.1, 0.1)],
          ],
        },
      ];
      // A restored view settles after the loading screen: take the camera.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(view.lon, view.lat, view.alt),
      });
      const images = { base: await shot() };
      // Today's renderers on this engine.
      let quakeRenderer;
      let perimeterRenderer;
      if (kind === 'cesium') {
        const { viewer } = engine.extensions.cesium;
        const { createEarthquakesCesiumRenderer } =
          await import('/src/layers/earthquakes/render/cesium.js');
        const { createPerimetersCesiumRenderer } =
          await import('/src/layers/perimeters/render/cesium.js');
        quakeRenderer = createEarthquakesCesiumRenderer(engine, { viewer });
        perimeterRenderer = createPerimetersCesiumRenderer({
          viewer,
          screenSpaceEventHandlerFactory: () => ({
            setInputAction() {},
            destroy() {},
          }),
        });
      } else {
        const navara = engine.extensions.navara;
        const { createEarthquakesNavaraRenderer } =
          await import('/src/layers/earthquakes/render/navara.js');
        const { createPerimetersNavaraRenderer } =
          await import('/src/layers/perimeters/render/navara.js');
        quakeRenderer = createEarthquakesNavaraRenderer(engine, navara);
        perimeterRenderer = createPerimetersNavaraRenderer(engine, navara);
      }
      quakeRenderer.replace(quakes);
      quakeRenderer.setVisible(true);
      perimeterRenderer.replace(perimeters);
      perimeterRenderer.setVisible(true);
      for (let index = 0; index < 60; index++) await frame();
      images.today = await shot();
      quakeRenderer.destroy();
      perimeterRenderer.destroy();
      // The prototypes on engine.ground.
      const { createEarthquakesGroundRenderer } =
        await import('/src/layers/earthquakes/render/ground.js');
      const { createPerimetersGroundRenderer } =
        await import('/src/layers/perimeters/render/ground.js');
      const quakesOnGround = createEarthquakesGroundRenderer(engine);
      const perimetersOnGround = createPerimetersGroundRenderer(engine);
      quakesOnGround.replace(quakes);
      quakesOnGround.setVisible(true);
      perimetersOnGround.replace(perimeters);
      perimetersOnGround.setVisible(true);
      const ready = () =>
        engine.ground.list().every(({ id }) => id) &&
        ['earthquakes', 'fire-perimeters'].every((id) =>
          engine.ground.list().some((entry) => entry.id === id),
        );
      while (!ready()) await frame();
      for (let index = 0; index < 60; index++) await frame();
      images.ground = await shot();
      const screen = (lon, lat) =>
        engine.projector.worldToWindow(geo.cartesian3.fromDegrees(lon, lat));
      const picks = {
        quake: engine.picker.pick(screen(-118.4, 37.6))?.id ?? null,
        perimeter: engine.picker.pick(screen(-118.9, 36.6))?.id ?? null,
        hole: engine.picker.pick(screen(-120.2, 37.9))?.id ?? null,
        records: quakesOnGround.records(10).length,
      };
      quakesOnGround.destroy();
      perimetersOnGround.destroy();
      return { images, picks };
    },
    kind,
    VIEW,
  );
  return ui;
}

async function openEngine(browser, kind) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (error) => console.log('  page error:', error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (BLOCKED_HOSTS.test(new URL(request.url()).hostname)) request.abort();
    else request.continue();
  });
  await page.goto(
    `${origin}/?welcome=0&engine=${kind}#v=2&lat=${VIEW.lat}&lon=${VIEW.lon}&alt=${VIEW.alt}&heading=0&pitch=-90&map=osm&l=`,
  );
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView?.engine?.kind === expected &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 300_000, polling: 250 },
    kind,
  );
  // Daylight over California (Navara lights the scene by the app clock).
  await page.evaluate(async () => {
    const { appClock } = await import('/src/time/clock.js');
    appClock.freeze(Date.UTC(2026, 10, 7, 20, 0));
  });
  return page;
}

const decode = async (dataUrl) => {
  const { data, info } = await sharp(
    Buffer.from(dataUrl.split(',')[1], 'base64'),
  )
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
// Pixels where `image` differs from `base` by more than 24 on a channel.
const changed = (base, image) => {
  const mask = new Uint8Array(base.width * base.height);
  for (let i = 0; i < mask.length; i++)
    for (let c = 0; c < 3; c++)
      if (Math.abs(base.data[i * 4 + c] - image.data[i * 4 + c]) > 24) {
        mask[i] = 1;
        break;
      }
  return mask;
};
const iou = (a, b) => {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    either += a[i] | b[i];
  }
  return either ? both / either : 1;
};
const count = (mask) => mask.reduce((total, value) => total + value, 0);

const browser = await puppeteer.launch({ headless: true });
const results = {};
try {
  for (const kind of ['cesium', 'navara']) {
    const page = await openEngine(browser, kind);
    results[kind] = await capture(page, kind);
    await page.close();
  }
} finally {
  await browser.close();
}
const masks = {};
for (const kind of ['cesium', 'navara']) {
  const { images, picks } = results[kind];
  const base = await decode(images.base);
  masks[kind] = {
    today: changed(base, await decode(images.today)),
    ground: changed(base, await decode(images.ground)),
  };
  for (const name of ['base', 'today', 'ground'])
    fs.writeFileSync(
      path.join(out, `${kind}-${name}.png`),
      Buffer.from(images[name].split(',')[1], 'base64'),
    );
  console.log(
    `${kind}: today changed ${count(masks[kind].today)} px, ground ${count(masks[kind].ground)} px; picks ${JSON.stringify(picks)}`,
  );
}
const reference = masks.cesium.today;
console.log(
  `overlap with today's Cesium drawing (IoU of changed pixels): Cesium ground ${iou(reference, masks.cesium.ground).toFixed(3)}, Navara ground ${iou(reference, masks.navara.ground).toFixed(3)}, Navara today ${iou(reference, masks.navara.today).toFixed(3)}`,
);
// Side by side: Cesium today, Cesium ground, Navara today, Navara ground.
const tiles = await Promise.all(
  ['cesium-today', 'cesium-ground', 'navara-today', 'navara-ground'].map(
    (name) =>
      sharp(path.join(out, `${name}.png`))
        .resize(640, 400)
        .png()
        .toBuffer(),
  ),
);
await sharp({
  create: { width: 1280, height: 800, channels: 3, background: '#000' },
})
  .composite(
    tiles.map((input, index) => ({
      input,
      left: (index % 2) * 640,
      top: Math.floor(index / 2) * 400,
    })),
  )
  .png()
  .toFile(path.join(out, 'side-by-side.png'));
