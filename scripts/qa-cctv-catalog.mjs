#!/usr/bin/env node
/**
 * Large CCTV catalog acceptance, using deterministic source/frame/terrain
 * fixtures against a running app. Run: node scripts/qa-cctv-catalog.mjs
 * QA_BASE_URL overrides http://localhost:4173. No live camera tokens are used.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import {
  DEFAULT_CCTV_MAX_SOURCES,
  DEFAULT_PENNDOT_MAX_SOURCES,
} from '../server/providers/cctv/constants.js';
import { CCTV_AMBIENT_CARD_MAX } from '../src/data/cctvLod.js';

const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const sources = Array.from({ length: DEFAULT_CCTV_MAX_SOURCES }, (_, index) => {
  const pennsylvania = index > 0 && index <= DEFAULT_PENNDOT_MAX_SOURCES;
  return {
    id: pennsylvania ? `511pa-scale-${index}` : `world-scale-${index}`,
    name: `Catalog scale camera ${index}`,
    city: pennsylvania ? 'Pennsylvania' : 'Global catalog fixture',
    cityId: pennsylvania ? 'pennsylvania' : 'scale-fixture',
    provider: 'Catalog scale fixture',
    pack: pennsylvania ? '511pa' : 'scale-fixture',
    lat:
      index === 0
        ? 30.2672
        : pennsylvania
          ? 39.8 + (index % 40) * 0.06
          : -60 + (index % 120) + 0.01,
    lon:
      index === 0
        ? -97.7431
        : pennsylvania
          ? -80.4 + (Math.floor(index / 40) % 50) * 0.11
          : -179 + (Math.floor(index / 120) % 358) + 0.01,
    headingDeg: 0,
    pitchDeg: -18,
    fovDeg: 60,
    rangeM: 300,
    mountHeightM: 8,
    groundElevationM: 0,
    feedType: 'image',
    sourceKind: 'fixture',
  };
});
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
const requestedFrames = new Set();
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(origin).origin) return void request.continue();
    const json = (body) =>
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (url.pathname === '/api/cctv/sources')
      return void json({ sources, trimmedPacks: [] });
    if (url.pathname === '/api/cctv/health') return void json({ cameras: [] });
    if (url.pathname.startsWith('/api/cctv/frame/')) {
      requestedFrames.add(decodeURIComponent(url.pathname.split('/').at(-1)));
      return void request.respond({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'X-CCTV-Source': 'upstream-image' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#254b32"/></svg>',
      });
    }
    if (url.pathname === '/api/terrain/heights')
      return void json({
        results: (url.searchParams.get('points') || '')
          .split(';')
          .filter(Boolean)
          .map((point) => {
            const [lon, lat] = point.split(',').map(Number);
            return { lon, lat, elevation: 0, geoid: 0, ellipsoid: 0 };
          }),
      });
    if (url.pathname === '/api/openai/hud-summary')
      return void json({ summary: 'Catalog scale fixture' });
    void request.continue();
  });
  await page.goto(`${origin}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.$eval('[data-collapse-target="cctv-panel"]', (button) =>
    button.click(),
  );
  await page.click('#cctv-enable-btn');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('penndot-traffic-cams', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    (count) =>
      window.__godsEyeView.styleManager._cctvControls.cctv.getUIState()
        .count === count,
    { timeout: 60000 },
    sources.length,
  );
  const catalog = await page.evaluate(() => {
    const state =
      window.__godsEyeView.styleManager._cctvControls.cctv.getUIState();
    return {
      count: state.count,
      pennsylvania: state.cameras.filter((camera) =>
        camera.id.startsWith('511pa-scale-'),
      ).length,
      cards: state.ambientCards,
    };
  });
  assert.equal(catalog.count, sources.length);
  assert.equal(catalog.pennsylvania, DEFAULT_PENNDOT_MAX_SOURCES);
  assert.ok(catalog.cards.count <= CCTV_AMBIENT_CARD_MAX);
  console.log(
    '[PASS] full large catalog and statewide PA sources reach the client',
    catalog,
  );

  const lastPennsylvania = `511pa-scale-${DEFAULT_PENNDOT_MAX_SOURCES}`;
  const selected = await page.evaluate((id) => {
    const cctv = window.__godsEyeView.styleManager._cctvControls.cctv;
    const selected = cctv.selectCamera(id);
    cctv.focusCamera(id, 0.5);
    return selected;
  }, lastPennsylvania);
  assert.equal(selected, true);
  await page.waitForFunction(
    (id) => {
      const image = document.getElementById('cctv-frame');
      return (
        image.dataset.cameraId === id &&
        image.complete &&
        image.naturalWidth > 0
      );
    },
    { timeout: 30000 },
    lastPennsylvania,
  );
  const cards = await page.evaluate(
    () =>
      window.__godsEyeView.styleManager._cctvControls.cctv.getUIState()
        .ambientCards,
  );
  assert.ok(cards.count <= CCTV_AMBIENT_CARD_MAX);
  assert.ok(
    requestedFrames.size < 100,
    `metadata catalog triggered ${requestedFrames.size} distinct frame downloads`,
  );
  assert.deepEqual(errors, []);
  console.log(
    '[PASS] distant PA camera can be selected and decoded; frame work stays bounded',
    { cards, distinctFrames: requestedFrames.size },
  );
} finally {
  await browser.close();
}
