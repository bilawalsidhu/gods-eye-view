#!/usr/bin/env node
/** Real-app zoom and tilt regression. Start a dev server, then run this file. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : [
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ]),
  ],
  protocolTimeout: 120_000,
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto(`${origin}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      window.__godsEyeView.viewer.scene.screenSpaceCameraController
        .enableInputs &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000 },
  );
  const renderer = await page.evaluate(async () => {
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    const { maxPitchForHeight } = await import('/src/app/zoomOutGuard.js');
    const { readCameraTargetFrame } =
      await import('/src/ui/cameraOrientationControls.js');
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight();
    viewer.trackedEntity = undefined;
    // Explicit real renders make each gesture independent of host frame rate.
    viewer.useDefaultRenderLoop = false;
    const controller = viewer.scene.screenSpaceCameraController;
    controller.inertiaZoom = 0;
    controller.inertiaSpin = 0;
    const original = viewer.camera.setView.bind(viewer.camera);
    const qa = {
      viewer,
      guardWrites: 0,
      targetPitch: () => readCameraTargetFrame(viewer)?.pitch,
      history: [],
      frame() {
        viewer.scene.requestRender();
        viewer.render();
        qa.history.push({
          height: viewer.camera._positionCartographic.height,
          guardWrites: qa.guardWrites,
          position: { ...viewer.camera.position },
        });
        if (qa.history.length > 80) qa.history.shift();
      },
      pose() {
        return {
          height: viewer.camera.positionCartographic.height,
          pitch: viewer.camera.pitch,
          maxPitch: maxPitchForHeight(
            viewer.camera.positionCartographic.height,
          ),
          guardWrites: qa.guardWrites,
        };
      },
      reset(height = 1_000_000, pitch = -35) {
        viewer.camera.cancelFlight();
        viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
        original({
          destination: C.Cartesian3.fromDegrees(0, 0, height),
          orientation: { heading: 0, pitch: C.Math.toRadians(pitch), roll: 0 },
        });
        qa.frame();
        qa.guardWrites = 0;
      },
    };
    viewer.camera.setView = (options) => {
      // Cesium itself also calls setView while processing touch movement.
      if (new Error().stack.includes('/src/app/zoomOutGuard.js'))
        qa.guardWrites++;
      return original(options);
    };
    window.__zoomGuardQa = qa;
    const gl = viewer.scene.context._gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  console.log(`[INFO] WebGL renderer: ${renderer}`);
  const frame = (count = 1) =>
    page.evaluate(async (n) => {
      for (let i = 0; i < n; i++) {
        window.__zoomGuardQa.frame();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return window.__zoomGuardQa.pose();
    }, count);
  const reset = (height, pitch) =>
    page.evaluate((h, p) => window.__zoomGuardQa.reset(h, p), height, pitch);
  const session = await page.createCDPSession();
  for (const viewport of [
    { width: 1200, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewport(viewport);
    await page.evaluate(() => window.__zoomGuardQa.viewer.resize());
    const x = Math.round(viewport.width / 2);
    const y = Math.round(viewport.height / 2);
    await reset(1_000_000, -25);
    await page.mouse.move(x, y);
    await page.evaluate(
      ({ x, y }) => {
        window.__zoomGuardQa.viewer.canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 2400,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { x, y },
    );
    const first = await frame();
    console.log(`[INFO] ${viewport.width}px wheel delivered`);
    const settled = await frame(40);
    assert.ok(first.height > 1_000_000, 'wheel must move the real camera');
    assert.ok(settled.guardWrites > 0, 'zoom guard must run');
    assert.ok(
      settled.pitch <= settled.maxPitch + 1e-6,
      `stationary pitch must finish easing: ${JSON.stringify(settled)}`,
    );
    for (let i = 0; i < 12; i++) {
      await page.evaluate(
        ({ x, y }) => {
          window.__zoomGuardQa.viewer.canvas.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: 2400,
              clientX: x,
              clientY: y,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        { x, y },
      );
      await frame();
    }
    const ceiling = await frame(40);
    assert.ok(ceiling.height <= 40_000_001, 'user zoom respects the ceiling');
    assert.ok(
      ceiling.height > 39_000_000,
      'exercise the ceiling, not a low orbit',
    );
    assert.ok(
      ceiling.pitch <= ceiling.maxPitch + 1e-6,
      `ceiling must settle: ${JSON.stringify(await page.evaluate(() => window.__zoomGuardQa.history))}`,
    );
    console.log(
      `[PASS] ${viewport.width}px wheel, stationary easing and ceiling`,
    );
    if (process.env.QA_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.QA_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(
          process.env.QA_SCREENSHOT_DIR,
          `zoom-ceiling-${viewport.width}.png`,
        ),
      });
    }

    await reset();
    await page.mouse.move(x, y);
    await page.keyboard.down('Control');
    await page.mouse.down({ button: 'right' });
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(x, y + i * 3);
      await frame();
    }
    await page.mouse.up({ button: 'right' });
    await page.keyboard.up('Control');
    const tilted = await frame(3);
    assert.equal(
      tilted.guardWrites,
      0,
      'Ctrl+right tilt must not trigger guard',
    );
    assert.ok(Math.abs(tilted.height - 1_000_000) > 1, 'tilt must move camera');

    await reset();
    const touches = (dy) => [
      { x: x - 60, y: y + dy, id: 1 },
      { x: x + 60, y: y + dy, id: 2 },
    ];
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: touches(0),
    });
    await frame();
    for (let i = 1; i <= 6; i++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: touches(i * 3),
      });
      await frame();
    }
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    const translated = await frame(3);
    assert.equal(
      translated.guardWrites,
      0,
      'parallel two-finger tilt must not trigger guard',
    );
    assert.ok(
      Math.abs(translated.height - 1_000_000) > 1,
      'touch tilt must move camera',
    );
    console.log(
      `[PASS] ${viewport.width}px Ctrl+right and parallel touch tilt`,
    );
    await reset(1_000_000, -35);
    await page.evaluate(
      ({ x, y }) => {
        window.__zoomGuardQa.viewer.canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 120,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { x, y },
    );
    const beforeTilt = await frame();
    assert.ok(
      beforeTilt.guardWrites > 0,
      'wheel correction must be pending before UI tilt',
    );
    const targetPitchBeforeClick = await page.evaluate(() =>
      window.__zoomGuardQa.targetPitch(),
    );
    assert.ok(
      Number.isFinite(targetPitchBeforeClick),
      'UI tilt fixture must have a ground target under the canvas center',
    );
    // Programmatic fixture resets precede moveEnd, so the button's published
    // aria state may still describe the previous view. The action toggles the
    // current target frame: angles shallower than -60 degrees are tilted.
    const wasTilted = targetPitchBeforeClick > -Math.PI / 3;
    await page.click('#tilt-map-view');
    const uiTilt = await page.evaluate(
      async (desiredDegrees) => {
        const qa = window.__zoomGuardQa;
        const desired = (desiredDegrees * Math.PI) / 180;
        const started = performance.now();
        const deadline = started + 3000;
        while (performance.now() < deadline) {
          qa.frame();
          // The 650 ms animator can be numerically near its destination
          // before it releases preUpdate. Finish its lifetime before resetting.
          if (
            performance.now() - started >= 700 &&
            Math.abs(qa.targetPitch() - desired) < 1e-5
          )
            return { settled: true, guardWrites: qa.guardWrites };
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        return {
          settled: false,
          guardWrites: qa.guardWrites,
          pitch: qa.targetPitch(),
        };
      },
      wasTilted ? -89 : -35,
    );
    assert.ok(
      uiTilt.settled,
      `UI tilt must reach its destination: ${JSON.stringify(uiTilt)}`,
    );
    assert.equal(
      uiTilt.guardWrites,
      beforeTilt.guardWrites,
      'UI navigation handoff must cancel pending zoom correction',
    );
    console.log(
      `[PASS] ${viewport.width}px UI tilt takes over a pending wheel correction`,
    );

    await reset(1_000_000, -25);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: touches(0),
    });
    await frame();
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - 35, y, id: 1 },
        { x: x + 35, y, id: 2 },
      ],
    });
    await frame();
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    const pinched = await frame(40);
    assert.ok(pinched.height > 1_000_000, 'pinch-out must move camera outward');
    assert.ok(pinched.guardWrites > 0, 'pinch-out must trigger the guard');
    assert.ok(pinched.pitch <= pinched.maxPitch + 1e-6);
    console.log(`[PASS] ${viewport.width}px pinch-out settles below the limb`);
  }
  assert.deepEqual(errors, [], 'no JavaScript page errors');
  console.log('[PASS] no JavaScript page errors');
} finally {
  await browser.close();
}
