#!/usr/bin/env node
/** Check every rendered frame across a trail chunk boundary on either engine.
 * Requires a dev server: node scripts/qa-trail-freeze.mjs --url http://localhost:4312
 */
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import { waitForEngine } from './qa-strict-harness.mjs';
import { evaluateWithGeo } from './qa/geometry.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';

const urlFlag = process.argv.indexOf('--url');
const url = urlFlag > 0 ? process.argv[urlFlag + 1] : 'http://localhost:4312';
const browser = await launchBrowser({ protocolTimeout: 300_000 });
let failed = false;
const report = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} ${detail}`);
};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 640 });
  await blockPaidQaMaps(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForEngine(page);
  const result = await evaluateWithGeo(page, async (geo) => {
    const { createTrail, CHUNK_POINTS } =
      await import('/src/data/trailRenderer.js');
    const { engine } = window.__godsEyeView;
    engine.camera.cancelFlight();
    const camera = engine.camera.pose();
    const ahead = geo.cartesian3.add(
      camera.position,
      geo.cartesian3.multiplyByScalar(camera.direction, 3000),
    );
    const points = Array.from({ length: CHUNK_POINTS + 1 }, (_, index) =>
      geo.cartesian3.add(
        ahead,
        geo.cartesian3.multiplyByScalar(
          camera.right,
          -1200 + (2400 * index) / CHUNK_POINTS,
        ),
      ),
    );
    const gl =
      engine.host.canvas.getContext('webgl2') ||
      engine.host.canvas.getContext('webgl');
    const pixels = new Uint8Array(
      gl.drawingBufferWidth * gl.drawingBufferHeight * 4,
    );
    const nextFrame = () =>
      new Promise((resolve) => {
        const remove = engine.frames.postRender.addEventListener(() => {
          remove();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(
            0,
            0,
            gl.drawingBufferWidth,
            gl.drawingBufferHeight,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels,
          );
          let count = 0;
          for (let p = 0; p < pixels.length; p += 4)
            if (pixels[p] > 150 && pixels[p + 2] > 150 && pixels[p + 1] < 110)
              count++;
          resolve(count);
        });
        engine.render.request('qa-trail-freeze');
      });
    const beforeIds = new Set(engine.lines.list().map(({ id }) => id));
    const ids = new Map();
    const createLine = engine.lines.createLine;
    engine.lines.createLine = (options) => {
      const line = createLine(options);
      ids.set(line, options.id);
      return line;
    };
    const trail = createTrail(engine, { color: '#ff00ff', width: 8 });
    try {
      trail.setPositions(points.slice(0, CHUNK_POINTS));
      for (let i = 0; i < 20; i++) await nextFrame();
      const frozenBefore = trail._chunksForTest().frozen.length;
      let baseline = 0;
      for (let i = 0; i < 5; i++)
        baseline = Math.max(baseline, await nextFrame());
      trail.setPositions(points);
      const frames = [];
      for (let i = 0; i < 60; i++) {
        const pixels = await nextFrame();
        const lines = engine.lines.list();
        const covered = trail
          ._chunksForTest()
          .frozen.every(({ line }) =>
            lines.some(
              (drawn) =>
                drawn.id === ids.get(line) &&
                drawn.shown &&
                drawn.points >= CHUNK_POINTS,
            ),
          );
        frames.push({ covered, pixels });
      }
      const frozen = trail._chunksForTest().frozen.length;
      trail.clear();
      await nextFrame();
      const frozenAfterClear = trail._chunksForTest().frozen.length;
      trail.destroy();
      return {
        baseline,
        frozenBefore,
        frozen,
        frames,
        frozenAfterClear,
        leaked: engine.lines.list().filter(({ id }) => !beforeIds.has(id))
          .length,
      };
    } finally {
      trail.destroy();
      engine.lines.createLine = createLine;
    }
  });
  report(
    'the trail draws before the freeze',
    result.baseline > 200 && result.frozenBefore === 0,
    `pixels=${result.baseline}`,
  );
  report('the chunk freezes into a retained line', result.frozen > 0);
  report(
    'every frame retains the frozen chunk',
    result.frames.every(({ covered }) => covered),
  );
  report(
    'no blank frame across the chunk boundary',
    result.frames.every(({ pixels }) => pixels >= result.baseline * 0.9),
  );
  report(
    'clearing and destroying release all chunks',
    result.frozenAfterClear === 0 && result.leaked === 0,
  );
} catch (error) {
  report('gate ran', false, error.stack);
} finally {
  await closeBrowser(browser);
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exitCode = failed ? 1 : 0;
