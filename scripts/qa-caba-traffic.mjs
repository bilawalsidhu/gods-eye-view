#!/usr/bin/env node
/**
 * CABA inventory browser gate with deterministic provider fixtures.
 * Requires the dev server: node scripts/qa-caba-traffic.mjs --url http://localhost:4173
 * Checks point/context provenance, lifecycle cleanup, sharing and unavailable
 * errors. It does not verify the live official CSV download.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const index = process.argv.indexOf('--url');
const url = new URL(
  index >= 0 ? process.argv[index + 1] : 'http://localhost:4173',
);
url.searchParams.set('welcome', '0');
url.searchParams.set('v', '2');
url.searchParams.set('l', '');
const layerId = 'caba-traffic-enforcement';
const snapshot = {
  fetchedAt: Date.UTC(2026, 9, 14),
  rows: [
    {
      type: 'Analítica de video',
      location: 'AV. CÓRDOBA 6287 Y JORGE NEWBERY',
      latitude: -34.5827315,
      longitude: -58.448532,
    },
    {
      type: 'Cinemómetro',
      location: 'AV. TEST',
      latitude: -34.6,
      longitude: -58.4,
    },
  ],
};
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
try {
  const page = await browser.newPage();
  let unavailable = false;
  let requests = 0;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/caba-traffic-enforcement') {
      requests++;
      void request.respond({
        status: unavailable ? 502 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          unavailable ? { error: 'fixture_unavailable' } : snapshot,
        ),
      });
    } else void request.continue();
  });
  async function boot() {
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.dataManager &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 90_000 },
    );
  }
  await boot();
  const loaded = await page.evaluate(async (id) => {
    const gev = window.__godsEyeView;
    await gev.dataManager.setEnabled(id, true, { origin: 'user' });
    const { getContextStore } = await import('/src/data/contextStore.js');
    const records = [...getContextStore().entities.values()].filter(
      (record) => record.layerId === id,
    );
    return {
      stats: gev.dataManager.layers.get(id).module.getStats(),
      records: records.map(({ properties }) => properties),
    };
  }, layerId);
  assert.equal(loaded.stats.error, null);
  assert.equal(loaded.stats.count, 2);
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.records[0].license, 'CC-BY-2.5-AR');
  assert.equal(loaded.records[0].imagery, 'Not provided by source');
  assert.equal(loaded.records[0].operational_status, 'Not provided by source');
  const afterToggle = await page.evaluate(async (id) => {
    const gev = window.__godsEyeView;
    const { getContextStore } = await import('/src/data/contextStore.js');
    const count = () =>
      [...getContextStore().entities.values()].filter(
        (record) => record.layerId === id,
      ).length;
    await gev.dataManager.setEnabled(id, false, { origin: 'user' });
    const hidden = count();
    await gev.dataManager.setEnabled(id, true, { origin: 'user' });
    const {
      createDefaultLayerState,
      encodeLayerStateParams,
      decodeLayerStateParams,
    } = await import('/src/data/layerState.js');
    const state = createDefaultLayerState();
    state.enabledLayerIds = [id];
    const params = new URLSearchParams([['v', '2']]);
    encodeLayerStateParams(params, state);
    return { hidden, shown: count(), restored: decodeLayerStateParams(params) };
  }, layerId);
  assert.equal(afterToggle.hidden, 0);
  assert.equal(afterToggle.shown, 2);
  assert.equal(requests, 1);
  assert.deepEqual(afterToggle.restored.enabledLayerIds, [layerId]);
  unavailable = true;
  await boot();
  const failure = await page.evaluate(async (id) => {
    const gev = window.__godsEyeView;
    await gev.dataManager.setEnabled(id, true, { origin: 'user' });
    return gev.dataManager.layers.get(id).module.getStats();
  }, layerId);
  assert.equal(failure.count, 0);
  assert.match(failure.error, /unavailable/i);
  assert.deepEqual(errors, []);
  console.log(
    'CABA inventory: lifecycle, provenance, sharing and errors passed.',
  );
} finally {
  await browser.close();
}
