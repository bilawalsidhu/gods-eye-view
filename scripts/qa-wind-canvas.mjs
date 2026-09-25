/** Real-canvas wind regression. Run against this candidate's dev server. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  headless: false,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.goto(`${process.env.QA_BASE_URL || 'http://localhost:4173'}/`, {
    waitUntil: 'domcontentloaded',
  });
  const result = await page.evaluate(async () => {
    const { createWindRendering } =
      await import('/src/layers/wind/rendering.js');
    const raf = window.requestAnimationFrame;
    const caf = window.cancelAnimationFrame;
    const callbacks = new Map();
    let sequence = 0;
    window.requestAnimationFrame = (callback) => {
      callbacks.set(++sequence, callback);
      return sequence;
    };
    window.cancelAnimationFrame = (id) => callbacks.delete(id);
    const container = document.createElement('div');
    container.style.cssText =
      'position:fixed;left:0;top:0;width:800px;height:600px;z-index:9999;background:#102030';
    document.body.appendChild(container);
    const sceneCanvas = { clientWidth: 800, clientHeight: 600 };
    const viewer = {
      scene: { canvas: sceneCanvas, camera: {} },
      isDestroyed: () => false,
    };
    const cesium = {
      Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
      SceneTransforms: {
        worldToWindowCoordinates: (scene, point) => ({
          x: 400 + point.lon,
          y: 300 + point.lat,
        }),
      },
    };
    const rendering = createWindRendering({
      cesium,
      container,
      getViewer: () => viewer,
    });
    try {
      rendering.attach();
      rendering.start();
      const idleCallbacks = callbacks.size;
      rendering.setField({
        grid: { nx: 1, ny: 1, lo1: 0, la1: 90, dx: 360, dy: 180 },
        u: new Float32Array([10]),
        v: new Float32Array([0]),
      });
      const canvas = container.querySelector('canvas');
      const context = canvas.getContext('2d');
      const tick = (time) => {
        const [id, callback] = callbacks.entries().next().value;
        callbacks.delete(id);
        callback(time);
      };
      tick(16); // First camera signature clears the surface.
      context.fillStyle = '#ff0000';
      context.fillRect(10, 10, 5, 5);
      tick(32);
      const alpha = context.getImageData(12, 12, 1, 1).data[3];
      const count = rendering.getParticleCount();
      sceneCanvas.clientWidth = 320;
      sceneCanvas.clientHeight = 240;
      tick(48);
      const resizedCount = rendering.getParticleCount();
      rendering.stop();
      rendering.clear();
      return {
        idleCallbacks,
        alpha,
        count,
        resizedCount,
        pending: callbacks.size,
        afterClear: context.getImageData(12, 12, 1, 1).data[3],
      };
    } finally {
      rendering.destroy();
      container.remove();
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = caf;
    }
  });
  assert.equal(result.idleCallbacks, 0);
  assert.ok(
    result.alpha > 200,
    'unchanged canvas dimensions preserve existing trail pixels',
  );
  assert.ok(result.resizedCount < result.count);
  assert.equal(result.pending, 0);
  assert.equal(result.afterClear, 0);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
