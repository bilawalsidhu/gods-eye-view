#!/usr/bin/env node
/**
 * Real-app regression: the wheel zooms with an over-depth icon under the
 * centre of the canvas. Start a dev server (`npm run dev`), then run this
 * file with QA_BASE_URL set to it.
 *
 * Below 150 km Cesium sizes a zoom step from the depth it picks at the canvas
 * centre. An icon drawn over depth must leave nothing there for that pick, or
 * the camera takes the icon (a metre away, on the near plane) for the ground
 * and stops zooming.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const CAMERA_HEIGHT_M = 15_000;
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
  const viewport = { width: 1200, height: 800 };
  await page.setViewport(viewport);
  await page.goto(`${origin}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      window.__godsEyeView.viewer.scene.screenSpaceCameraController
        .enableInputs &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000 },
  );
  const setup = await page.evaluate(async (cameraHeight) => {
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    const { drawOf } = await import('/src/render/rendererOf.js');
    const viewer = window.__godsEyeView.viewer;
    const scene = viewer.scene;
    viewer.camera.cancelFlight();
    viewer.trackedEntity = undefined;
    // Explicit real renders make each gesture independent of host frame rate.
    viewer.useDefaultRenderLoop = false;
    const controller = scene.screenSpaceCameraController;
    controller.inertiaZoom = 0;
    controller.inertiaSpin = 0;
    const lon = -30;
    const lat = 40; // open Atlantic: nothing else of the app's draws here
    const icons = drawOf(viewer).icons({ id: 'qa-zoom-under-icon' });
    const item = {
      id: 'qa-icon',
      pos: C.Cartesian3.fromDegrees(lon, lat, 100),
      // Held in place on the GPU, as a live aircraft or vessel icon is.
      motion: { kind: 'hold', courseDeg: 0 },
      image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#f0f"/></svg>',
      )}`,
      size: [64, 64],
      disableDepthTest: Infinity,
    };
    const centre = () =>
      new C.Cartesian2(
        scene.canvas.clientWidth / 2,
        scene.canvas.clientHeight / 2,
      );
    const frame = () => {
      scene.requestRender();
      viewer.render();
    };
    const qa = {
      height: () => viewer.camera.positionCartographic.height,
      setIcon(shown) {
        icons.set(shown ? [item] : []);
      },
      reset() {
        viewer.camera.cancelFlight();
        viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
        viewer.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, cameraHeight),
          orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
        });
        frame();
      },
      async frames(count) {
        for (let i = 0; i < count; i++) {
          frame();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return qa.height();
      },
      /** Whether the icon is what a click at the canvas centre picks. */
      iconAtCentre() {
        const picked = scene.pick(centre());
        return JSON.stringify(picked?.id ?? null).includes('qa-icon');
      },
      /** Metres from the camera to what the depth pick finds at the centre. */
      centreDepthM() {
        frame();
        const point = scene.pickPositionWorldCoordinates(centre());
        return point
          ? C.Cartesian3.distance(point, viewer.camera.positionWC)
          : null;
      },
    };
    window.__zoomUnderIconQa = qa;
    const gl = scene.context._gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: gl.getParameter(
        debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
      ),
      logDepth: scene.logarithmicDepthBuffer,
      pickPosition: scene.pickPositionSupported,
    };
  }, CAMERA_HEIGHT_M);
  console.log(
    `[INFO] WebGL renderer: ${setup.renderer}; log depth ${setup.logDepth}`,
  );
  assert.ok(setup.pickPosition, 'the context must support depth picks');

  const qa = (method, ...args) =>
    page.evaluate(
      (name, rest) => window.__zoomUnderIconQa[name](...rest),
      method,
      args,
    );
  const x = viewport.width / 2;
  const y = viewport.height / 2;
  await page.mouse.move(x, y);
  /** Wheel `deltaY` at the canvas centre, then the settled camera height. */
  const wheel = async (deltaY) => {
    await qa('reset');
    await page.evaluate(
      ({ x, y, deltaY }) => {
        window.__godsEyeView.viewer.canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { x, y, deltaY },
    );
    return qa('frames', 40);
  };

  // The ground alone: what the icon must not change.
  await qa('setIcon', false);
  await qa('reset');
  await qa('frames', 10);
  const groundDepth = await qa('centreDepthM');
  const groundIn = await wheel(-600);
  const groundOut = await wheel(600);
  console.log(
    `[INFO] no icon: centre depth ${groundDepth?.toFixed(1)} m, wheel in to ${groundIn.toFixed(0)} m, out to ${groundOut.toFixed(0)} m`,
  );
  assert.ok(groundIn < CAMERA_HEIGHT_M * 0.95, 'control: wheel in zooms in');
  assert.ok(groundOut > CAMERA_HEIGHT_M * 1.05, 'control: wheel out zooms out');

  await qa('setIcon', true);
  await qa('reset');
  await page.waitForFunction(
    async () => {
      await window.__zoomUnderIconQa.frames(1);
      return window.__zoomUnderIconQa.iconAtCentre();
    },
    { timeout: 30_000 },
  );
  console.log('[PASS] the icon draws under the canvas centre');

  const depth = await qa('centreDepthM');
  const zoomedIn = await wheel(-600);
  const zoomedOut = await wheel(600);
  console.log(
    `[INFO] icon at centre: depth pick ${depth === null ? 'finds nothing' : `${depth.toFixed(3)} m away`}, wheel in to ${zoomedIn.toFixed(0)} m, out to ${zoomedOut.toFixed(0)} m`,
  );
  assert.ok(
    depth === null || depth > 100,
    `the depth pick must not land on the icon (${depth} m from the camera)`,
  );
  console.log('[PASS] the depth pick at the centre ignores the icon');
  assert.ok(
    zoomedIn < CAMERA_HEIGHT_M * 0.95,
    `wheel in must zoom in under an icon (height ${zoomedIn.toFixed(1)} m)`,
  );
  console.log('[PASS] wheel in zooms in');
  assert.ok(
    zoomedOut > CAMERA_HEIGHT_M * 1.05,
    `wheel out must zoom out under an icon (height ${zoomedOut.toFixed(1)} m)`,
  );
  console.log('[PASS] wheel out zooms out');

  assert.ok(await qa('iconAtCentre'), 'the icon must still pick by click');
  console.log('[PASS] the icon still picks by click');

  assert.deepEqual(errors, [], 'no JavaScript page errors');
  console.log('[PASS] no JavaScript page errors');
} finally {
  await browser.close();
}
