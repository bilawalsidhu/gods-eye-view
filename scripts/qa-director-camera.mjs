#!/usr/bin/env node
/** Verify imported camera directions through real rendering and camera authority handoffs. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
const output = path.resolve('qa-shots/director-camera');
fs.mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failed = 0;
function check(name, passed) {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) failed++;
}
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
  const result = await page.evaluate(async () => {
    const { sceneDirector: d, styleManager: style } = window.__godsEyeView;
    const file = {
      version: 4,
      scenes: [
        {
          id: 'directions',
          title: 'Camera directions',
          anchors: [
            {
              id: 'start',
              title: 'Austin west',
              lat: 30.2672,
              lon: -97.76,
              alt: 6000,
              altitudeReference: 'ellipsoid',
            },
            {
              id: 'end',
              title: 'Austin east',
              lat: 30.2672,
              lon: -97.73,
              alt: 7000,
              altitudeReference: 'ellipsoid',
            },
          ],
          shots: [
            {
              id: 'move',
              title: 'Across Austin',
              durationSec: 1,
              holdSec: 0.2,
              camera: { anchorId: 'end', heading: 10, pitch: -45, roll: 0 },
              move: {
                from: { anchorId: 'start', heading: 350, pitch: -45, roll: 0 },
                easing: 'linear',
              },
              layers: {},
              visual: { style: 'normal' },
            },
          ],
        },
      ],
    };
    await d.importProjectFile(
      new File([JSON.stringify(file)], 'directions.json'),
    );
    const scene = d._project.scenes[0];
    const shot = scene.shots[0];
    const imported =
      scene.anchors.length === 2 && shot.camera.anchorId === 'end';
    await d.seekScene(scene.id, 0.5 / 1.2);
    const middle = style.getCameraState();
    const seekMidpoint =
      Math.abs(middle.lon - -97.745) < 1e-6 &&
      Math.abs(middle.alt - 6500) < 0.01;
    await d.seekScene(scene.id, 0);
    const back = style.getCameraState();
    const backward = Math.abs(back.lon - -97.76) < 1e-6;
    const replay = await d.replayShot(scene.id, shot.id);
    const end = style.getCameraState();
    const replayEnd =
      replay?.started &&
      Math.abs(end.lon - -97.73) < 1e-6 &&
      Math.abs(end.alt - 7000) < 0.01;
    d.stopScene();
    await d.startScene(scene.id, { single: true, preview: false });
    const completed =
      !d.running && d.getPlaybackTimingState().activeTimers === 0;
    const settled = Math.abs(style.getCameraState().lon - -97.73) < 1e-6;
    // Updating the target creates an explicit inline pose while retaining the authored start.
    d.updateSelectedShot();
    const saved = JSON.parse(
      localStorage.getItem('godsEyeView.sceneProject.v2'),
    );
    const updated =
      saved.scenes[0].shots[0].camera.altitudeReference === 'ellipsoid' &&
      saved.scenes[0].shots[0].move.from.anchorId === 'start';
    shot.durationSec = 30;
    const run = d.startScene(scene.id, { single: true, preview: false });
    const deadline = Date.now() + 10000;
    while (!d._cameraMotion.active && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    const started = d._cameraMotion.active;
    style.runImmediateNavigation('location', () => true);
    await run;
    const revoked =
      started &&
      !d.running &&
      !d._cameraMotion.active &&
      d.getPlaybackTimingState().activeTimers === 0;
    const stoppedPose = style.getCameraState();
    await new Promise((r) => setTimeout(r, 150));
    const stable =
      Math.abs(style.getCameraState().lon - stoppedPose.lon) < 1e-7;
    return {
      imported,
      seekMidpoint,
      backward,
      replayEnd,
      completed,
      settled,
      updated,
      revoked,
      stable,
    };
  });
  for (const [name, passed] of Object.entries(result)) check(name, passed);
  await new Promise((r) => setTimeout(r, 6000));
  await page.screenshot({ path: path.join(output, 'austin.png') });
  await page.evaluate(() => {
    const d = window.__godsEyeView.sceneDirector;
    const pose = d.styleManager.getCameraState();
    d._setCameraView({ ...pose, heading: pose.heading + 25, pitch: -60 });
    d.viewer.scene.requestRender();
  });
  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: path.join(output, 'angle.png') });
  const inputStarted = await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const scene = d._project.scenes[0];
    window.__qaCameraRun = d.startScene(scene.id, {
      single: true,
      preview: false,
    });
    const deadline = Date.now() + 10000;
    while (!d._cameraMotion.active && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    return d._cameraMotion.active;
  });
  const canvas =
    (await page.$('canvas.cesium-widget-canvas')) ||
    (await page.$('.cesium-widget canvas'));
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const input =
    inputStarted &&
    (await page.evaluate(async () => {
      await window.__qaCameraRun;
      const d = window.__godsEyeView.sceneDirector;
      return !d.running && d.getPlaybackTimingState().activeTimers === 0;
    }));
  check('manual canvas input revokes the move and releases clocks', input);
  const hold = await page.evaluate(async () => {
    const { sceneDirector: d, styleManager: style } = window.__godsEyeView;
    const scene = d._project.scenes[0];
    const shot = scene.shots[0];
    shot.durationSec = 0.2;
    shot.holdSec = 30;
    const run = d.startScene(scene.id, { single: true, preview: false });
    const deadline = Date.now() + 10000;
    while (
      (!d._activeSceneTravel || !d.running || d._cameraMotion.active) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 20));
    const holding = d.running && !d._cameraMotion.active;
    const began = performance.now();
    style.runImmediateNavigation('location', () => true);
    await run;
    return (
      holding &&
      performance.now() - began < 1000 &&
      d.getPlaybackTimingState().activeTimers === 0
    );
  });
  check('navigation during an authored hold settles immediately', hold);

  if (errors.length)
    console.error(
      errors.map((message) => message.replace(/https?:\/\/\S+/g, '[URL]')),
    );
  check('no uncaught browser errors', errors.length === 0);
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
