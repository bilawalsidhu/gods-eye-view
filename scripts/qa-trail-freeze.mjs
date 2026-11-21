#!/usr/bin/env node
/**
 * Trail freeze gate: freezing a trail chunk never shows a blank frame.
 *
 * A tracked aircraft's trail is cut into chunks; every chunk but the newest
 * is frozen into static geometry, which Cesium builds asynchronously. Until
 * that geometry is in the scene, the chunk keeps being drawn dynamically.
 *
 * This gate drives the real app and a real Cesium scene: it draws a trail of
 * CHUNK_POINTS points (all dynamic), then adds one point so the first chunk
 * freezes, and on every rendered frame after that it checks two things:
 *  1. every frozen chunk is either still drawn by a dynamic polyline or its
 *     static geometry is in the scene (DataSourceDisplay reports DONE);
 *  2. the number of trail-coloured pixels never drops below 90% of the
 *     count measured just before the freeze.
 * It also checks that clearing the trail releases every chunk entity.
 *
 * The camera is held still while the gate runs.
 *
 * Needs a running dev server:
 *   node scripts/qa-trail-freeze.mjs [--url http://localhost:4173]
 */
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

const urlFlag = process.argv.indexOf('--url');
const APP_URL =
  urlFlag > 0 ? process.argv[urlFlag + 1] : 'http://localhost:4173';

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  executablePath: chromeExecutablePath(),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=960,640',
  ],
});

let failed = false;
const report = (name, ok, detail) => {
  if (!ok) failed = true;
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`,
  );
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 640 });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180_000 },
  );

  const result = await page.evaluate(async () => {
    // The exact Cesium module the renderer uses, so classes are shared.
    const source = await (await fetch('/src/data/trailRenderer.js')).text();
    const cesiumUrl = source.match(/from\s+["']([^"']*cesium[^"']*)["']/)[1];
    const Cesium = await import(cesiumUrl);
    const { createTrail, CHUNK_POINTS } =
      await import('/src/data/trailRenderer.js');
    const viewer = window.__godsEyeView.viewer;
    const scene = viewer.scene;
    const nextFrame = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve();
        });
        scene.requestRender();
      });

    // A line across the middle of the current view, in mid-air in front of
    // the camera, so terrain and buildings never hide it.
    viewer.camera.cancelFlight?.();
    const camera = viewer.camera;
    const ahead = Cesium.Cartesian3.add(
      camera.positionWC,
      Cesium.Cartesian3.multiplyByScalar(
        camera.directionWC,
        3_000,
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    const points = Array.from({ length: CHUNK_POINTS + 1 }, (_, i) =>
      Cesium.Cartesian3.add(
        ahead,
        Cesium.Cartesian3.multiplyByScalar(
          camera.rightWC,
          -1_200 + (2_400 * i) / CHUNK_POINTS,
          new Cesium.Cartesian3(),
        ),
        new Cesium.Cartesian3(),
      ),
    );
    const added = [];
    const removed = [];
    const add = viewer.entities.add.bind(viewer.entities);
    const remove = viewer.entities.remove.bind(viewer.entities);
    viewer.entities.add = (definition) => {
      const entity = add(definition);
      if (String(entity.id).startsWith('gev-trail:')) added.push(entity);
      return entity;
    };
    viewer.entities.remove = (entity) => {
      if (String(entity?.id).startsWith('gev-trail:')) removed.push(entity);
      return remove(entity);
    };

    const gl = scene.context._gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    // Magenta trail: count pixels that are clearly magenta.
    const countTrailPixels = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let count = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        const r = pixels[p];
        const g = pixels[p + 1];
        const b = pixels[p + 2];
        if (r > 150 && b > 150 && g < 110) count++;
      }
      return count;
    };

    const trail = createTrail(viewer, { color: '#ff00ff', width: 8 });
    trail.setPositions(points.slice(0, CHUNK_POINTS));
    for (let i = 0; i < 20; i++) await nextFrame();
    const before = trail._chunksForTest();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let p = 0; p < pixels.length; p += 4)
      if (pixels[p] || pixels[p + 1] || pixels[p + 2]) lit++;
    const cam = viewer.camera.positionCartographic;
    const diagnostics = {
      lit,
      size: [width, height],
      camera: [
        Cesium.Math.toDegrees(cam.longitude),
        Cesium.Math.toDegrees(cam.latitude),
        cam.height,
      ],
      preserveDrawingBuffer: gl.getContextAttributes().preserveDrawingBuffer,
    };
    let baseline = 0;
    for (let i = 0; i < 5; i++) {
      await nextFrame();
      baseline = Math.max(baseline, countTrailPixels());
    }

    trail.setPositions(points);
    const frames = [];
    const sphere = new Cesium.BoundingSphere();
    let resolvedAt = null;
    for (let i = 0; i < 400; i++) {
      await nextFrame();
      const state = trail._chunksForTest();
      const covered = state.frozen.every(
        (chunk) =>
          chunk.standIn ||
          viewer.dataSourceDisplay.getBoundingSphere(
            chunk.entity,
            false,
            sphere,
          ) === Cesium.BoundingSphereState.DONE,
      );
      frames.push({ covered, pixels: countTrailPixels() });
      if (resolvedAt == null && state.frozen.every((c) => !c.standIn))
        resolvedAt = i;
      if (resolvedAt != null && i > resolvedAt + 30) break;
    }

    trail.clear();
    for (let i = 0; i < 3; i++) await nextFrame();
    const frozenAfterClear = trail._chunksForTest().frozen.length;
    trail.destroy();
    const leaked = added.filter((entity) => !removed.includes(entity)).length;
    viewer.entities.add = add;
    viewer.entities.remove = remove;
    return {
      chunkPoints: CHUNK_POINTS,
      diagnostics,
      frozenBefore: before.frozen.length,
      baseline,
      frames,
      resolvedAt,
      frozenAfterClear,
      entities: added.length,
      leaked,
    };
  });

  if (process.env.GEV_TEST_VERBOSE)
    console.log(JSON.stringify(result.diagnostics));
  const minPixels = Math.min(...result.frames.map((frame) => frame.pixels));
  report(
    'the trail draws before the freeze',
    result.baseline > 200 && result.frozenBefore === 0,
    `baseline=${result.baseline} trail pixels, frozen chunks=${result.frozenBefore}`,
  );
  report(
    'the frozen chunk reaches the scene as static geometry',
    result.resolvedAt != null,
    `stand-in dropped after ${result.resolvedAt} frames`,
  );
  report(
    'every frame after the freeze draws the frozen chunk (dynamic copy or static geometry)',
    result.frames.every((frame) => frame.covered),
    `${result.frames.length} frames checked`,
  );
  report(
    'no blank frame: trail pixels never drop below 90% of the pre-freeze count',
    minPixels >= 0.9 * result.baseline,
    `min=${minPixels} baseline=${result.baseline}`,
  );
  report(
    'clearing and destroying release every trail entity',
    result.frozenAfterClear === 0 && result.leaked === 0,
    `entities created=${result.entities} leaked=${result.leaked}`,
  );
} catch (error) {
  report('gate ran', false, error.message);
} finally {
  await browser.close();
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
