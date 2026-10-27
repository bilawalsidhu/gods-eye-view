#!/usr/bin/env node
/** Run in the temporary #1146 + #1426 integration checkout, after npm ci.
 * Starts its own fixture-only server and browser; no provider key is required.
 * PUPPETEER_EXECUTABLE_PATH may select Chrome Headless Shell in restricted hosts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { createDefaultLayerState } from '../src/data/layerState.js';
import {
  createDefaultShareViewState,
  encodeShareView,
} from '../src/share/viewCodec.js';

const origin = 'http://127.0.0.1:4420';
const dev = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    '4420',
    '--strictPort',
  ],
  { stdio: 'ignore' },
);
let browser;
const now = Date.now();
const fixture = {
  fetchedAt: now,
  sourceLabel: 'NASA FIRMS + CONAE GOES',
  sources: [
    { source: 'NASA FIRMS', ok: true, count: 2 },
    { source: 'CONAE GOES', ok: true, count: 1 },
  ],
  fires: [
    {
      lat: -27.4,
      lon: -55.9,
      provider: 'conae-goes',
      instrument: 'GOES',
      satellite: 'GOES-19',
      acqMs: now - 60_000,
      frp: null,
      confidence: null,
      brightness: null,
    },
    {
      lat: -27.42,
      lon: -55.92,
      frp: 20,
      confidence: 'n',
      instrument: 'VIIRS',
      satellite: 'N20',
      acqDate: new Date(now).toISOString().slice(0, 10),
      acqTime: '1200',
    },
    {
      lat: -27.44,
      lon: -55.94,
      frp: 300,
      confidence: 'h',
      instrument: 'VIIRS',
      satellite: 'N21',
      acqDate: new Date(now).toISOString().slice(0, 10),
      acqTime: '1200',
    },
  ],
};
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await puppeteer.launch({
    headless: true,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname === '/api/firms')
      return void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture),
      });
    if (u.origin !== origin && !['data:', 'blob:'].includes(u.protocol))
      return void req.abort();
    void req.continue();
  });
  const boot = async (url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.dataManager && window.__godsEyeView?.viewer,
      { timeout: 90000 },
    );
    await page.keyboard.press('Escape');
  };
  await boot(origin);
  await page.evaluate(async () => {
    const dm = window.__godsEyeView.dataManager;
    await dm.setEnabled('local-firms', true);
    const m = dm.layers.get('local-firms').module;
    await m.update();
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('local-firms')
        .module.getStats().count === 3,
    { timeout: 30000 },
  );
  for (const [params, count] of [
    [{ minFrp: 0, confidence: 'all' }, 3],
    [{ minFrp: 20, confidence: 'all' }, 2],
    [{ minFrp: 0, confidence: 'high' }, 1],
    [{ minFrp: 1000, confidence: 'high' }, 0],
  ]) {
    const got = await page.evaluate((p) => {
      const g = window.__godsEyeView;
      const m = g.dataManager.layers.get('local-firms').module;
      m.setParams(p);
      g.viewer.scene.requestRender();
      return {
        stats: m.getStats(),
        controls: m.getRowControls(),
        records: m.getAnalystRecords(10),
        overlay: window.__gevWorldOverlay?.getDiagnostics?.(),
      };
    }, params);
    assert.equal(got.stats.count, count);
    assert.equal(got.stats.total, 3);
    assert.equal(got.records.length, count);
    assert.match(got.controls.info, new RegExp(`${count} of 3 shown`));
    if (count === 0) assert.equal(got.overlay?.entriesBySource?.firms || 0, 0);
    console.log('PASS browser filter', JSON.stringify(params), count);
  }
  const layers = createDefaultLayerState();
  layers.enabledLayerIds = ['local-firms'];
  layers.options['local-firms'] = { minFrp: 20, confidence: 'high' };
  const view = createDefaultShareViewState();
  view.layerState = layers;
  await boot(`${origin}/share/${encodeShareView(view)}`);
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('local-firms')
        ?.module?.getStats().count === 1,
    { timeout: 30000 },
  );
  const restored = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('local-firms')
      .module.getParams(),
  );
  assert.deepEqual(restored, { minFrp: 20, confidence: 'high' });
  console.log('PASS browser short-link restoration', JSON.stringify(restored));
  await page.waitForFunction(
    () =>
      !document.getElementById('loading-screen') ||
      document.getElementById('loading-screen').classList.contains('hidden'),
    { timeout: 90000 },
  );
  fs.mkdirSync('qa-shots', { recursive: true });
  await page.screenshot({ path: 'qa-shots/conae-intensity-shared.png' });
} finally {
  await browser?.close();
  dev.kill();
}
