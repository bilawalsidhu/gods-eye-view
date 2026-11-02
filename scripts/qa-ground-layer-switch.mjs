import { fromDegrees } from '../src/geo/cartesian3.js';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { blockPaidQaMaps } from './qa-map-policy.mjs';

const base = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    base.port,
  )
)
  throw new Error('Supply an unreserved local keyless preview URL');
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=43.6500&lon=-79.3800&alt=46000&heading=0&pitch=-90&roll=0&map=sentinel2&l=4';
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await b.newPage();
  await blockPaidQaMaps(p);
  await p.setViewport({ width: 1024, height: 768 });
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message.split('?')[0]);
  });
  await p.evaluateOnNewDocument(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, o) => {
      const url = new URL(input.url ?? input, document.baseURI);
      if (url.pathname === '/api/vessels/track') {
        window.qaVesselHistories = (window.qaVesselHistories ?? 0) + 1;
        return Promise.resolve(Response.json({ samples: [{lat: 43.63, lon: -79.38}] }));
      }
      if (url.pathname === '/api/vessels') {
        return Promise.resolve(Response.json({status: 'live', rows: [{
          mmsi: '123456789', name: 'Toronto QA', lat: 43.65, lon: -79.38,
          last_position_epoch: Date.now() / 1000,
        }]}));
      }
      if (url.pathname.startsWith('/api/fire-perimeters/inciweb')) {
        return Promise.resolve(Response.json({ rows: [] }));
      }
      if (url.pathname === '/api/fire-perimeters') {
        const square = (dx) => [
          [-79.38-dx,43.65-dx],[-79.38+dx,43.65-dx],[-79.38+dx,43.65+dx],
          [-79.38-dx,43.65+dx],[-79.38-dx,43.65-dx],
        ];
        return Promise.resolve(Response.json({rows: [{
          stableId: 'fire:fixture', name:'QA Fire', acres:500, containedPct:40,
          polygons:[[square(0.09), square(0.018).reverse()]],
        }]}));
      }
      if (url.pathname === '/api/gnss-integrity') {
        return Promise.resolve(Response.json({ageMs: 0, rows: ['a1','a2','a3'].map(hex =>
          ({hex, lat: 43.65, lon: -79.38, nic: 0, nacp: 0, degraded: true, gpsLost: false}))}));
      }
      if (url.hostname === 'api.weather.gc.ca') {
        const records = url.pathname.includes('aqhi-stations')
          ? [
              {
                geometry: { type: 'Point', coordinates: [-79.38, 43.65] },
                properties: {
                  location_id: 'QA1',
                  location_name_en: 'QA Toronto',
                },
              },
            ]
          : [
              {
                properties: {
                  location_id: 'QA1',
                  aqhi: 9,
                  observation_datetime: new Date().toISOString(),
                },
              },
            ];
        return Promise.resolve(
          Response.json({
            type: 'FeatureCollection',
            features: records.map((f) => ({ type: 'Feature', ...f })),
          }),
        );
      }
      return fetch(input, o);
    };
  });
  await p.goto(base.href);
  const ready = async (kind) => {
    await p.waitForFunction(
      (k) =>
        window.__godsEyeView?.engine.kind === k &&
        !document.querySelector('#globe-engine')?.disabled &&
        !document.querySelector('.engine-switch-frame') &&
        document.querySelector('#loading-screen.hidden'),
      { timeout: 90000 },
      kind,
    );
    await p.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
  };
  const capture = async (visible, layerId = 'air-quality') => {
    await p.evaluate(async (show, id) => {
      const d = window.__godsEyeView;
      await d.dataManager.setEnabled(id, show, { origin: 'user' });
      d.engine.render.request('qa-air-quality');
    }, visible, layerId);
    await new Promise((r) => setTimeout(r, 3900));
    const shot = await p.screenshot();
    return sharp(shot)
      .extract({ left: 537, top: 403, width: 22, height: 18 })
      .removeAlpha()
      .png()
      .toBuffer()
      .then((buf) => sharp(buf).stats());
  };
  await ready('navara');
  await p.evaluate(() => {
    const d = window.__godsEyeView;
    if (d.tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Keyless required');
    window.qaAir = d.dataManager.layers.get('air-quality').module;
    window.qaGnss = d.dataManager.layers.get('gnss-integrity').module;
  });
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.select('#globe-engine', kind);
      await ready(kind);
      const same = await p.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers.get('air-quality').module ===
          window.qaAir &&
          window.__godsEyeView.dataManager.layers.get('gnss-integrity').module === window.qaGnss,
      );
      assert.ok(same);
    }
    await p.evaluate(() => window.__godsEyeView.dataManager.setEnabled('gnss-integrity', false));
    const off = await capture(false),
      on = await capture(true);
    const values = await p.evaluate(() => ({
      records: window.qaAir.getAnalystRecords(),
      card: window.qaAir.getRowControls().list.items,
      stats: window.qaAir.getStats(),
    })); // An interior patch away from the label must take on the high-risk orange.
    const orange = (v) => v.channels[0].mean - v.channels[2].mean;
    assert.ok(
      orange(on) > orange(off) + 5,
      kind + ' must draw the station footprint',
    );
    console.log(
      'PASS',
      kind,
      values.records[0].id,
      'AQHI',
      values.records[0].value,
    );
    assert.equal(values.records[0].name, 'QA Toronto');
    assert.equal(values.records[0].value, 9);
    assert.equal(values.card.length, 1);
    await capture(false);
    const cellOff = await capture(false, 'gnss-integrity');
    const cellOn = await capture(true, 'gnss-integrity');
    assert.ok(orange(cellOn) > orange(cellOff) + 5, kind + ' must draw GNSS high cell');
    const gnss = await p.evaluate(() => window.qaGnss.getStats());
    assert.equal(gnss.levels.high, 1);
    console.log('PASS', kind, 'GNSS high cell, view anchor', gnss.coverage.latitude, gnss.coverage.longitude);
    await p.evaluate(() => window.__godsEyeView.dataManager.setEnabled('air-quality', true));
  }
  await p.evaluate(async () => {
    const {dataManager} = window.__godsEyeView;
    await dataManager.setEnabled('air-quality', false);
    await dataManager.setEnabled('fire-perimeters', true, {origin: 'user'});
    window.qaFire = dataManager.layers.get('fire-perimeters').module;
    if (!dataManager.isEnabled('fire-perimeters') || window.qaFire.getStats().count !== 1)
      throw Error('Failed to enable fire perimeter fixture: '+JSON.stringify(window.qaFire.getStats()));
  });
  const card = async (visible) => p.waitForFunction((want) => {
    const canvas = document.getElementById('world-overlay-canvas');
    const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let pixels = 0;
    for (let i=3; i<data.length; i+=4) if (data[i]) pixels++;
    return want ? pixels > 100 : pixels === 0;
  }, {timeout: 15000}, visible);
  const click = async (lon, lat) => {
    const {x, y} = await p.evaluate((world) => {
      const {engine} = window.__godsEyeView;
      const point = engine.projector.worldToWindow(world, {});
      const box = engine.host.canvas.getBoundingClientRect();
      return { x: box.left+point.x, y: box.top+point.y };
    }, fromDegrees(lon, lat));
    await p.mouse.click(x,y);
  };
  for (const kind of ['navara', 'cesium', 'navara']) {
    if (await p.evaluate(() => window.__godsEyeView.engine.kind) !== kind) {
      await p.select('#globe-engine', kind);
      await ready(kind);
      await card(true);
      assert.ok(await p.evaluate(() => window.qaFire === window.__godsEyeView.dataManager.layers.get('fire-perimeters').module));
    }
    await click(-79.51, 43.65);
    await card(false);
    await click(-79.38, 43.65);
    await new Promise(resolve => setTimeout(resolve, 500));
    await card(false);
    await click(-79.435, 43.65);
    await card(true);
    console.log('PASS', kind, 'select fire under GNSS, exclude hole, retain incident card');
  }
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;
    for (const id of ['gnss-integrity', 'fire-perimeters', 'air-quality'])
      await dataManager.setEnabled(id, false);
    await dataManager.setEnabled('ais-live-vessels', true, { origin: 'user' });
    window.qaVesselEntry = dataManager.layers.get('ais-live-vessels');
  });
  await p.waitForFunction(() => window.qaVesselEntry.module.qaDrawn()?.chevrons[0]?.show);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await click(-79.38, 43.65);
  await p.waitForFunction(() => window.qaVesselEntry.module.getSelectedInfo()?.mmsi === '123456789');
  for (const kind of ['navara', 'cesium', 'navara']) {
    if (await p.evaluate(() => window.__godsEyeView.engine.kind) !== kind) {
      await p.select('#globe-engine', kind);
      await ready(kind);
    }
    const sample = await p.evaluate(() => {
      const entry = window.__godsEyeView.dataManager.layers.get('ais-live-vessels');
      const drawn = entry.module.qaDrawn();
      return {
        retained: entry === window.qaVesselEntry,
        selected: entry.module.getSelectedInfo()?.mmsi,
        chevron: drawn.chevrons.find((c) => c.selected && c.show)?.id,
        card: drawn.cards.find((c) => c.selected)?.id,
        histories: window.qaVesselHistories,
      };
    });
    assert.deepEqual(sample, {
      retained: true, selected: '123456789', chevron: '123456789',
      card: 'vessel:123456789', histories: 1,
    }, kind);
    console.log('PASS', kind, 'retained selected AIS vessel, chevron, card and single track request');
  }
  assert.deepEqual(errors, []);
} finally {
  await b.close();
}
