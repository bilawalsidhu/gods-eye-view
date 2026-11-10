import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { hookRenderErrors, readRenderErrors } from './qa-browserEvidence.mjs';
const url = process.argv[2] || 'http://127.0.0.1:4182';
const out = process.argv[3] || 'qa-artifacts/aircraft-surface/verification';
await fs.mkdir(out, { recursive: true });
const report = { checks: [], errors: [] };
const check = (name, pass) => {
  report.checks.push({ name, pass: !!pass });
  assert.ok(pass, name);
};
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });
  await hookRenderErrors(page);
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input.url,
        location.href,
      );
      const json = (value) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      if (url.pathname === '/api/flights') {
        const t = Math.floor(Date.now() / 1000);
        return json({
          time: t,
          states: Array.from({ length: 200 }, (_, i) => [
            (0xc00000 + i).toString(16),
            `SHARP${i}`,
            'Fixture',
            t,
            t,
            -123.5 + (i % 20) * 0.14,
            37 + Math.floor(i / 20) * 0.3,
            10000,
            false,
            0,
            (i * 31) % 360,
            0,
            null,
            10000,
            null,
            false,
            0,
          ]),
        });
      }
      if (url.pathname === '/api/military') return json({ ac: [] });
      if (/^\/api\/adsbdb\//.test(url.pathname)) return json({});
      return real(input, init);
    };
  });
  await page.goto(
    `${url}/?welcome=0#v=2&lat=38.4&lon=-122&alt=534030&heading=0&pitch=-90&roll=0&style=normal&bloom=0&sharpen=1&map=esri-imagery&l=f`,
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    if (!window.Cesium)
      window.Cesium =
        await import('/node_modules/cesium/Build/Cesium/index.js');
  });
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.performance.ready;
    a.dataManager.layers.get('flights').module.setParams({ models3d: false });
    await a.dataManager.setEnabled('flights', true, { origin: 'user' });
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.viewer.gevAircraftSurfaceDiagnostics?.()?.drawn >
      100,
    { timeout: 30000 },
  );
  await wait(2000);
  report.initial = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer,
      c = document.querySelector('.gev-aircraft-surface');
    return {
      surface: { ...v.gevAircraftSurfaceDiagnostics() },
      mapRatio: v.scene.drawingBufferWidth / v.scene.canvas.clientWidth,
      surfaceRatio: c.width / c.clientWidth,
      glError: c.getContext('webgl2').getError(),
    };
  });
  check(
    'aircraft use full Retina resolution while the map stays at 1x',
    report.initial.mapRatio === 1 && report.initial.surfaceRatio === 2,
  );
  check('batched surface has no WebGL errors', report.initial.glError === 0);
  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    window.__surfacePolicy = v.gevAircraftSurfaceEnabled;
    v.gevAircraftSurfaceEnabled = () => false;
    v.resolutionScale = 1.5;
    v.resize();
  });
  await wait(800);
  await page.screenshot({ path: `${out}/before.png` });
  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    v.gevAircraftSurfaceEnabled = window.__surfacePolicy;
    v.resolutionScale = v.gevStandardResolutionScale;
    v.resize();
  });
  await wait(800);
  await page.screenshot({ path: `${out}/after.png` });
  report.picks = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer,
      result = [];
    const visit = (c) => {
      for (let i = 0; i < c.length; i++) {
        const p = c.get(i);
        if (Number.isFinite(p.renderedCount)) {
          for (let j = 0; j < p.length && result.length < 5; j++) {
            const b = p.get(j);
            if (!b.show || !b.viewportVisible) continue;
            const point = Cesium.SceneTransforms.worldToWindowCoordinates(
              v.scene,
              b.position,
            );
            if (
              !point ||
              point.x < 200 ||
              point.y < 200 ||
              point.x > 1200 ||
              point.y > 650
            )
              continue;
            const picked = v.scene.pick(point);
            if (picked?.id === b.id)
              result.push({ id: b.id, x: point.x, y: point.y });
          }
        } else if (typeof p.get === 'function' && Number.isInteger(p.length))
          visit(p);
      }
    };
    visit(v.scene.primitives);
    return result;
  });
  check(
    'native Cesium picking retains five aircraft identities',
    report.picks.length === 5,
  );
  const target = report.picks[0];
  await page.mouse.click(target.x, target.y);
  await wait(300);
  await page.evaluate(() =>
    window.__godsEyeView.viewer.camera.moveBackward(1000000),
  );
  await wait(1200);
  report.tracked = await page.evaluate(() => {
    const a = window.__godsEyeView,
      v = a.viewer,
      e = v.trackedEntity;
    const point =
      e &&
      Cesium.SceneTransforms.worldToWindowCoordinates(
        v.scene,
        e.position.getValue(v.clock.currentTime),
      );
    const picked = point && v.scene.pick(point);
    return {
      id: a.dataManager.layers.get('flights').module.getTrackedInfo()?.icao24,
      entityFollow: !!e,
      overlayOwned: e?.billboard?.show?.getValue(v.clock.currentTime) === false,
      pickedEntity: picked?.id === e,
      pickedId: typeof picked?.id === 'object' ? picked.id.id : picked?.id,
      cameraHeight: v.camera.positionCartographic.height,
      anchorReady:
        e &&
        v.dataSourceDisplay.getBoundingSphere(
          e,
          false,
          new Cesium.BoundingSphere(),
        ) === Cesium.BoundingSphereState.DONE,
      surface: v.gevAircraftSurfaceDiagnostics(),
    };
  });
  check(
    'click starts the original follow-camera tracking',
    report.tracked.id === target.id && report.tracked.entityFollow,
  );
  check(
    'tracked 2D aircraft is sharp and keeps its native entity pick',
    report.tracked.overlayOwned && report.tracked.pickedEntity,
  );
  check(
    'tracked entity retains the bounding sphere required by Cesium follow-camera updates',
    report.tracked.anchorReady,
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    a.performance.setMode('low', { persist: false });
    await a.performance.whenSettled();
  });
  await wait(500);
  check(
    'low mode restores the tracked native visual and follow anchor',
    await page.evaluate(() => {
      const v = window.__godsEyeView.viewer,
        e = v.trackedEntity;
      return (
        !!e &&
        e.point === undefined &&
        e.billboard.show?.getValue(v.clock.currentTime) !== false &&
        v.dataSourceDisplay.getBoundingSphere(
          e,
          false,
          new Cesium.BoundingSphere(),
        ) === Cesium.BoundingSphereState.DONE
      );
    }),
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    a.performance.setMode('standard', { persist: false });
    await a.performance.whenSettled();
  });
  await wait(500);
  check(
    'normal mode resumes the sharp tracked visual without changing selection',
    await page.evaluate((id) => {
      const a = window.__godsEyeView,
        e = a.viewer.trackedEntity;
      return (
        a.dataManager.layers.get('flights').module.getTrackedInfo()?.icao24 ===
          id &&
        e?.billboard.show?.getValue(a.viewer.clock.currentTime) === false &&
        e.point?.color.getValue(a.viewer.clock.currentTime).alpha === 0
      );
    }, target.id),
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('flights')
      .module.stopTracking(),
  );
  await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 1 });
  await wait(600);
  check(
    'moving to a 1x display updates the sharp surface',
    await page.evaluate(() => {
      const c = document.querySelector('.gev-aircraft-surface');
      return c.width === c.clientWidth;
    }),
  );
  await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });
  await wait(600);
  check(
    'returning to Retina restores full display resolution',
    await page.evaluate(() => {
      const c = document.querySelector('.gev-aircraft-surface');
      return c.width === c.clientWidth * 2;
    }),
  );
  for (const height of [20000, 100000, 1000000, 10000000]) {
    await page.evaluate((height) => {
      const v = window.__godsEyeView.viewer;
      v.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-123.5, 38.5, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, height);
    await wait(700);
    check(
      `sharp aircraft remain active at ${height} m camera height`,
      await page.evaluate(() => {
        const v = window.__godsEyeView.viewer,
          c = document.querySelector('.gev-aircraft-surface');
        return (
          v.gevAircraftSurfaceDiagnostics().drawn > 0 &&
          c?.width === c?.clientWidth * devicePixelRatio
        );
      }),
    );
  }
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setStyle('thermal', {
      applyPreset: false,
    }),
  );
  await wait(1500);
  check(
    'cinematic styles retain native compositing',
    await page.evaluate(() => !document.querySelector('.gev-aircraft-surface')),
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setStyle('normal', {
      applyPreset: false,
    }),
  );
  await wait(1500);
  check(
    'returning to normal restores the sharp layer',
    await page.evaluate(
      () => window.__godsEyeView.viewer.gevAircraftSurfaceDiagnostics().active,
    ),
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    a.performance.setMode('low', { persist: false });
    await a.performance.whenSettled();
  });
  await wait(500);
  check(
    'low mode releases the extra surface',
    await page.evaluate(
      () =>
        !document.querySelector('.gev-aircraft-surface') &&
        !window.__godsEyeView.viewer.gevAircraftSurfaceDiagnostics().active,
    ),
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    a.performance.setMode('standard', { persist: false });
    await a.performance.whenSettled();
  });
  await wait(1000);
  check(
    'normal mode recreates one shared sharp surface',
    await page.evaluate(
      () =>
        document.querySelectorAll('.gev-aircraft-surface').length === 1 &&
        window.__godsEyeView.viewer.gevAircraftSurfaceDiagnostics().active,
    ),
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.dataManager.setEnabled('flights', false, { origin: 'user' });
  });
  await wait(500);
  check(
    'disabling aircraft releases the surface',
    await page.evaluate(() => !document.querySelector('.gev-aircraft-surface')),
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.dataManager.setEnabled('flights', true, { origin: 'user' });
  });
  await wait(1500);
  check(
    're-enabling aircraft restores sharp rendering',
    await page.evaluate(
      () => window.__godsEyeView.viewer.gevAircraftSurfaceDiagnostics().active,
    ),
  );
  await page.evaluate(() =>
    document
      .querySelector('.gev-aircraft-surface')
      .getContext('webgl2')
      .getExtension('WEBGL_lose_context')
      .loseContext(),
  );
  await wait(800);
  check(
    'overlay context loss restores native rendering without losing the map',
    await page.evaluate(() => {
      const v = window.__godsEyeView.viewer;
      return (
        !document.querySelector('.gev-aircraft-surface') &&
        !v.gevAircraftSurfaceDiagnostics().active &&
        !v.scene.context._gl.isContextLost()
      );
    }),
  );
  report.errors.push(...(await readRenderErrors(page)));
  check('no JavaScript or Cesium render errors', report.errors.length === 0);
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await fs.writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
