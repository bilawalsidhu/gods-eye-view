#!/usr/bin/env node
/**
 * Lit airplane regression: StarrySky must match a black environment baseline.
 * A white environment is a positive control: it must visibly brighten the
 * same model. Each case uses a fresh scene and dynamic environment map.
 * Usage: node scripts/qa-sky-model-lighting.mjs [--url http://localhost:4333/]
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const i = process.argv.indexOf('--url');
const base = i > 0 ? process.argv[i + 1] : 'http://localhost:4333/';
const url = new URL('/__qa_sky_model__', base);
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log('PAGEERR', error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url() === url.href)
      request.respond({
        contentType: 'text/html',
        body: '<!doctype html><html><body></body></html>',
      });
    else if (new URL(request.url()).origin !== url.origin) request.abort();
    else request.continue();
  });
  await page.goto(url.href);
  const results = await page.evaluate(async () => {
    window.CESIUM_BASE_URL = '/cesium/';
    // Use StarrySky's exact Vite dependency URL, including its version query.
    const source = await fetch('/src/sky/starrySky.js').then((r) => r.text());
    const cesiumUrl = source.match(
      /from ["']([^"']*\/cesium\.js[^"']*)["']/,
    )?.[1];
    if (!cesiumUrl) throw new Error('run against the Vite dev server');
    const C = await import(cesiumUrl);
    const { StarrySky } = await import('/src/sky/starrySky.js');
    const time = C.JulianDate.fromIso8601('2026-10-19T00:00:00Z');
    const results = {};
    for (const kind of ['black', 'starry', 'white']) {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      document.body.append(canvas);
      const scene = new C.Scene({ canvas });
      scene.rethrowRenderErrors = true;
      let cubeMap;
      try {
        scene.backgroundColor = C.Color.BLACK;
        scene.light = new C.DirectionalLight({
          direction: new C.Cartesian3(1, 0, 0),
          intensity: 0.2,
        });
        if (kind === 'starry') {
          scene.skyBox = new StarrySky({ requestRender() {} });
          scene.skyBox._loading = true; // visible sky is outside this probe
        } else {
          const value = kind === 'white' ? 255 : 0;
          const face = {
            width: 1,
            height: 1,
            arrayBufferView: new Uint8Array([value, value, value, 255]),
          };
          cubeMap = new C.CubeMap({
            context: scene.context,
            source: Object.fromEntries(
              [...C.CubeMap.faceNames()].map((name) => [name, face]),
            ),
          });
          scene.skyBox = { _cubeMap: cubeMap, update() {}, destroy() {} };
        }
        const position = C.Cartesian3.fromDegrees(0, 0, 10000);
        const model = await C.Model.fromGltfAsync({
          url: '/models/airplane.glb',
          modelMatrix: C.Transforms.eastNorthUpToFixedFrame(position),
        });
        scene.primitives.add(model);
        scene.camera.lookAt(position, new C.HeadingPitchRange(0.4, -0.5, 45));
        let framed = false;
        for (let frame = 0; frame < 240; frame++) {
          scene.initializeFrame();
          scene.render(time);
          if (model.ready && !framed) {
            scene.camera.viewBoundingSphere(
              model.boundingSphere,
              new C.HeadingPitchRange(
                0.4,
                -0.5,
                model.boundingSphere.radius * 3,
              ),
            );
            framed = true;
          }
          await new Promise(requestAnimationFrame);
        }
        if (!model.ready || !model.environmentMapManager.radianceCubeMap)
          throw new Error(`${kind}: model or dynamic lighting did not load`);
        scene.initializeFrame();
        scene.render(time);
        const gl = scene.context._gl;
        const px = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(
          0,
          0,
          canvas.width,
          canvas.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          px,
        );
        let total = 0;
        let visible = 0;
        for (let p = 0; p < px.length; p += 4) {
          const luma = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
          total += luma;
          if (luma > 1) visible++;
        }
        results[kind] = { total, visible };
      } finally {
        scene.destroy();
        cubeMap?.destroy();
        canvas.remove();
      }
    }
    return results;
  });
  console.log(JSON.stringify(results));
  assert.ok(results.black.visible > 100, 'the lit model must be visible');
  assert.ok(
    Math.abs(results.starry.total - results.black.total) <=
      results.black.total * 0.01,
    'StarrySky must match black environment lighting within 1%',
  );
  assert.ok(
    results.white.total > results.black.total * 1.03,
    'white environment control must brighten the model by at least 3%',
  );
  console.log(
    'PASS: lit airplane matches black sky; white control is brighter',
  );
} finally {
  await browser.close();
}
