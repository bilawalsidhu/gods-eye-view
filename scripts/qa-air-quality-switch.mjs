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
  const capture = async (visible) => {
    await p.evaluate(async (show) => {
      const d = window.__godsEyeView;
      await d.dataManager.setEnabled('air-quality', show, { origin: 'user' });
      d.engine.render.request('qa-air-quality');
    }, visible);
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
  });
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.select('#globe-engine', kind);
      await ready(kind);
      const same = await p.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers.get('air-quality').module ===
          window.qaAir,
      );
      assert.ok(same);
    }
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
  }
  assert.deepEqual(errors, []);
} finally {
  await b.close();
}
