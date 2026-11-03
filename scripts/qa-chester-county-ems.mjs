#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

// Synthetic incident records only: no captured medical reports in evidence files.
const base = process.env.QA_BASE_URL || 'http://localhost:4173';
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chromeExecutablePath(),
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
  ],
});
let recorder;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() => {
    const original = window.fetch;
    let empty = false;
    window.__emsEmpty = () => {
      empty = true;
    };
    window.fetch = (input, options) => {
      if (String(input).includes('/api/chester-county-ems'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fetchedAt: Date.now(),
              observedAt: Date.now(),
              stale: false,
              locationCoverage: {
                matched: empty ? 0 : 3,
                unmatched: empty ? 0 : 1,
                unavailable: 0,
              },
              rows: empty
                ? []
                : [
                    {
                      id: 'F26000001',
                      type: 'SYNTHETIC EMS TEST',
                      location: 'EXAMPLE RD & TEST ST',
                      municipality: 'West Chester Borough',
                      dispatched: '11-03-2026 10:00:00',
                      station: '01',
                      category: 'ems',
                      mapPosition: {
                        lat: 39.96,
                        lon: -75.605,
                        kind: 'intersection',
                        approximate: true,
                      },
                    },
                  ]
                    .flatMap((row) =>
                      ['ems', 'fire', 'traffic'].map((category, i) => ({
                        ...row,
                        category,
                        id: i ? `${category}:test` : row.id,
                        type: `SYNTHETIC ${category.toUpperCase()} TEST`,
                        mapPosition: {
                          ...row.mapPosition,
                          lon: row.mapPosition.lon + i * 0.002,
                        },
                      })),
                    )
                    .concat([
                      {
                        id: 'ems:unresolved',
                        category: 'ems',
                        type: 'SYNTHETIC UNRESOLVED TEST',
                        location: 'EXAMPLE RD &',
                        municipality: 'West Chester Borough',
                        locationStatus: 'unmatched',
                        mapPosition: null,
                      },
                    ]),
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        );
      return original(input, options);
    };
  });
  await page.goto(`${base}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  if (process.env.QA_RECORDING_PATH) {
    await mkdir(dirname(process.env.QA_RECORDING_PATH), { recursive: true });
    recorder = await page.screencast({
      path: process.env.QA_RECORDING_PATH,
      format: 'mp4',
      fps: 12,
      scale: 0.8,
    });
  }
  const result = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.mapStackController.setStack('osm');
    const manager = app.dataManager;
    await manager.setEnabled('chester-county-ems', true, { origin: 'user' });
    const layer = manager.layers.get('chester-county-ems').module;
    await layer.update();

    return {
      count: layer.getStats().count,
      degraded: layer.getStats().degraded,
      list: layer.getRowControls().list.items.length,
      info: layer.getRowControls().info,
    };
  });
  assert.equal(result.count, 4);
  assert.equal(result.degraded, false);
  assert.equal(result.list, 4);
  assert.match(result.info, /3 mapped · 1 unresolved · 0 lookup errors/);
  assert.match(result.info, /Street locations are approximate/);
  const incidentSelector =
    '[data-layer-id="chester-county-ems"] button[data-list-item-id="F26000001"]';
  const incidentVisible = await page.evaluate((selector) => {
    const item = document.querySelector(selector);
    return item?.checkVisibility({ visibilityProperty: true }) || false;
  }, incidentSelector);
  if (!incidentVisible)
    await page.locator('[data-rail-item="data-panel"]').click();
  if (recorder) {
    await page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get(
          'chester-county-ems',
        ).module;
      layer
        .getRowControls()
        .chips.find((chip) => chip.id === 'county')
        .onClick();
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const incident = await page.waitForSelector(incidentSelector, {
    visible: true,
  });
  await incident.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '[data-layer-id="chester-county-ems"] button[data-list-item-id="F26000001"]',
        )
        ?.getAttribute('aria-pressed') === 'true',
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await mkdir('qa-shots/chester-county-ems', { recursive: true });
  await page.screenshot({ path: 'qa-shots/chester-county-ems/selected.png' });
  if (recorder) await new Promise((resolve) => setTimeout(resolve, 6000));
  const cleared = await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager;
    const layer = manager.layers.get('chester-county-ems').module;
    window.__emsEmpty();
    await layer.update();
    const count = layer.getStats().count;
    await manager.setEnabled('chester-county-ems', false, { origin: 'user' });
    return { count, enabled: manager.isEnabled('chester-county-ems') };
  });
  assert.deepEqual(cleared, { count: 0, enabled: false });
  console.log(
    'PASS: county incidents, three category icons, street selection, empty refresh and disable',
  );
} finally {
  await recorder?.stop();
  await browser.close();
}
