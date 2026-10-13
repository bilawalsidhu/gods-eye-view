#!/usr/bin/env node
/**
 * Browser QA for WebGL context loss (#1067): the main viewer survives a
 * dropped graphics context. Forcing `WEBGL_lose_context.loseContext()` on
 * the running globe — the stand-in for GPU eviction on tab backgrounding —
 * must (1) `preventDefault()` the `webglcontextlost` event, (2) stop the
 * render loop before Cesium renders into the 0×0 drawing buffer (no
 * DeveloperError, no "Rendering has stopped" panel), (3) recover through
 * exactly one guarded automatic reload, and (4) inside the reload cooldown
 * degrade to a plain notice with a manual reload instead. A layout
 * zero-size cycle (the reporter's other route) must stay healthy without
 * tripping any of this.
 *
 * Needs the dev server:  ./scripts/dev-fresh.sh   (keyless is fine)
 * Run:                   node scripts/qa-context-loss.mjs
 *                        [--url http://localhost:4173]
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import {
  saveFailureArtifacts,
  watchPage,
} from './qa-browserEvidence.mjs';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
const ARTIFACT_DIR = 'qa-artifacts/context-loss';
const BOOT_TIMEOUT = 90_000;

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitViewer = (page, timeout) =>
  page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer && !window.__godsEyeView.viewer.isDestroyed(),
    { timeout, polling: 500 },
  );

const forceContextLoss = (page) =>
  page.evaluate(() => {
    const canvas = window.__godsEyeView.viewer.canvas;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  });

const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const errors = [];
const monitors = [];
try {
  const page = await browser.newPage();
  // Count document loads across the recovery reloads; sessionStorage (not
  // the window) is what survives a navigation in the same tab.
  await page.evaluateOnNewDocument(() => {
    window.__qaLoads =
      (Number(sessionStorage.getItem('__qaLoads')) || 0) + 1;
    sessionStorage.setItem('__qaLoads', String(window.__qaLoads));
  });
  monitors.push(watchPage(page, { name: 'main', errors }));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Boot 1.
  await waitViewer(page, BOOT_TIMEOUT);
  assert.equal(await page.evaluate(() => window.__qaLoads), 1);

  // WEBGL_lose_context delivers the event asynchronously, so an in-flight
  // frame can race it and fail first (that error-first order is covered by
  // the fallback detector — see src/app/contextLoss.test.mjs). Real GPU
  // eviction discovers the loss browser-side, which is this event-first
  // order; pausing the loop pins it: no frame may render into the dead
  // context, ever.
  await page.evaluate(() => {
    window.__godsEyeView.viewer.useDefaultRenderLoop = false;
  });

  // The guard's listeners run first (installed at viewer creation); a probe
  // listener behind them reads what the guard did to the very event, before
  // the recovery reload tears the document down.
  let loopStopResolve;
  const loopStopEvidence = new Promise((resolve) => {
    loopStopResolve = resolve;
  });
  await page.exposeFunction('__qaReportLoopStopped', loopStopResolve);
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    viewer.canvas.addEventListener(
      'webglcontextlost',
      (event) => {
        window.__qaReportLoopStopped({
          defaultPrevented: event.defaultPrevented,
          loopStopped: viewer.useDefaultRenderLoop === false,
        });
      },
      { once: true },
    );
  });

  const navigation = page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await forceContextLoss(page);
  const evidence = await withTimeout(
    loopStopEvidence,
    10_000,
    'loop-stop evidence',
  );
  assert.equal(
    evidence.defaultPrevented,
    true,
    'webglcontextlost must be preventDefault()ed so the context stays restorable',
  );
  assert.equal(
    evidence.loopStopped,
    true,
    'the guard must stop the render loop on context loss',
  );
  await navigation;

  // Recovery 1: exactly one guarded automatic reload rebuilds the app.
  await waitViewer(page, BOOT_TIMEOUT);
  assert.equal(
    await page.evaluate(() => window.__qaLoads),
    2,
    'context loss must recover through one automatic reload',
  );
  assert.deepEqual(
    [...monitors[0].renderErrors],
    [],
    'Cesium must never render into the dead context',
  );
  assert.deepEqual(errors, [], `no page errors expected: ${errors.join(' | ')}`);

  // Recovery 2 inside the cooldown: no second reload; a plain notice with
  // the manual way out instead. Pin the flag so boot time cannot flip the
  // branch (documented in src/app/contextLoss.js).
  await page.evaluate(() => {
    sessionStorage.setItem('gev:context-loss-reload-at', String(Date.now()));
  });
  await forceContextLoss(page);
  await sleep(2_000);
  const notice = await page.evaluate(() => {
    const element = document.getElementById('gev-context-loss-notice');
    return element
      ? {
          role: element.getAttribute('role'),
          hasButton: Boolean(element.querySelector('button')),
        }
      : null;
  });
  assert.notEqual(notice, null, 'the cooldown path must show the context-loss notice');
  assert.equal(notice.role, 'alert');
  assert.equal(
    notice.hasButton,
    true,
    'the terminal case must offer the manual reload',
  );
  await sleep(4_000);
  assert.equal(
    await page.evaluate(() => window.__qaLoads),
    2,
    'the cooldown must not trigger another automatic reload',
  );
  assert.equal(
    await page.evaluate(() =>
      Boolean(document.querySelector('.cesium-widget-errorPanel')),
    ),
    false,
    "recovery must replace Cesium's dead 'Rendering has stopped' panel",
  );

  // The reporter's other route stays healthy: a transient zero-size layout
  // never trips the guard and rendering resumes once dimensions return.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitViewer(page, BOOT_TIMEOUT);
  const renderErrorsBeforeLayoutCycle = monitors[0].renderErrors.length;
  await page.evaluate(() => {
    window.__qaRenders = 0;
    window.__godsEyeView.viewer.scene.postRender.addEventListener(
      () => window.__qaRenders++,
    );
    window.__godsEyeView.requestRender('qa-context-loss');
  });
  await sleep(1_000);
  const rendersBefore = await page.evaluate(() => window.__qaRenders);
  assert.equal(
    await page.evaluate(() => {
      const container = document.getElementById('cesiumContainer');
      container.style.display = 'none';
      return true;
    }),
    true,
  );
  await sleep(1_500);
  const collapsed = await page.evaluate(() => {
    const canvas = window.__godsEyeView.viewer.canvas;
    return {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      loopOn: window.__godsEyeView.viewer.useDefaultRenderLoop === true,
    };
  });
  assert.equal(collapsed.width, 0);
  assert.equal(collapsed.height, 0);
  await page.evaluate(() => {
    document.getElementById('cesiumContainer').style.display = '';
    window.__godsEyeView.requestRender('qa-context-loss');
  });
  await sleep(1_500);
  const rendersAfter = await page.evaluate(() => window.__qaRenders);
  assert.equal(
    collapsed.loopOn,
    true,
    'a zero-size layout cycle must not stop the render loop',
  );
  assert.equal(
    rendersAfter > rendersBefore,
    true,
    'rendering must resume after the container returns',
  );
  assert.equal(
    monitors[0].renderErrors.length,
    renderErrorsBeforeLayoutCycle,
    'the zero-size cycle must not produce render errors',
  );

  console.log(
    'qa-context-loss: context loss preventDefaults and stops the loop, recovers by one reload, degrades to the notice inside the cooldown; a zero-size layout cycle stays healthy.',
  );
} catch (error) {
  const dir = await saveFailureArtifacts({
    dir: ARTIFACT_DIR,
    browser,
    monitors,
    error,
  });
  console.error(`qa-context-loss FAILED (artifacts: ${dir})`);
  throw error;
} finally {
  await browser.close();
}
// The pinned event-first phase allows nothing; the later phases tolerate
// Cesium's own render-loop console line (the error-first order), never a
// page error.
const fatalErrors = errors.filter(
  (text) => !/^\[main\] render loop:/.test(text),
);
if (fatalErrors.length) {
  console.error(`qa-context-loss FAILED: ${fatalErrors.join('\n')}`);
  process.exitCode = 1;
}
