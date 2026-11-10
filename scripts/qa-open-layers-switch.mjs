import { whenSettled } from './qa/ready.mjs';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';

// Drone airspace, OSM places, sea marks and ski pistes on both engines, over
// Navara → Cesium → Navara: each draws over the view centre, and the switch
// keeps the same layer models with their data (no refetch, the places and
// the overlays still on).
//
//   node scripts/qa-open-layers-switch.mjs http://127.0.0.1:4208

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0';
base.hash =
  'v=2&lat=38.9000&lon=-77.0300&alt=30000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';

// One prohibited zone over the view centre (P-56's place, enlarged).
const RING = [
  [-77.06, 38.88],
  [-77.0, 38.88],
  [-77.0, 38.92],
  [-77.06, 38.92],
  [-77.06, 38.88],
];
const PLACES = [
  { id: 'node/1', name: 'QA Clinic', lat: 38.9, lon: -77.03, tags: {} },
  { id: 'node/2', name: 'QA Hospital', lat: 38.905, lon: -77.02, tags: {} },
  { id: 'node/3', name: '', lat: 38.895, lon: -77.04, tags: {} },
];
// The overlays' tiles: half-transparent tints, one per overlay, so the
// view centre takes the colour of whichever is on.
const tint = (r, g, b) =>
  sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: { r, g, b, alpha: 0.6 },
    },
  })
    .png()
    .toBuffer();
const TILES = {
  'sea-marks': await tint(255, 0, 255),
  'ski-pistes': await tint(0, 255, 0),
};
const tileRoute = (pattern, id) => ({
  pattern,
  respond: () => ({ status: 200, contentType: 'image/png', body: TILES[id] }),
});
const LAYERS = ['drone-airspace', 'osm-places', 'sea-marks', 'ski-pistes'];
const strict = createStrict({
  origin: base.origin,
  layers: LAYERS,
  routes: [
    tileRoute('https://tiles.openseamap.org/*', 'sea-marks'),
    tileRoute('https://www.opensnowmap.org/*', 'ski-pistes'),
  ],
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
  await p.evaluateOnNewDocument((ring) => {
    const fetch = window.fetch.bind(window);
    window.qaZoneReads = 0;
    window.fetch = (input, options) => {
      const { pathname } = new URL(input.url ?? input, document.baseURI);
      if (pathname === '/api/drone-airspace') {
        window.qaZoneReads++;
        return Promise.resolve(
          Response.json({
            rows: [
              {
                stableId: '310',
                name: 'QA Zone',
                typeCode: 'P',
                type: 'Prohibited',
                lowerAltitude: 'SFC',
                upperAltitude: '18,000 ft MSL',
                timesOfUse: 'CONTINUOUS',
                agency: null,
                city: 'WASHINGTON',
                state: 'DC',
                polygons: [[ring]],
              },
            ],
            stale: false,
            fetchedAt: Date.now(),
          }),
        );
      }
      // OSM Places asks whether an Overpass is configured.
      if (pathname === '/api/overpass/status')
        return Promise.resolve(Response.json({ configured: true }));
      return fetch(input, options);
    };
  }, RING);
  await p.goto(base.href);
  const setEnabled = (id, on) =>
    p.evaluate(
      (layerId, show) =>
        window.__godsEyeView.dataManager.setEnabled(layerId, show, {
          origin: 'user',
        }),
      id,
      on,
    );
  // The view centre once the globe has settled and drawn a frame.
  const sample = async () => {
    await p.waitForFunction(
      () => {
        const d = window.__godsEyeView;
        if (!d?.engine) return false;
        d.engine.render.request('qa-open-settle');
        if (!d.engine.surface.tilesLoaded()) {
          window.__qaSettledSince = null;
          return false;
        }
        window.__qaSettledSince ??= performance.now();
        return performance.now() - window.__qaSettledSince > 1200;
      },
      { polling: 100, timeout: 30000 },
    );
    await p.evaluate(() => {
      window.__qaSettledSince = null;
      return new Promise((resolve) => {
        const { engine } = window.__godsEyeView;
        const remove = engine.frames.postRender.addEventListener(() => {
          remove();
          requestAnimationFrame(() => resolve());
        });
        engine.render.request('qa-open');
      });
    });
    // stats() reads the whole input, so the patch is cut out first.
    const patch = await sharp(await p.screenshot())
      .extract({ left: 492, top: 369, width: 40, height: 30 })
      .removeAlpha()
      .png()
      .toBuffer();
    const { channels } = await sharp(patch).stats();
    return channels.map((channel) => channel.mean);
  };
  // Until the layer shows over `off` by `test`, for at most 20 s (the
  // engines draw clamped polygons and imagery a few frames after their data).
  const shows = async (off, test) => {
    const deadline = Date.now() + 20000;
    let on = await sample();
    while (!test(on, off) && Date.now() < deadline) {
      await whenSettled(p);
      on = await sample();
    }
    return on;
  };
  const redder = (on, off) => on[0] - on[2] > off[0] - off[2] + 5;
  const magenta = (on, off) =>
    on[0] + on[2] - 2 * on[1] > off[0] + off[2] - 2 * off[1] + 10;
  const greener = (on, off) =>
    2 * on[1] - on[0] - on[2] > 2 * off[1] - off[0] - off[2] + 10;

  await waitForEngine(p, 'navara');
  await p.evaluate(() => {
    const { dataManager } = window.__godsEyeView;
    window.qaModels = Object.fromEntries(
      ['drone-airspace', 'osm-places', 'sea-marks', 'ski-pistes'].map((id) => [
        id,
        dataManager.layers.get(id).module,
      ]),
    );
  });
  for (const [leg, kind] of ['navara', 'cesium', 'navara'].entries()) {
    const readsBeforeSwitch = await p.evaluate(() => window.qaZoneReads);
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
      const same = await p.evaluate(() =>
        Object.entries(window.qaModels).every(
          ([id, model]) =>
            window.__godsEyeView.dataManager.layers.get(id).module === model,
        ),
      );
      await strict.check(p, LAYERS, 'same layer models after the switch', same);
      // The zone stayed on across the switch: the next globe draws the rows
      // it already had, with no new request.
      const kept = await p.evaluate(() => ({
        reads: window.qaZoneReads,
        records: window.qaModels['drone-airspace'].getAnalystRecords().length,
      }));
      assert.deepEqual(
        kept,
        { reads: readsBeforeSwitch, records: 1 },
        `${kind}: the switch keeps the zone rows without a refetch`,
      );
    }

    // Drone airspace: the zone tints the centre red; after a switch it is
    // drawn from the rows already fetched.
    await setEnabled('drone-airspace', false);
    const zoneOff = await sample();
    await setEnabled('drone-airspace', true);
    if (leg === 0)
      await p.evaluate(() => window.qaModels['drone-airspace'].update());
    const zoneOn = await shows(zoneOff, redder);
    assert.ok(redder(zoneOn, zoneOff), `${kind} must draw the zone`);
    const zone = await p.evaluate(() => ({
      reads: window.qaZoneReads,
      records: window.qaModels['drone-airspace'].getAnalystRecords(),
    }));
    assert.equal(zone.records.length, 1);
    await strict.passed(p, 'drone-airspace', 'zone drawn over the centre', {
      off: zoneOff,
      on: zoneOn,
      reads: zone.reads,
    });
    console.log('PASS', kind, 'drone airspace zone');

    // The zone stays on for the switch; the overlays sample without it.
    // OSM places: the results stay with the model across the switch, and
    // the engine draws a point for each.
    if (leg === 0)
      await p.evaluate((places) => {
        window.qaModels['osm-places'].setResults(places, {
          kind: 'clinic',
          label: 'Clinics',
          area: 'Washington',
        });
      }, PLACES);
    await setEnabled('osm-places', true);
    const places = await p.evaluate(() => {
      const d = window.__godsEyeView;
      // Both engines draw the places as one movers point set.
      const drawn =
        d.engine.movers.list().find((set) => set.id === 'osm-places')?.count ??
        0;
      return {
        records: window.qaModels['osm-places'].getAnalystRecords().length,
        drawn,
      };
    });
    assert.deepEqual(places, { records: 3, drawn: 3 }, `${kind} places`);
    await strict.passed(
      p,
      'osm-places',
      'three places drawn as points',
      places,
    );
    console.log('PASS', kind, 'OSM places', JSON.stringify(places));
    await setEnabled('osm-places', false);

    // The overlays tint the centre with their tile; each on alone.
    await setEnabled('drone-airspace', false);
    for (const [id, test] of [
      ['sea-marks', magenta],
      ['ski-pistes', greener],
    ]) {
      const off = await sample();
      await setEnabled(id, true);
      const on = await shows(off, test);
      assert.ok(test(on, off), `${kind} must drape ${id}`);
      const stats = await p.evaluate(
        (layerId) => window.qaModels[layerId].getStats(),
        id,
      );
      assert.equal(stats.error, null);
      await strict.passed(p, id, 'overlay tiles draped over the centre', {
        off,
        on,
      });
      console.log('PASS', kind, id);
      await setEnabled(id, false);
    }
    await setEnabled('drone-airspace', true);
  }
  assert.deepEqual(errors, []);
});
