#!/usr/bin/env node
/** Synthetic, self-authored assets exercise import, rendering and pack resource lifetime. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
const output = path.resolve('qa-shots/director-packs');
fs.mkdirSync(output, { recursive: true });
const png = await sharp({
  create: {
    width: 64,
    height: 64,
    channels: 4,
    background: { r: 255, g: 80, b: 30, alpha: 0.65 },
  },
})
  .png()
  .toBuffer();
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(16000, 40);
const geojson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'point',
      geometry: { type: 'Point', coordinates: [-97.742, 30.27, 450] },
    },
    {
      type: 'Feature',
      id: 'line',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-97.745, 30.268, 400],
          [-97.735, 30.268, 400],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-97.746, 30.265, 300],
            [-97.74, 30.265, 300],
            [-97.74, 30.267, 300],
            [-97.746, 30.265, 300],
          ],
        ],
      },
    },
  ],
};
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [],
  requests = [];
let pending,
  failures = 0;
const check = (name, passed) => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) failures++;
};
page.on('pageerror', (e) => errors.push(e.message));

await page.setRequestInterception(true);
page.on('request', (request) => {
  const url = new URL(request.url());
  if (!url.pathname.startsWith('/scene-assets/'))
    return void request.continue();
  requests.push(url.pathname);
  if (url.pathname.endsWith('/slow.json')) {
    pending = request;
    return;
  }
  const reply = url.pathname.endsWith('/outline.json')
    ? { contentType: 'application/geo+json', body: JSON.stringify(geojson) }
    : url.pathname.endsWith('/image.png')
      ? { contentType: 'image/png', body: png }
      : url.pathname.endsWith('/audio.wav')
        ? { contentType: 'audio/wav', body: wav }
        : { status: 404, body: 'missing' };
  void request.respond(reply).catch(() => {});
});
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.sceneDirector &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const manifest = (id, format, file, placement) => ({
      id,
      version: 1,
      format,
      source: { adapter: 'assets', path: `qa/${file}` },
      attribution: { text: 'Synthetic QA fixture', license: 'CC0-1.0' },
      placement,
    });
    const camera = {
      lat: 30.2672,
      lon: -97.742,
      alt: 4000,
      heading: 0,
      pitch: -90,
      roll: 0,
    };
    const project = {
      version: 5,
      scenes: [
        {
          id: 'packs',
          title: 'Data packs QA',
          anchors: [
            {
              id: 'media',
              lat: 30.269,
              lon: -97.737,
              alt: 450,
              altitudeReference: 'ellipsoid',
            },
          ],
          dataPacks: [
            manifest('outline', 'geojson', 'outline.json', {
              altitudeReference: 'ellipsoid',
            }),
            manifest('image', 'image', 'image.png', {
              bounds: [-97.738, 30.264, -97.732, 30.267],
              height: 300,
              altitudeReference: 'ellipsoid',
            }),
            manifest('media', 'media', 'audio.wav', { anchorId: 'media' }),
            manifest('slow', 'geojson', 'slow.json', {
              altitudeReference: 'ellipsoid',
            }),
            manifest('missing', 'geojson', 'missing.json', {
              altitudeReference: 'ellipsoid',
            }),
          ],
          shots: ['all', 'empty', 'slow', 'missing'].map((id) => ({
            id,
            title: id,
            camera,
            durationSec: 0.3,
            holdSec: 0.2,
            visual: { style: 'normal', mapStack: 'photoreal' },
            layers: {},
            dataPackIds:
              id === 'all'
                ? ['outline', 'image', 'media']
                : id === 'empty'
                  ? []
                  : [id],
          })),
        },
      ],
    };
    await d.importProjectFile(
      new File([JSON.stringify(project)], 'packs.json'),
    );
    window.__packBaseline = d.viewer.entities.values.length;
    window.__packPrimitiveBaseline = d.viewer.scene.primitives.length;
    window.__packRevoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      window.__packRevoked.push(url);
      revoke(url);
    };
  });
  check('import does not acquire unselected assets', requests.length === 0);
  const loaded = await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const result = await d.loadShot('packs', 'all', { flyDuration: 0.3 });
    window.__packMaterials = Array.from(
      {
        length:
          d.viewer.scene.primitives.length - window.__packPrimitiveBaseline,
      },
      (_, i) =>
        d.viewer.scene.primitives.get(window.__packPrimitiveBaseline + i)
          .appearance?.material,
    ).filter(Boolean);
    return {
      started: result?.started,
      state: d.getDataPackState(),
      count: d.viewer.entities.values.length - window.__packBaseline,
      primitives:
        d.viewer.scene.primitives.length - window.__packPrimitiveBaseline,
      cards: document.querySelectorAll('[data-director-pack]').length,
      paused: document.querySelector('[data-director-pack] audio')?.paused,
    };
  });
  check(
    'GeoJSON, PNG and media load only through registered sources',
    loaded.started && loaded.state.count === 3 && requests.length === 3,
  );
  check(
    'geometry and image batches plus anchored markers render separately',
    loaded.count === 2 && loaded.primitives === 3,
  );
  check(
    'attribution is visible and media does not autoplay',
    loaded.cards === 3 && loaded.paused === true,
  );
  await page.waitForFunction(
    () => window.__godsEyeView.mapStackController.getActiveId() === 'photoreal',
    { timeout: 15000 },
  );
  await new Promise((r) => setTimeout(r, 5000));
  await page.waitForFunction(
    () => window.__godsEyeView.tileset?.tilesLoaded === true,
    { timeout: 60000 },
  );
  const evidence = await page.evaluate(() => ({
    mapStack: window.__godsEyeView.mapStackController.getActiveId(),
    tilesSettled: window.__godsEyeView.tileset?.tilesLoaded === true,
  }));
  fs.writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify(evidence, null, 2),
  );
  check(
    'static geometry is ready before visual acceptance',
    await page.evaluate(() => {
      const primitives = window.__godsEyeView.viewer.scene.primitives;
      return Array.from(
        { length: primitives.length - window.__packPrimitiveBaseline },
        (_, i) => primitives.get(window.__packPrimitiveBaseline + i),
      ).every((p) => p.ready !== false);
    }),
  );
  await page.screenshot({ path: path.join(output, 'packs.png') });
  await page.evaluate(() => {
    const d = window.__godsEyeView.sceneDirector;
    d._setCameraView({
      ...d.styleManager.getCameraState(),
      heading: 30,
      pitch: -85,
    });
  });
  await page.waitForFunction(
    () => window.__godsEyeView.tileset?.tilesLoaded === true,
    { timeout: 60000 },
  );
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(output, 'angle.png') });
  const life = await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const media = document.querySelector('[data-director-pack] audio');
    await media.play();
    const played = !media.paused;
    await d.loadShot('packs', 'empty', { flyDuration: 0.3 });
    const cleared =
      d.getDataPackState().count === 0 &&
      !document.querySelector('[data-director-packs]') &&
      d.viewer.entities.values.length === window.__packBaseline &&
      d.viewer.scene.primitives.length === window.__packPrimitiveBaseline &&
      media.paused &&
      !media.getAttribute('src') &&
      window.__packRevoked.length === 2 &&
      window.__packMaterials.length === 1 &&
      window.__packMaterials.every((material) => material.isDestroyed());
    await d.seekScene('packs', 0.1);
    const seek = d.getDataPackState().count === 3;
    d.stopScene();
    const stopped =
      d.getDataPackState().count === 0 &&
      d.viewer.entities.values.length === window.__packBaseline;
    const missing = await d.loadShot('packs', 'missing', { flyDuration: 0.3 });
    return {
      played,
      cleared,
      seek,
      stopped,
      missing: missing?.started === false && d.getDataPackState().count === 0,
    };
  });
  for (const [name, passed] of Object.entries(life)) check(name, passed);
  await page.evaluate(() => {
    window.__pendingPack = window.__godsEyeView.sceneDirector.loadShot(
      'packs',
      'slow',
    );
  });
  const deadline = Date.now() + 15000;
  while (!pending && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  check('pending transport reached', !!pending);
  const cancelled = await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const start = performance.now();
    d.stopScene();
    await window.__pendingPack;
    return performance.now() - start < 1000 && d.getDataPackState().count === 0;
  });
  check('Stop promptly settles a pending transport', cancelled);
  if (pending)
    await pending
      .respond({
        contentType: 'application/json',
        body: JSON.stringify(geojson),
      })
      .catch(() => {});
  check(
    'late response cannot reintroduce entities',
    await page.evaluate(
      () =>
        window.__godsEyeView.viewer.entities.values.length ===
          window.__packBaseline &&
        window.__godsEyeView.viewer.scene.primitives.length ===
          window.__packPrimitiveBaseline,
    ),
  );
  await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    await d.loadShot('packs', 'all', { flyDuration: 0.3 });
    await d.importProjectFile(
      new File([JSON.stringify({ version: 5, scenes: [] })], 'empty.json'),
    );
  });
  check(
    'replacement import clears every pack resource',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector.getDataPackState().count === 0 &&
        !document.querySelector('[data-director-packs]'),
    ),
  );
  check('no uncaught browser errors', errors.length === 0);
  if (errors.length)
    console.error(errors.map((e) => e.replace(/https?:\/\/\S+/g, '[URL]')));
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
