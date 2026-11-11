#!/usr/bin/env node
/**
 * qa-anime-sky — the anime style must leave the sky without bands.
 *
 * Anime's luminance bands turn the faint Milky Way into blotches, so
 * src/ui/visualEffects.js fades the glow out with the style. Headless against
 * a Vite dev server, both sky assets must be ready. Normal must show the
 * Galactic Centre glow (at least 2 % of pixels at luma >= 10/255), then
 * Anime must retain stars while at most 0.5 % reaches the first cel band.
 * The Normal baseline measured 43 % in headless Chromium at 1000×700;
 * the 2 % floor leaves room for GPU differences while rejecting a black sky.
 *
 * Usage: node scripts/qa-anime-sky.mjs [--url http://localhost:4333/]
 * Exit: 0 pass, 1 fail, 2 the anime style was not reached.
 */
import puppeteer from 'puppeteer';

const i = process.argv.indexOf('--url');
const URL_ =
  i > 0 && process.argv[i + 1] ? process.argv[i + 1] : 'http://localhost:4333/';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    if (host.endsWith('halfpixel.ai') || host.includes('worldfx'))
      request.abort();
    else request.continue();
  });
  page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
  await page.setViewport({ width: 1000, height: 700 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.viewer?.scene, {
    timeout: 120000,
  });
  await page.waitForFunction(
    () => {
      const sky = window.__godsEyeView.viewer.scene.skyBox;
      return (
        sky?._milkyWayCubeMap &&
        sky?._starCommand &&
        document.getElementById('loading-screen')?.classList.contains('hidden')
      );
    },
    { timeout: 60000 },
  );
  const r = await page.evaluate(async () => {
    const entry = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /\.vite\/deps\/cesium\.js/.test(n));
    if (!entry)
      throw new Error(
        'run against the Vite dev server (needs .vite/deps/cesium.js)',
      );
    const C = await import(entry),
      g = window.__godsEyeView,
      v = g.viewer,
      s = v.scene;
    g.styleManager.setStyle('normal', { userInitiated: true });
    const t = v.clock.currentTime;
    await C.Transforms.preloadIcrfFixed(
      new C.TimeInterval({
        start: C.JulianDate.addDays(t, -1, new C.JulianDate()),
        stop: C.JulianDate.addDays(t, 1, new C.JulianDate()),
      }),
    );
    const m = C.Transforms.computeIcrfToFixedMatrix(t);
    const ra = C.Math.toRadians(266.4),
      dec = C.Math.toRadians(-29);
    const look = C.Matrix3.multiplyByVector(
      m,
      new C.Cartesian3(
        Math.cos(dec) * Math.cos(ra),
        Math.cos(dec) * Math.sin(ra),
        Math.sin(dec),
      ),
      new C.Cartesian3(),
    );
    const north = C.Matrix3.multiplyByVector(
      m,
      C.Cartesian3.UNIT_Z,
      new C.Cartesian3(),
    );
    const right = C.Cartesian3.normalize(
      C.Cartesian3.cross(look, north, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    s.camera.cancelFlight();
    s.tweens.removeAll();
    s.camera.setView({
      destination: C.Cartesian3.multiplyByScalar(look, 3e7, new C.Cartesian3()),
      orientation: {
        direction: look,
        up: C.Cartesian3.cross(right, look, new C.Cartesian3()),
      },
    });
    const gl = s.context._gl,
      w = gl.drawingBufferWidth,
      h = gl.drawingBufferHeight,
      px = new Uint8Array(w * h * 4);
    const measure = async () => {
      await new Promise((res) => setTimeout(res, 2500));
      s.requestRender();
      s.render();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let banded = 0;
      let visible = 0;
      for (let i = 0; i < px.length; i += 4) {
        const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        if (luma >= 51) banded++;
        if (luma >= 10) visible++;
      }
      return { banded, visible };
    };
    const normal = await measure();
    g.styleManager.setStyle('anime', { userInitiated: true });
    const anime = await measure();
    let animeOn = false;
    for (let i = 0; i < s.postProcessStages.length; i++) {
      const stage = s.postProcessStages.get(i);
      if (stage.name === 'godsEyeView_anime')
        animeOn = stage.enabled && stage.uniforms.intensity > 0.99;
    }
    return {
      total: px.length / 4,
      normal,
      ...anime,
      assetsReady: Boolean(s.skyBox._milkyWayCubeMap && s.skyBox._starCommand),
      visibility: s.skyBox.milkyWayVisibility,
      animeOn,
    };
  });
  const tag =
    !r.animeOn || !r.assetsReady
      ? 'UNREACHED'
      : r.normal.visible >= 0.02 * r.total &&
          r.banded > 0 &&
          r.banded <= 0.005 * r.total &&
          r.visibility === 0
        ? 'PASS'
        : 'FAIL';
  console.log(
    `${tag}: ${r.banded} of ${r.total} sky pixels at or above the first cel band (luma >= 0.2)\n     ${JSON.stringify(r)}`,
  );
  process.exitCode = tag === 'PASS' ? 0 : tag === 'FAIL' ? 1 : 2;
} catch (error) {
  console.error(`UNREACHED: ${error.message}`);
  process.exitCode = 2;
} finally {
  await browser.close();
}
