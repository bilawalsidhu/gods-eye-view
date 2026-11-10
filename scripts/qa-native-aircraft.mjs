/** Native billboard image fidelity, CSS footprint, picking and resource-mode checks. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { aircraftIcon } from '../src/data/aircraftIcons.js';
import { hookRenderErrors, readRenderErrors } from './qa-browserEvidence.mjs';
const out = path.resolve(
  process.argv[2] || 'qa-artifacts/native-crispness/fidelity',
);
const url = process.argv[3] || 'http://127.0.0.1:4182/?welcome=0';
await fs.mkdir(out, { recursive: true });
const report = { checks: [], errors: [], images: [] };
const check = (name, pass) => {
  report.checks.push({ name, pass: !!pass });
  assert.ok(pass, name);
};
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });
  await hookRenderErrors(page);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  const ready = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.performance.ready;
    const v = app.viewer;
    for (const [id, entry] of app.dataManager.layers)
      if (entry.enabled)
        await app.dataManager.setEnabled(id, false, { origin: 'user' });
    await app.styleManager.setMapStack('osm');
    app.styleManager._setDetectionMode('OFF');
    v.camera.cancelFlight();
    v.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-98, 38, 65000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    v.scene.globe.show = false;
    v.scene.skyBox.show = false;
    v.scene.skyAtmosphere.show = false;
    v.scene.backgroundColor = Cesium.Color.BLACK;
    window.__qualityCollection = v.scene.primitives.add(
      new Cesium.BillboardCollection(),
    );
    window.__qualityBillboard = window.__qualityCollection.add({
      position: Cesium.Cartesian3.fromDegrees(-98, 38, 0),
      id: 'native-crispness',
      width: 60,
      height: 60,
      rotation: 0.4,
      disableDepthTestDistance: Infinity,
    });
    return {
      ratio: v.resolutionScale,
      fps: v.targetFrameRate,
      recommended: v.useBrowserRecommendedResolution,
    };
  });
  check(
    'normal mode uses the bounded 1.5x native framebuffer on a 2x display',
    ready.ratio === 1.5 && ready.fps === 60 && ready.recommended === true,
  );
  const buffers = [];
  for (const [label, ratio, px] of [
    ['before', 1, 64],
    ['after', 1.5, 96],
    ['reference', 2, 120],
  ]) {
    const data = await page.evaluate(
      async ({ ratio, image }) => {
        const v = window.__godsEyeView.viewer;
        v.resolutionScale = ratio;
        v.resize();
        window.__qualityBillboard.image = image;
        await new Promise((resolve) => {
          const timer = setInterval(() => v.scene.requestRender(), 20);
          setTimeout(() => {
            clearInterval(timer);
            resolve();
          }, 800);
        });
        const center = Cesium.SceneTransforms.worldToWindowCoordinates(
          v.scene,
          window.__qualityBillboard.position,
        );
        const hit = v.scene.pick(center);
        return {
          x: center.x,
          y: center.y,
          picked: hit?.id,
          ratio: v.scene.drawingBufferWidth / v.scene.canvas.clientWidth,
        };
      },
      { ratio, image: aircraftIcon('airliner', px) },
    );
    check(
      `${label}: native CSS-coordinate picking retains the contact id`,
      data.picked === 'native-crispness',
    );
    check(
      `${label}: requested native pixel ratio is used`,
      Math.abs(data.ratio - ratio) < 0.01,
    );
    const screenshot = await page.screenshot();
    const crop = await sharp(screenshot)
      .extract({
        left: Math.round(data.x * 2) - 100,
        top: Math.round(data.y * 2) - 100,
        width: 200,
        height: 200,
      })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(out, `${label}.png`), crop);
    const { data: pixels } = await sharp(crop)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    buffers.push(pixels);
    let minX = 200,
      minY = 200,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 200; x++)
        if (pixels[(y * 200 + x) * 3] > 200) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
    report.images.push({
      label,
      ...data,
      whiteBounds: { width: maxX - minX + 1, height: maxY - minY + 1 },
    });
  }
  const mse = (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return sum / a.length;
  };
  report.referenceMse = {
    before: mse(buffers[0], buffers[2]),
    after: mse(buffers[1], buffers[2]),
  };
  check(
    'bounded native rendering is closer to the full-resolution reference',
    report.referenceMse.after < report.referenceMse.before,
  );
  check(
    'aircraft CSS footprint is preserved',
    Math.abs(
      report.images[0].whiteBounds.width - report.images[1].whiteBounds.width,
    ) <= 4 &&
      Math.abs(
        report.images[0].whiteBounds.height -
          report.images[1].whiteBounds.height,
      ) <= 4,
  );
  const modes = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    app.viewer.resolutionScale = app.viewer.gevStandardResolutionScale;
    const values = [];
    for (const mode of ['low', 'standard']) {
      app.performance.setMode(mode, { persist: false });
      await app.performance.whenSettled();
      app.viewer.resize();
      values.push({
        mode,
        scale: app.viewer.resolutionScale,
        fps: app.viewer.targetFrameRate,
      });
    }
    return values;
  });
  report.modes = modes;
  check(
    'low-resource mode retains its 0.6x/30 FPS budget',
    modes[0].scale === 0.6 && modes[0].fps === 30,
  );
  check(
    'normal mode restores sharpness and 60 FPS',
    modes[1].scale === 1.5 && modes[1].fps === 60,
  );
  report.errors.push(...(await readRenderErrors(page)));
  check('no JavaScript or render errors', !report.errors.length);
} catch (error) {
  report.errors.push(String(error.stack || error));
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
