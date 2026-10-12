#!/usr/bin/env node
/** Exercise scene-clock ownership and authored seek behavior in the composed browser app. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
const shots = path.resolve('qa-shots/director-timing');
fs.mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
function check(name, passed) {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) failures++;
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
    const director = window.__godsEyeView.sceneDirector;
    const camera = director.styleManager.getCameraState();
    const visual = director.styleManager.getVisualState();
    const scene = {
      id: 'timing-qa',
      title: 'Timing QA',
      shots: [0, 1].map((index) => ({
        id: `timing-${index}`,
        title: `Timing ${index}`,
        durationSec: 0.4,
        holdSec: 0.3,
        camera: { ...camera, lon: camera.lon + index * 0.002 },
        visual,
        layers: {},
      })),
    };
    director._project.scenes.push(scene);
    const load = await director.loadShot(scene.id, scene.shots[0].id, {
      flyDuration: 0.3,
    });
    const forward = await director.seekScene(scene.id, 0.9);
    const forwardSnapshot = director.getPlaybackTimingState().snapshot;
    const backward = await director.seekScene(scene.id, 0.1);
    const backwardSnapshot = director.getPlaybackTimingState().snapshot;
    const replay = await director.replayShot(scene.id, scene.shots[1].id);
    director.stopScene();
    await director.startScene(scene.id, { single: true, preview: false });
    const completed =
      !director.running && director.getPlaybackTimingState().activeTimers === 0;
    scene.shots[0].holdSec = 60;
    const run = director.startScene(scene.id, { single: true, preview: false });
    const deadline = Date.now() + 10000;
    while (
      director.getPlaybackTimingState().activeTimers < 3 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const holding = director.getPlaybackTimingState().activeTimers >= 3;
    const stoppedAt = performance.now();
    director.stopScene('QA Stop during hold');
    await run;
    const stoppedPromptly = performance.now() - stoppedAt < 1000;
    const noTimers = director.getPlaybackTimingState().activeTimers === 0;
    director._project.scenes = director._project.scenes.filter(
      ({ id }) => id !== scene.id,
    );
    return {
      loaded: load?.started,
      forward: forward && forwardSnapshot.shotId === 'timing-1',
      backward: backward && backwardSnapshot.shotId === 'timing-0',
      replay: replay?.started,
      completed,
      holding,
      stoppedPromptly,
      noTimers,
    };
  });
  for (const [name, passed] of Object.entries(result)) check(name, passed);
  const content = await page.evaluate(async () => {
    const d = window.__godsEyeView.sceneDirector;
    const scene = d._project.scenes.find(({ title }) =>
      /Nepal Flood Incident/i.test(title),
    );
    if (!scene) return { exists: false };
    const shot =
      scene.shots.find(({ title }) => /Regional Approach/i.test(title)) ||
      scene.shots[0];
    const loaded = await d.loadShot(scene.id, shot.id, { flyDuration: 0.3 });
    return {
      exists: true,
      shots: scene.shots.length,
      loaded: loaded?.started === true,
    };
  });
  check(
    'existing Nepal scene and authored shots load',
    content.exists && content.shots >= 25 && content.loaded,
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await page.screenshot({ path: path.join(shots, 'nepal-regional.png') });
  await page.evaluate(() => {
    const g = window.__godsEyeView;
    g.sceneDirector.stopScene();
    const pose = g.styleManager.getCameraState();
    g.sceneDirector._setCameraView({
      ...pose,
      heading: pose.heading + 45,
      pitch: -55,
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await page.screenshot({ path: path.join(shots, 'nepal-angle.png') });
  check(
    'no pending clocks after Stop',
    await page.evaluate(
      () =>
        window.__godsEyeView.sceneDirector.getPlaybackTimingState()
          .activeTimers === 0,
    ),
  );
  check('no browser exceptions', errors.length === 0);
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
