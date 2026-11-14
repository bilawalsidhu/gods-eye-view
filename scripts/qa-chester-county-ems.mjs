#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

// Synthetic incident records only: no captured medical reports in evidence files.
const base = process.env.QA_BASE_URL || 'http://localhost:4173';
const profile = await mkdtemp(join(tmpdir(), 'gev-county-filters-'));
const launch = () => puppeteer.launch({
  userDataDir: profile,
  headless: true,
  executablePath: chromeExecutablePath(),
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    `--use-angle=${process.env.QA_BROWSER_ANGLE || 'swiftshader'}`,
    '--enable-webgl',
  ],
});
let browser = await launch();
let recorder;
try {
  let page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const installFixtures = () => {
    const original = window.fetch;
    window.__emsPaintedText = new Set();
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (
        /MEDIC01|MONTCO01|LANCASTER01|DELCO01|AMB02|Approximate intersection|Recent dispatch|Community source/.test(
          String(text),
        )
      )
        window.__emsPaintedText.add(String(text));
      return fillText.call(this, text, ...args);
    };
    let empty = false, extra = false;
    window.__emsListOnly = () => { extra = true; };
    window.__emsEmpty = () => {
      empty = true;
    };
    window.fetch = (input, options) => {
      if (String(input).includes('/api/county-ems/details?') && /york-pa|pike-pa/.test(String(input))) {
        const id = new URL(String(input), location.origin).searchParams.get('incident');
        return Promise.resolve(Response.json({ id, incidentNumber: id.startsWith('pike-pa:') ? '2611000001' : null,
          observedAt: Date.now(), fetchedAt: Date.now(), timestampBasis: 'retrieved', assignmentOnly: true, stale: false,
          units: [{ unit: id.startsWith('pike-pa:') ? 'PIKE01' : 'YORK01', status: 'Assigned', entered: '', enteredAt: null }],
        }));
      }
      if (
        String(input).includes('/api/county-ems/details?') &&
        /lancaster-pa|delaware-pa/.test(String(input))
      ) {
        const id = new URL(String(input), location.origin).searchParams.get(
          'incident',
        );
        const lancaster = id.startsWith('lancaster-pa:');
        return Promise.resolve(
          Response.json({
            id,
            incidentNumber: lancaster ? null : 'F26000011',
            observedAt: Date.now(),
            fetchedAt: Date.now(),
            timestampBasis: 'retrieved',
            assignmentOnly: true,
            stale: false,
            units: [
              {
                unit: lancaster ? 'LANCASTER01' : 'DELCO01',
                status: 'Assigned',
                entered: '',
                enteredAt: null,
              },
            ],
          }),
        );
      }
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
                {
                  id: 'lancaster-pa',
                  county: 'Lancaster County, PA',
                  count: empty ? 0 : 1,
                  observedAt: Date.now(),
                  fetchedAt: Date.now(),
                  stale: false,
                },
                {
                  id: 'delaware-pa',
                  county: 'Delaware County, PA',
                  count: empty ? 0 : 1,
                  observedAt: Date.now(),
                  fetchedAt: Date.now(),
                  stale: false,
                  official: false,
                  coverageKind: 'recent-dispatches',
                  limited: true,
                  timestampBasis: 'retrieved',
                },
              ],
              locationCoverage: {
                matched: empty ? 0 : 6,
                unmatched: empty ? 0 : 1,
                unavailable: 0,
              },
              rows: empty
                ? []
                : extra ? [
                  { id: 'york-pa:ems:' + 'b'.repeat(24), incidentNumber: null, countyId:'york-pa', category:'ems',type:'SYNTHETIC YORK TEST',location:'EXAMPLE ST',municipality:'TEST TWP',crossStreets:'ONE ST',nearestIntersection:'TWO ST / THREE ST',box:'01-01',dispatched:'11/3/2026 11:00 PM',timePrecision:'minute',detailUrl:'https://ycdes.org/webcad/Details.aspx?abc+/==',mapPosition:null,locationStatus:'not-published' },
                  { id: 'pike-pa:fire:2611000001',incidentNumber:'2611000001',countyId:'pike-pa',category:'fire',type:'SYNTHETIC PIKE TEST',location:'EXAMPLE ST',municipality:'TEST TWP',dispatched:'11/3/2026 23:00:00',timeBasis:'received',reportKind:'completed',official:true,detailUrl:'https://webcad.pikepa.org/pages/public/FeedReader.asp',mapPosition:null,locationStatus:'not-published' },
                ] : [
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
                        id: 'lancaster-pa:ems:' + 'a'.repeat(24),
                        incidentNumber: null,
                        category: 'ems',
                        countyId: 'lancaster-pa',
                        type: 'SYNTHETIC LANCASTER TEST',
                        location: 'EXAMPLE RD & TEST ST',
                        municipality: 'Example Township',
                        station: '01',
                        dispatched: 'Tue, Nov 3, 2026 10:00',
                        detailUrl: 'https://www.lcwc911.us/live-incident-list',
                        mapPosition: {
                          lat: 39.962,
                          lon: -75.6065,
                          kind: 'county-published',
                          approximate: true,
                        },
                      },
                      {
                        id: 'delaware-pa:fire:F26000011',
                        incidentNumber: 'F26000011',
                        category: 'fire',
                        countyId: 'delaware-pa',
                        reportKind: 'dispatch',
                        official: false,
                        timeBasis: 'received',
                        timezoneAssumed: true,
                        sourceName: 'Delco Dispatch',
                        type: 'SYNTHETIC DELCO PAGE',
                        receivedAt: Date.now() - 60000,
                        dispatched: new Date(Date.now() - 60000).toLocaleString(
                          'en-US',
                          { timeZone: 'America/New_York' },
                        ),
                        location: 'EXAMPLE RD',
                        municipality: 'Example Township',
                        station: 'SYNTHETIC STATION',
                        detailUrl: 'https://delcodispat.ch/d/pa/delco',
                        mapPosition: {
                          lat: 39.963,
                          lon: -75.607,
                          kind: 'community-published',
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
  };
  await page.evaluateOnNewDocument(installFixtures);
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
  assert.equal(result.count, 7);
  assert.equal(result.degraded, false);
  assert.equal(result.list, 7);
  assert.match(result.info, /6 mapped · 1 unresolved · 0 lookup errors/);
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
  assert.equal(await page.$$eval('[data-layer-id="chester-county-ems"] [data-chip-id^="county:"]', nodes => nodes.length), 0);
  assert.equal(await page.$$eval('[data-county-filter]', nodes => nodes.length), 9);
  assert.equal(await page.$eval('[data-county-filter="pike-pa"]', input => input.checked), false);
  assert.match(await page.$eval('.county-coverage', node => node.textContent), /Completed reports only/);
  for (const county of ['montgomery-pa', 'lancaster-pa', 'delaware-pa']) {
    await page.locator('[data-county-filter="' + county + '"]').click();
    await page.waitForFunction(id => !document.querySelector('[data-county-filter="' + id + '"]').checked, {}, county);
    assert.equal(await page.$$eval('#chester-county-panel button[data-list-item-id]', rows => rows.length), 6);
    await page.locator('[data-county-filter="' + county + '"]').click();
    await page.waitForFunction(id => document.querySelector('[data-county-filter="' + id + '"]').checked, {}, county);
  }
  await page.locator('.county-source-details summary').click();
  assert.equal(await page.$$eval('[data-county-action^="source:"]', buttons => buttons.length), 0);
  await page.locator('.county-source-details summary').click();
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
        ? { icons: 3, rows: 3, total: 7 }
        : category === 'fire'
          ? { icons: 4, rows: 5, total: 7 }
          : { icons: 5, rows: 6, total: 7 },
    );
    await page.locator(`[data-county-category="${category}"]`).click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '#chester-county-panel button[data-list-item-id]',
        ).length === 7,
    );
    assert.deepEqual(await visibleCounts(), { icons: 6, rows: 7, total: 7 });
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
  await page
    .locator(
      '#chester-county-panel button[data-list-item-id="lancaster-pa:ems:' +
        'a'.repeat(24) +
        '"]',
    )
    .click();
  await page.waitForFunction(() =>
    [...window.__emsPaintedText].some((text) => text.includes('LANCASTER01')),
  );
  await page
    .locator(
      '#chester-county-panel button[data-list-item-id="delaware-pa:fire:F26000011"]',
    )
    .click();
  await page.waitForFunction(() =>
    [...window.__emsPaintedText].some((text) => text.includes('DELCO01')),
  );
  assert.ok(
    await page.evaluate(() =>
      [...window.__emsPaintedText].some((text) =>
        text.includes('Recent dispatch; active status unknown'),
      ),
    ),
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
  // Sources without coordinates still expose their public units in the app.
  await page.evaluate(async () => { window.__emsListOnly(); await window.__godsEyeView.dataManager.layers.get('chester-county-ems').module.update(); });
  assert.equal(await page.$$eval('#chester-county-panel button[data-list-item-id]', rows => rows.length), 1);
  await page.locator('#chester-county-panel button[data-list-item-id^="york-pa:"]').click();
  await page.waitForFunction(() => document.querySelector('.county-selection')?.textContent.includes('YORK01'));
  assert.match(await page.$eval('.county-selection', node => node.textContent), /No published map location/);
  assert.match(await page.$eval('.county-selection', node => node.textContent), /Nearest intersection: TWO ST/);
  await page.locator('[data-county-filter="pike-pa"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#chester-county-panel button[data-list-item-id]').length === 2);
  await page.locator('#chester-county-panel button[data-list-item-id^="pike-pa:"]').click();
  await page.waitForFunction(() => document.querySelector('.county-selection')?.textContent.includes('PIKE01'));
  assert.match(await page.$eval('.county-selection', node => node.textContent), /Completed report; not an active incident/);
  await page.$eval('.county-selection', node => node.scrollIntoView({block:'center'}));
  await page.screenshot({path:'qa-shots/chester-county-ems/list-only.png'});
  assert.equal(await page.$$eval('[data-county-action^="source:"]', buttons => buttons.length), 0);
  // Real localStorage must survive a new document and a completely new browser process.
  const mixed = { categories: ['ems'], counties: ['montgomery-pa', 'pike-pa'] };
  await page.evaluate(async params => {
    await window.__godsEyeView.dataManager.setLayerParams('chester-county-ems', params, { origin: 'user' });
  }, mixed);
  const waitForFilters = expected => page.waitForFunction(expected => {
    const app = window.__godsEyeView;
    const params = app?.dataManager?.layers.get('chester-county-ems')?.module?.getParams?.();
    return app?.dataManager?.isEnabled('chester-county-ems') && JSON.stringify(params) === JSON.stringify(expected);
  }, {timeout:60000}, expected);
  await page.goto('about:blank');
  await page.goto(base + '/?welcome=0', {waitUntil:'domcontentloaded',timeout:60000});
  await waitForFilters(mixed);
  assert.deepEqual(await page.$$eval('[data-county-filter]:checked', inputs => inputs.map(input => input.dataset.countyFilter)), mixed.counties);
  assert.equal(await page.$eval(layerChip('ems'), button => button.getAttribute('aria-pressed')), 'true');
  assert.equal(await page.$eval(layerChip('fire'), button => button.getAttribute('aria-pressed')), 'false');
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.setLayerParams('chester-county-ems', {categories:[],counties:[]}, {origin:'user'});
  });
  await recorder?.stop(); recorder = null;
  await browser.close();
  browser = await launch();
  page = await browser.newPage();
  await page.setViewport({width:1440,height:1000});
  await page.evaluateOnNewDocument(installFixtures);
  await page.goto(base + '/?welcome=0', {waitUntil:'domcontentloaded',timeout:60000});
  await waitForFilters({categories:[],counties:[]});
  assert.equal(await page.$$eval('[data-county-filter]:checked', inputs => inputs.length), 0);
  assert.equal(await page.$$eval('[data-county-category][aria-pressed="true"]', buttons => buttons.length), 0);
  assert.equal(await page.$$eval('#chester-county-panel button[data-list-item-id]', rows => rows.length), 0);
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
    'PASS: County EMS, nine county checkboxes in app only, synchronized category filters, list-only public units, opt-in Pike completed reports, Lancaster assignments and Delco dispatch provenance, map/list selection, empty refresh, launcher hides on disable and returns on enable, mixed/empty filters survive reload and full browser restart',
  );
} finally {
  await recorder?.stop();
  await browser.close();
  await rm(profile, {recursive:true,force:true});
}
