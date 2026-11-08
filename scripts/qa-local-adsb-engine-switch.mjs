import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=41.5340&lon=-90.5070&alt=20000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const strict = createStrict({ origin: base.origin, layers: ['local-adsb'] });
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
  await p.evaluateOnNewDocument(() => {
    const raw = window.fetch;
    window.fetch = function (input, ...args) {
      const url = new URL(input?.url ?? input, location.href);
      if (url.pathname === '/api/local-receivers/aircraft') {
        const at = Date.now();
        // Each poll reports the aircraft a little further north.
        const n = (window.qaAdsbPolls = (window.qaAdsbPolls ?? 0) + 1);
        return Promise.resolve(
          Response.json({
            configured: true,
            generatedAt: at,
            records: [
              {
                icao: 'abc123',
                callsign: 'LOCAL1',
                lat: 41.534 + 0.0002 * n,
                lon: -90.507,
                altitudeFt: 11000,
                groundSpeedKt: 180,
                trackDeg: 5,
                lastPositionAt: at,
                lastMessageAt: at,
                messageCount: 12 + n,
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
  await waitForEngine(p, 'navara');
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;

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
  // The selection hook the selectable layers share, by the row's own id.
  assert.ok(
    await p.evaluate(() =>
      window.qaAdsb.mod.selectById(window.qaAdsb.mod.getAllPositions()[0].id),
    ),
  );
  for (const kind of ['cesium', 'navara']) {
    await p.evaluate(() => {
      window.qaSelections = [];
    });
    await strict.switchTo(p, kind);
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
    await strict.passed(
      p,
      'local-adsb',
      'same decoder, receiver and feeds, one feed start, selection republished',
    );
    // Updates continue on the new engine: further polls move the aircraft.
    const before = await p.evaluate(() => ({
      polls: window.qaAdsbPolls,
      lat: window.qaAdsb.mod.getAnalystRecords()[0]?.lat,
      stamp: window.qaAdsb.mod.getStats().lastUpdate,
    }));
    await p.waitForFunction(
      (before) =>
        window.qaAdsbPolls >= before.polls + 2 &&
        window.qaAdsb.mod.getAnalystRecords()[0]?.lat > before.lat &&
        window.qaAdsb.mod.getStats().lastUpdate > before.stamp,
      { timeout: 15000 },
      before,
    );
    await strict.passed(
      p,
      'local-adsb',
      'receiver polls continue and move the selected aircraft',
      before,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS retained local decoder, receiver, marker and selection in both scenes',
  );
});
