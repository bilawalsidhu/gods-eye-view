#!/usr/bin/env node
/** Prove standalone startup and terminal resource ownership in a real browser. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (
      message.type() === 'warn' &&
      /^\[Data\].*(?:destroy|disable) error:/.test(message.text())
    ) {
      console.log(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  await page.goto(`${url}/?welcome=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.voiceCommands, {
    timeout: 60_000,
  });
  const before = await page.evaluate(async () => {
    const entry = [...document.scripts].find((script) =>
      /\/src\/main\.js(?:\?|$)/.test(script.src),
    );
    const { application } = await import(entry.src);
    window.__qaApplication = application;
    const app = window.__godsEyeView;
    window.__qaComponents = app;
    await application.start();
    await app.styleManager.initialRestorePromise;
    const enabled = await app.dataManager.setEnabled('local-datacenters', true);
    const annotation = await app.annotations.annotate([
      {
        type: 'pin',
        longitude: -97.74,
        latitude: 30.27,
        label: 'Lifecycle check',
      },
    ]);
    return {
      status: application.getState().status,
      enabled,
      layers: app.dataManager.layers.size,
      annotationCount: annotation.drawn,
      viewerAlive: !app.viewer.isDestroyed(),
      credits: Boolean(document.querySelector('#cesium-credits')),
    };
  });
  assert.equal(before.status, 'ready');
  assert.equal(before.enabled, true);
  assert.ok(before.layers >= 16);
  assert.equal(before.annotationCount, 1);
  assert.equal(before.viewerAlive, true);
  assert.equal(before.credits, true);
  console.log(
    'PASS: startup, data registration, annotations and visible attribution',
  );

  const after = await page.evaluate(async () => {
    const application = window.__qaApplication;
    const app = window.__qaComponents;
    const first = application.destroy();
    const samePromise = first === application.destroy();
    await first.catch((error) => {
      const describe = (failure) =>
        failure.errors?.map(describe).join('; ') || failure.message;
      throw new Error(describe(error));
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('resize'));
    app.requestRender('after-destroy');
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return {
      status: application.getState().status,
      samePromise,
      viewerDestroyed: app.viewer.isDestroyed(),
      layers: app.dataManager.layers.size,
      annotations: app.annotations.count(),
      governor: app.getRenderGovernorDiagnostics(),
      handlesRemoved:
        !window.__godsEyeView &&
        !window.__gevVoiceCommands &&
        !window.__gevAnnotations,
      creditsRemoved: !document.querySelector('#cesium-credits'),
      welcomeHidden: !document.querySelector('#first-run-launcher.visible'),
      settingsRemoved: !document.querySelector('#key-setup'),
    };
  });
  assert.equal(after.status, 'destroyed');
  assert.equal(after.samePromise, true);
  assert.equal(after.viewerDestroyed, true);
  assert.equal(after.layers, 0);
  assert.equal(after.annotations, 0);
  assert.equal(after.governor.installed, false);
  assert.deepEqual(after.governor.holds, []);
  assert.equal(after.handlesRemoved, true);
  assert.equal(after.creditsRemoved, true);
  assert.equal(after.welcomeHidden, true);
  assert.equal(after.settingsRemoved, true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: terminal teardown releases runtime owners without late browser errors',
  );
} finally {
  await browser.close();
}
