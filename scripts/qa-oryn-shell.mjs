#!/usr/bin/env node
/**
 * Browser QA for the ORYN Intelligence shell: demo sign-in, engine boot inside
 * the stage, navigation, layer toggles through the layer manager, event queue,
 * inspector, scene save/open, investigation flow and export wiring.
 *
 *   npm run dev -- --port 5179 &  node scripts/qa-oryn-shell.mjs --url http://localhost:5179
 *   node scripts/qa-oryn-shell.mjs --url http://localhost:5179 --shots ./qa-shots
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const url = flag('--url', 'http://localhost:4173');
const shots = flag('--shots', null);
if (shots) mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const report = [];
const step = (name, value) => {
  report.push({ name, value });
  console.log(`${value === true ? 'PASS' : value === false ? 'FAIL' : 'INFO'} ${name}${value === true || value === false ? '' : `: ${JSON.stringify(value)}`}`);
};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  const shot = async (name) => {
    if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
  };

  // Sign-in gate.
  await page.waitForSelector('#oryn-login:not([hidden])', { timeout: 20_000 });
  step('login visible before session', true);
  await shot('01-login');
  await page.type('#oryn-login-name', 'QA Analyst');
  await page.select('#oryn-login-org', 'demo-county-em');
  await page.click('#oryn-login-form button[type="submit"]');
  await page.waitForSelector('#oryn-login[hidden]', { timeout: 5_000 });
  step('login hides after demo sign-in', true);

  // Engine boots inside the stage.
  await page.waitForFunction(() => window.__godsEyeView?.voiceCommands, {
    timeout: 90_000,
  });
  await page.waitForFunction(
    () => document.getElementById('oryn-feed-summary')?.textContent?.trim() &&
      !/ENGINE STARTING/.test(document.getElementById('oryn-feed-summary').textContent),
    { timeout: 30_000 },
  );
  const boot = await page.evaluate(() => {
    const stage = document.getElementById('oryn-stage');
    const canvas = document.querySelector('#cesiumContainer canvas');
    const stageRect = stage.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect();
    return {
      canvas: Boolean(canvas),
      canvasInsideStage:
        Boolean(canvasRect) &&
        Math.abs(canvasRect.left - stageRect.left) < 2 &&
        Math.abs(canvasRect.width - stageRect.width) < 2,
      stageWidth: Math.round(stageRect.width),
      stageLeft: Math.round(stageRect.left),
      stageTop: Math.round(stageRect.top),
      credits: Boolean(document.querySelector('#cesium-credits')),
      creditsInStage: (() => {
        const credits = document.getElementById('cesium-credits');
        if (!credits) return false;
        const rect = credits.getBoundingClientRect();
        return (
          stage.contains(credits) &&
          rect.left >= stageRect.left &&
          rect.bottom <= stageRect.bottom + 1 &&
          getComputedStyle(credits).visibility !== 'hidden'
        );
      })(),
      layers: window.__godsEyeView.dataManager.layers.size,
      titleBarHidden:
        getComputedStyle(document.getElementById('title-bar')).display === 'none',
    };
  });
  step('engine boot', boot);
  assert.equal(boot.canvas, true);
  assert.equal(boot.canvasInsideStage, true);
  assert.equal(boot.creditsInStage, true);
  assert.ok(boot.layers >= 16);
  await shot('02-map');

  // Layer manager toggles a real layer through the engine.
  await page.click('#oryn-topbar-buttons button[title="Layer manager"]');
  await page.waitForSelector('#oryn-layers:not([hidden])');
  await page.waitForSelector('#oryn-layers [data-layer-id="earthquakes"] .oryn-switch');
  await page.click('#oryn-layers [data-layer-id="earthquakes"] .oryn-switch');
  await page.waitForFunction(
    () => window.__godsEyeView.dataManager.isEnabled('earthquakes'),
    { timeout: 20_000 },
  );
  step('layer manager enabled earthquakes', true);
  await page.waitForFunction(
    () =>
      document
        .querySelector('#oryn-layers [data-layer-id="earthquakes"] .oryn-chip')
        ?.textContent?.trim() !== 'OFF',
    { timeout: 10_000 },
  );
  const quakeState = await page.evaluate(() =>
    document.querySelector('#oryn-layers [data-layer-id="earthquakes"] .oryn-layer-meta')?.textContent?.trim(),
  );
  step('earthquakes row state', quakeState);
  await shot('03-layers');

  // Wait for the USGS feed (network) with a bounded budget; the event queue
  // must render honestly either way.
  try {
    await page.waitForFunction(
      () => {
        const row = window.__godsEyeView.dataManager.getAll().find((l) => l.id === 'earthquakes');
        return row?.stats?.count > 0 || row?.stats?.error;
      },
      { timeout: 45_000 },
    );
  } catch {
    step('USGS feed did not settle within budget', 'skipped');
  }
  await page.click('#oryn-nav [data-page="events"]');
  await page.waitForSelector('#oryn-pages:not([hidden]) .oryn-page');
  const events = await page.evaluate(() => ({
    rows: document.querySelectorAll('#oryn-pages tbody tr').length,
    empty: Boolean(document.querySelector('#oryn-pages .oryn-empty')),
  }));
  step('event queue', events);
  await shot('04-events');

  if (events.rows > 0) {
    await page.click('#oryn-pages tbody tr');
    await page.waitForSelector('#oryn-inspector:not([hidden])');
    const inspector = await page.evaluate(() => ({
      title: document.querySelector('#oryn-inspector .oryn-entity-title')?.textContent,
      fields: document.querySelectorAll('#oryn-inspector .oryn-field').length,
      hasSource: /Source/.test(document.getElementById('oryn-inspector-body').textContent),
      hasRetrieved: /Retrieved by ORYN/.test(document.getElementById('oryn-inspector-body').textContent),
    }));
    step('inspector shows event with provenance', inspector);
    assert.ok(inspector.fields >= 3);
    await shot('05-inspector');

    // Add to investigation through the picker (no active investigation yet).
    await page.click('#oryn-inspector .oryn-actions button:nth-of-type(2)');
    await page.waitForFunction(() => /Add to investigation/.test(document.querySelector('#oryn-pages h2')?.textContent || ''));
    await page.evaluate(() => {
      const input = document.querySelector('#oryn-pages .oryn-form input');
      input.value = 'QA investigation';
    });
    await page.click('#oryn-pages .oryn-form button');
    await page.waitForFunction(() => document.querySelectorAll('#oryn-pages .oryn-card').length >= 3);
    const evidence = await page.evaluate(() => document.querySelector('#oryn-pages .oryn-card:nth-of-type(2) .oryn-list')?.children.length ?? 0);
    step('investigation holds evidence', evidence);
    assert.ok(evidence >= 1);
    await shot('06-investigation');
  }

  // Save and reopen a scene.
  await page.click('#oryn-nav [data-page="scenes"]');
  await page.waitForSelector('#oryn-pages form.oryn-form input');
  await page.type('#oryn-pages form.oryn-form input', 'QA scene');
  await page.click('#oryn-pages form.oryn-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('#oryn-pages .oryn-grid .oryn-card').length >= 1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('oryn:scenes:v1')).items.length);
  step('scene persisted', stored);
  assert.ok(stored >= 1);
  await page.click('#oryn-pages .oryn-grid .oryn-card .oryn-btn-primary');
  await page.waitForFunction(() => document.getElementById('oryn-pages').hidden);
  step('scene open returns to the map', true);
  await shot('07-scenes');

  // Mode selector configures engine layers.
  await page.select('#oryn-mode-select', 'transportation');
  await page.waitForFunction(() => window.__godsEyeView.dataManager.isEnabled('flights'), { timeout: 30_000 });
  step('transportation mode enabled flights', true);

  // Pages render without errors.
  for (const id of ['overview', 'cameras', 'alerts', 'reports', 'sources', 'settings', 'audit', 'municipal', 'agriculture']) {
    await page.click(`#oryn-nav [data-page="${id}"]`);
    await page.waitForSelector('#oryn-pages:not([hidden]) .oryn-page');
    const title = await page.evaluate(() => document.getElementById('oryn-page-title').textContent);
    step(`page ${id}`, title);
    if (['overview', 'cameras', 'sources'].includes(id)) await shot(`08-${id}`);
    if (id === 'cameras') {
      const cameras = await page.evaluate(() => ({
        demo: document.querySelectorAll('#oryn-pages .oryn-chip-demo').length,
        video: document.querySelectorAll('#oryn-pages video').length,
      }));
      step('camera page: demo labels and no fake video', cameras);
      assert.ok(cameras.demo >= 1);
      assert.equal(cameras.video, 0);
    }
  }

  // Narrow layout.
  await page.setViewport({ width: 760, height: 820 });
  await page.click('#oryn-nav [data-page="map"]');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const narrow = await page.evaluate(() => {
    const rail = document.getElementById('oryn-rail').getBoundingClientRect();
    const stage = document.getElementById('oryn-stage').getBoundingClientRect();
    return { railOffscreen: rail.right <= 1, stageWidth: Math.round(stage.width), menuVisible: getComputedStyle(document.getElementById('oryn-menu-btn')).display !== 'none' };
  });
  step('narrow layout', narrow);
  assert.equal(narrow.menuVisible, true);
  await shot('09-narrow');
  await page.setViewport({ width: 1440, height: 900 });

  // Sign out returns to the login gate; the engine stays alive.
  await page.click('#oryn-topbar-buttons button[title="Sign out"]');
  await page.waitForSelector('#oryn-login:not([hidden])');
  const alive = await page.evaluate(() => !window.__godsEyeView.viewer.isDestroyed());
  step('sign-out shows login, viewer alive', alive);

  step('page errors', errors);
  step('console errors', consoleErrors.filter((text) => !/favicon|net::ERR|Failed to load resource|403|429|WebGL/i.test(text)));
  assert.deepEqual(errors, []);
  console.log('\nORYN shell QA complete');
} finally {
  await browser.close();
}
