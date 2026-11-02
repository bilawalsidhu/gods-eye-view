import puppeteer from 'puppeteer';
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
  'v=2&lat=41.5340&lon=-90.5070&alt=20000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
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
    const raw = window.fetch;
    window.fetch = function (input, ...args) {
      const url = new URL(input?.url ?? input, location.href);
      if (url.pathname === '/api/local-receivers/aircraft') {
        const at = Date.now();
        return Promise.resolve(
          Response.json({
            configured: true,
            generatedAt: at,
            records: [
              {
                icao: 'abc123',
                callsign: 'LOCAL1',
                lat: 41.534,
                lon: -90.507,
                altitudeFt: 11000,
                groundSpeedKt: 180,
                trackDeg: 5,
                lastPositionAt: at,
                lastMessageAt: at,
                messageCount: 12,
                band: '1090',
                source: 'decoder',
              },
            ],
          }),
        );
      }
      return raw.call(this, input, ...args);
    };
    window.qaSelections = [];
    window.addEventListener('gev:entity-selected', ({ detail }) =>
      window.qaSelections.push(detail.id),
    );
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
  await ready('navara');
  await p.evaluate(async () => {
    const { dataManager, tileset } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Keyless preview required');
    const mod = dataManager.layers.get('local-adsb').module;
    window.qaAdsb = {
      mod,
      receiver: mod.receiver,
      feeds: mod.feeds,
      starts: 0,
      stops: 0,
      closes: 0,
    };
    for (const [obj, key, counter] of [
      [mod.receiver, 'destroy', 'closes'],
      [mod.feeds, 'start', 'starts'],
      [mod.feeds, 'stop', 'stops'],
    ]) {
      const original = obj[key].bind(obj);
      obj[key] = (...args) => {
        window.qaAdsb[counter]++;
        return original(...args);
      };
    }
    await dataManager.setEnabled('local-adsb', true, { origin: 'user' });
  });
  await p.waitForFunction(
    () => window.qaAdsb.mod.getAllPositions().length === 1,
  );
  assert.ok(await p.evaluate(() => window.qaAdsb.mod.selectAircraft('abc123')));
  for (const kind of ['cesium', 'navara']) {
    await p.evaluate(() => {
      window.qaSelections = [];
    });
    await p.select('#globe-engine', kind);
    await ready(kind);
    await p.waitForFunction(() =>
      window.qaSelections.includes('local-adsb:abc123'),
    );
    const result = await p.evaluate(() => {
      const q = window.qaAdsb,
        manager = window.__godsEyeView.dataManager;
      const mod = manager.layers.get('local-adsb').module;
      return [
        manager.isEnabled(mod.id),
        q.mod === mod,
        q.receiver === mod.receiver,
        q.feeds === mod.feeds,
        mod.getAllPositions()[0]?.id,
        q.starts,
        q.stops,
        q.closes,
      ];
    });
    assert.deepEqual(result, [true, true, true, true, 'abc123', 1, 0, 0]);
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS retained local decoder, receiver, marker and selection in both scenes',
  );
} finally {
  await b.close();
}
