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
    `--use-angle=${process.env.QA_BROWSER_ANGLE || 'swiftshader'}`,
    '--enable-webgl',
  ],
});
let recorder;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() => {
    const original = window.fetch;
    window.__emsPaintedText = new Set();
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (/MEDIC01|MONTCO01|AMB02|Approximate intersection/.test(String(text)))
        window.__emsPaintedText.add(String(text));
      return fillText.call(this, text, ...args);
    };
    let empty = false;
    window.__emsEmpty = () => {
      empty = true;
    };
    window.fetch = (input, options) => {
      if (String(input).includes('/api/county-ems/details?'))
        return Promise.resolve(
          Response.json({
            incidentNumber: String(input).includes('montgomery-pa')
              ? 'E2600001'
              : 'F26000001',
            timestampBasis: String(input).includes('montgomery-pa')
              ? 'retrieved'
              : 'source',
            observedAt: Date.now(),
            stale: false,
            units: [
              {
                unit: String(input).includes('montgomery-pa')
                  ? 'MONTCO01'
                  : 'MEDIC01',
                status: 'On Scene',
                entered: String(input).includes('montgomery-pa')
                  ? '10:05:00 AM'
                  : '11-03-2026 10:05:00',
              },
              {
                unit: 'AMB02',
                status: 'Enroute',
                entered: String(input).includes('montgomery-pa')
                  ? '10:04:00 AM'
                  : '11-03-2026 10:04:00',
              },
            ],
          }),
        );
      if (String(input).includes('/api/county-ems'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fetchedAt: Date.now(),
              observedAt: Date.now(),
              stale: false,
              countyFeeds: [
                {
                  id: 'chester-pa',
                  county: 'Chester County, PA',
                  count: empty ? 0 : 4,
                  observedAt: Date.now(),
                  fetchedAt: Date.now(),
                  stale: false,
                },
                {
                  id: 'montgomery-pa',
                  county: 'Montgomery County, PA',
                  count: empty ? 0 : 1,
                  observedAt: Date.now(),
                  fetchedAt: Date.now(),
                  stale: false,
                },
              ],
              locationCoverage: {
                matched: empty ? 0 : 4,
                unmatched: empty ? 0 : 1,
                unavailable: 0,
              },
              rows: empty
                ? []
                : [
                    {
                      id: 'ems:F26000001',
                      incidentNumber: 'F26000001',
                      detailUrl:
                        'https://webcad.chesco.org/WebCad/livecadcomments-ems.asp?eid=123&incidentno=F26000001',
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
                        detailUrl: i ? null : row.detailUrl,
                        type: `SYNTHETIC ${category.toUpperCase()} TEST`,
                        mapPosition: {
                          ...row.mapPosition,
                          lon: row.mapPosition.lon + i * 0.002,
                        },
                      })),
                    )
                    .concat([
                      {
                        id: 'montgomery-pa:ems:E2600001',
                        incidentNumber: 'E2600001',
                        category: 'ems',
                        countyId: 'montgomery-pa',
                        county: 'Montgomery County, PA',
                        type: 'SYNTHETIC MONTGOMERY EMS TEST',
                        location: 'EXAMPLE AVE & TEST RD',
                        municipality: 'Example Township',
                        station: '701',
                        dispatched: '2026-11-03 @ 10:00:00',
                        detailUrl:
                          'https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp?incident=E2600001',
                        mapPosition: {
                          lat: 39.961,
                          lon: -75.606,
                          kind: 'county-published',
                          approximate: true,
                        },
                      },
                      {
                        id: 'ems:unresolved',
                        incidentNumber: 'F26000009',
                        dispatched: '11-03-2026 10:00:00',
                        station: '01',
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
  await page.waitForFunction(
    () => {
      const loader = document.querySelector('#loading-screen');
      return (
        !loader ||
        getComputedStyle(loader).pointerEvents === 'none' ||
        getComputedStyle(loader).display === 'none'
      );
    },
    { timeout: 60000 },
  );
  assert.equal(await page.$('[data-rail-item="chester-county-panel"]'), null);
  if (process.env.QA_RECORDING_PATH) {
    await mkdir(dirname(process.env.QA_RECORDING_PATH), { recursive: true });
    recorder = await page.screencast({
      path: process.env.QA_RECORDING_PATH,
      format: process.env.QA_RECORDING_PATH.endsWith('.webm') ? 'webm' : 'mp4',
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
      list: layer.getIncidentPanelState().list.items.length,
      info: layer.getIncidentPanelState().info,
      unselected: layer
        .getIncidentPanelState()
        .list.items.every((item) => !item.active),
    };
  });
  assert.equal(result.unselected, true);
  assert.equal(result.count, 5);
  assert.equal(result.degraded, false);
  assert.equal(result.list, 5);
  assert.match(result.info, /4 mapped · 1 unresolved · 0 lookup errors/);
  assert.match(result.info, /Locations are approximate/);
  const incidentSelector =
    '#chester-county-panel button[data-list-item-id="ems:F26000001"]';
  await page.waitForSelector('[data-rail-item="chester-county-panel"]');
  assert.equal(
    await page.$('[data-layer-id="chester-county-ems"] [data-list-item-id]'),
    null,
  );
  const layerChip = (category) =>
    `[data-layer-id="chester-county-ems"] [data-chip-id="${category}"]`;
  await page.$eval('[data-rail-item="data-panel"]', (button) => {
    if (document.querySelector('#data-panel').classList.contains('collapsed'))
      button.click();
  });
  await page.waitForSelector(layerChip('ems'), { visible: true });
  // Let the rail expansion finish before measuring a native pointer target.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.locator(layerChip('ems')).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-county-category="ems"]')
        ?.getAttribute('aria-pressed') === 'false',
  );
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('chester-county-ems')
          .module.getIncidentPanelState().categories,
    ),
    ['fire', 'traffic'],
  );
  await page.$eval('[data-rail-item="chester-county-panel"]', (button) => {
    if (
      document
        .querySelector('#chester-county-panel')
        .classList.contains('collapsed')
    )
      button.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.locator('[data-county-category="ems"]').click();
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.getAttribute('aria-pressed') === 'true',
    {},
    layerChip('ems'),
  );
  await page.waitForSelector(incidentSelector, { visible: true });
  await page.locator(layerChip('county:montgomery-pa')).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-county-filter="montgomery-pa"]')
        ?.getAttribute('aria-pressed') === 'false',
  );
  assert.equal(
    await page.$$eval(
      '#chester-county-panel button[data-list-item-id]',
      (rows) => rows.length,
    ),
    4,
  );
  await page.locator('[data-county-filter="montgomery-pa"]').click();
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.getAttribute('aria-pressed') === 'true',
    {},
    layerChip('county:montgomery-pa'),
  );

  // Toggle each category through the app; both map and list must follow.
  const visibleCounts = () =>
    page.evaluate(() => {
      const app = window.__godsEyeView;
      return {
        icons:
          app.viewer.dataSources.getByName('chester-county-ems')[0].entities
            .values.length,
        rows: document.querySelectorAll(
          '#chester-county-panel button[data-list-item-id]',
        ).length,
        total: app.dataManager.layers
          .get('chester-county-ems')
          .module.getStats().count,
      };
    });
  for (const category of ['fire', 'traffic', 'ems']) {
    await page.locator(`[data-county-category="${category}"]`).click();
    await page.waitForFunction(
      (category) =>
        document
          .querySelector(`[data-county-category="${category}"]`)
          ?.getAttribute('aria-pressed') === 'false',
      {},
      category,
    );
    assert.equal(
      await page.$eval(layerChip(category), (chip) =>
        chip.getAttribute('aria-pressed'),
      ),
      'false',
    );
    assert.deepEqual(
      await visibleCounts(),
      category === 'ems'
        ? { icons: 2, rows: 2, total: 5 }
        : { icons: 3, rows: 4, total: 5 },
    );
    await page.locator(`[data-county-category="${category}"]`).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '#chester-county-panel button[data-list-item-id]',
        ).length === 5,
    );
    assert.deepEqual(await visibleCounts(), { icons: 4, rows: 5, total: 5 });
    assert.equal(
      await page.$eval(layerChip(category), (chip) =>
        chip.getAttribute('aria-pressed'),
      ),
      'true',
    );
  }
  if (recorder) {
    await page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get(
          'chester-county-ems',
        ).module;
      layer
        .getIncidentPanelState()
        .chips.find((chip) => chip.id === 'county')
        .onClick();
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  // Move to the fixture without selecting it, then click its actual billboard.
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    const Cesium = window.Cesium;
    app.viewer.camera.cancelFlight();
    app.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-75.605, 39.96, 1800),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    app.viewer.scene.requestRender();
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page
    .waitForFunction(
      () => {
        const app = window.__godsEyeView;
        const Cesium = window.Cesium;
        const entity =
          app.viewer.dataSources.getByName('chester-county-ems')[0].entities
            .values[0];
        const point = Cesium.SceneTransforms.worldToWindowCoordinates(
          app.viewer.scene,
          entity.position.getValue(Cesium.JulianDate.now()),
        );
        if (!point) return false;
        const icon = { x: point.x, y: point.y - 12 };
        window.__emsIcon = icon;
        const picked = app.viewer.scene.pick(
          new Cesium.Cartesian2(icon.x, icon.y),
        );
        window.__emsPick = {
          id: picked?.id?.id,
          camera: [
            app.viewer.camera.positionCartographic.longitude,
            app.viewer.camera.positionCartographic.latitude,
            app.viewer.camera.positionCartographic.height,
          ],
          icon,
        };
        return picked?.id?.id === 'chester-county-ems:ems:F26000001';
      },
      { timeout: 45000 },
    )
    .catch(async (error) => {
      console.log(
        'Icon pick diagnostics:',
        await page.evaluate(() => window.__emsPick),
      );
      throw error;
    });
  const icon = await page.evaluate(() => window.__emsIcon);
  await page.mouse.click(icon.x, icon.y);
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '#chester-county-panel button[data-list-item-id="ems:F26000001"]',
        )
        ?.getAttribute('aria-pressed') === 'true',
  );
  await page.waitForFunction(() =>
    [...window.__emsPaintedText].some(
      (text) => text.includes('MEDIC01') && text.includes('On Scene'),
    ),
  );
  assert.equal(
    await page.evaluate(() =>
      [...window.__emsPaintedText].some((text) =>
        text.includes('Approximate intersection'),
      ),
    ),
    false,
  );
  // Empty map space dismisses the card; list selection remains available.
  await page.mouse.click(800, 800);
  await page.waitForFunction(
    () =>
      document
        .querySelector('button[data-list-item-id="ems:F26000001"]')
        ?.getAttribute('aria-pressed') === 'false',
  );
  const item = await page.waitForSelector(incidentSelector, { visible: true });
  await item.click();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await page
    .locator(
      '#chester-county-panel button[data-list-item-id="montgomery-pa:ems:E2600001"]',
    )
    .click();
  await page.waitForFunction(() =>
    [...window.__emsPaintedText].some((text) => text.includes('MONTCO01')),
  );
  await mkdir('qa-shots/chester-county-ems', { recursive: true });
  await page.evaluate(() => {
    for (const element of document.querySelectorAll(
      '#right-context-rail, #right-context-rail *',
    ))
      if (element.scrollTop) element.scrollTop = 0;
  });
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
  await page.waitForFunction(
    () =>
      document.querySelector('#chester-county-panel')?.hidden &&
      !document.querySelector('[data-rail-item="chester-county-panel"]'),
  );
  // Empty feeds retain the app while enabled; a later enable restores its launcher.
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('chester-county-ems', true, {
      origin: 'user',
    }),
  );
  await page.waitForSelector('[data-rail-item="chester-county-panel"]');
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('chester-county-ems', false, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () => !document.querySelector('[data-rail-item="chester-county-panel"]'),
  );
  console.log(
    'PASS: County EMS, Chester/Montgomery county and category filters, map/list selection, empty refresh, launcher hides on disable and returns on enable',
  );
} finally {
  await recorder?.stop();
  await browser.close();
}
