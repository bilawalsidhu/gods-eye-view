import { clickUntilSelected, whenFramesDrawn } from './qa/ready.mjs';
import { fromDegrees } from '../src/geo/cartesian3.js';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import {
  clickEmptyGround,
  createStrict,
  localPreview,
  openPage,
  waitForCameraAtRest,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=43.6500&lon=-79.3800&alt=46000&heading=0&pitch=-90&roll=0&map=sentinel2&l=4';
const strict = createStrict({
  origin: base.origin,
  layers: [
    'ais-live-vessels',
    'air-quality',
    'gnss-integrity',
    'fire-perimeters',
  ],
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
  await p.evaluateOnNewDocument(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, o) => {
      const url = new URL(input.url ?? input, document.baseURI);
      if (url.pathname === '/api/vessels/track') {
        window.qaVesselHistories = (window.qaVesselHistories ?? 0) + 1;
        return Promise.resolve(
          Response.json({ samples: [{ lat: 43.63, lon: -79.38 }] }),
        );
      }
      if (url.pathname === '/api/vessels') {
        return Promise.resolve(
          Response.json({
            status: 'live',
            rows: [
              {
                mmsi: '123456789',
                name: 'Toronto QA',
                lat: 43.65,
                lon: -79.38,
                last_position_epoch: Date.now() / 1000,
              },
            ],
          }),
        );
      }
      if (url.pathname.startsWith('/api/fire-perimeters/inciweb')) {
        return Promise.resolve(Response.json({ rows: [] }));
      }
      if (url.pathname === '/api/fire-perimeters') {
        const square = (dx) => [
          [-79.38 - dx, 43.65 - dx],
          [-79.38 + dx, 43.65 - dx],
          [-79.38 + dx, 43.65 + dx],
          [-79.38 - dx, 43.65 + dx],
          [-79.38 - dx, 43.65 - dx],
        ];
        return Promise.resolve(
          Response.json({
            rows: [
              {
                stableId: 'fire:fixture',
                name: 'QA Fire',
                acres: 500,
                containedPct: 40,
                polygons: [[square(0.09), square(0.018).reverse()]],
              },
            ],
          }),
        );
      }
      if (url.pathname === '/api/gnss-integrity') {
        return Promise.resolve(
          Response.json({
            ageMs: 0,
            rows: ['a1', 'a2', 'a3'].map((hex) => ({
              hex,
              lat: 43.65,
              lon: -79.38,
              nic: 0,
              nacp: 0,
              degraded: true,
              gpsLost: false,
            })),
          }),
        );
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
  const capture = async (visible, layerId = 'air-quality') => {
    await p.evaluate(
      async (show, id) => {
        const d = window.__godsEyeView;
        await d.dataManager.setEnabled(id, show, { origin: 'user' });
        d.engine.render.request('qa-air-quality');
      },
      visible,
      layerId,
    );
    // Ready to compare: the layer's data is in (when shown), the globe's
    // tiles under the view have loaded and stayed loaded, and a frame has
    // been drawn since.
    await p
      .waitForFunction(
        (show, id) => {
          const d = window.__godsEyeView;
          if (!d?.engine) return false;
          const module = d.dataManager.layers.get(id).module;
          const data =
            !show ||
            (id === 'air-quality'
              ? module.getAnalystRecords().length === 1
              : module.getStats().levels?.high === 1);
          const now = performance.now();
          // The engines draw on request: keep frames coming so tiles load.
          d.engine.render.request('qa-ground-settle');
          if (!data || !d.engine.surface.tilesLoaded()) {
            window.__qaSettledSince = null;
            return false;
          }
          window.__qaSettledSince ??= now;
          return now - window.__qaSettledSince > 1200;
        },
        { polling: 100, timeout: 30000 },
        visible,
        layerId,
      )
      .catch(async (error) => {
        console.log(
          'not settled',
          JSON.stringify(
            await p.evaluate((id) => {
              const d = window.__godsEyeView;
              const module = d?.dataManager.layers.get(id).module;
              return {
                engine: d?.engine?.kind,
                tiles: d?.engine?.surface.tilesLoaded(),
                records: module?.getAnalystRecords().length,
                stats: module?.getStats(),
              };
            }, layerId),
          ),
        );
        throw error;
      });
    // A frame drawn after the settle (the engine draws on request), then
    // the animation frame that presents it.
    await p.evaluate(
      () =>
        new Promise((resolve) => {
          const { engine } = window.__godsEyeView;
          const remove = engine.frames.postRender.addEventListener(() => {
            remove();
            requestAnimationFrame(() => resolve());
          });
          engine.render.request('qa-ground');
        }),
    );
    await p.evaluate(() => (window.__qaSettledSince = null));
    return sample();
  };
  const sample = async () => {
    const shot = await p.screenshot();
    return sharp(shot)
      .extract({ left: 537, top: 403, width: 22, height: 18 })
      .removeAlpha()
      .png()
      .toBuffer()
      .then((buf) => sharp(buf).stats());
  };
  // The layer shown, sampled until its polygon appears in the patch (the
  // engines draw a clamped polygon a few frames after its data, with no
  // signal for it), for at most 20 s; the comparison stays the same.
  const orangeOf = (v) => v.channels[0].mean - v.channels[2].mean;
  const drawn = async (off, layerId) => {
    const deadline = Date.now() + 20000;
    let on = await capture(true, layerId);
    while (orangeOf(on) <= orangeOf(off) + 5 && Date.now() < deadline) {
      await whenFramesDrawn(p);
      on = await sample();
    }
    return on;
  };
  await waitForEngine(p, 'navara');
  await p.evaluate(() => {
    const d = window.__godsEyeView;

    window.qaAir = d.dataManager.layers.get('air-quality').module;
    window.qaGnss = d.dataManager.layers.get('gnss-integrity').module;
  });
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
      const same = await p.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers.get('air-quality').module ===
            window.qaAir &&
          window.__godsEyeView.dataManager.layers.get('gnss-integrity')
            .module === window.qaGnss,
      );
      await strict.check(
        p,
        ['air-quality', 'gnss-integrity'],
        'same layer models after the switch',
        same,
      );
    }
    await p.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('gnss-integrity', false),
    );
    const off = await capture(false),
      on = await drawn(off, 'air-quality');
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
    await strict.passed(
      p,
      'air-quality',
      'AQHI 9 station footprint drawn, one card row',
      {
        off: orange(off),
        on: orange(on),
      },
    );
    await capture(false);
    const cellOff = await capture(false, 'gnss-integrity');
    const cellOn = await drawn(cellOff, 'gnss-integrity');
    assert.ok(
      orange(cellOn) > orange(cellOff) + 5,
      kind + ' must draw GNSS high cell',
    );
    const gnss = await p.evaluate(() => window.qaGnss.getStats());
    assert.equal(gnss.levels.high, 1);
    await strict.passed(p, 'gnss-integrity', 'one high GNSS cell drawn', {
      off: orange(cellOff),
      on: orange(cellOn),
    });
    console.log(
      'PASS',
      kind,
      'GNSS high cell, view anchor',
      gnss.coverage.latitude,
      gnss.coverage.longitude,
    );
    await p.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('air-quality', true),
    );
  }
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('air-quality', false);
    await dataManager.setEnabled('fire-perimeters', true, { origin: 'user' });
    window.qaFire = dataManager.layers.get('fire-perimeters').module;
    if (
      !dataManager.isEnabled('fire-perimeters') ||
      window.qaFire.getStats().count !== 1
    )
      throw Error(
        'Failed to enable fire perimeter fixture: ' +
          JSON.stringify(window.qaFire.getStats()),
      );
  });
  const card = async (visible) =>
    p.waitForFunction(
      (want) => {
        const canvas = document.getElementById('world-overlay-canvas');
        const data = canvas
          .getContext('2d')
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let pixels = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]) pixels++;
        return want ? pixels > 100 : pixels === 0;
      },
      { timeout: 15000 },
      visible,
    );
  const click = async (lon, lat) => {
    const { x, y } = await p.evaluate(
      (world) => {
        const { engine } = window.__godsEyeView;
        const point = engine.projector.worldToWindow(world, {});
        if (!point) throw Error('the point is not in view');
        const box = engine.host.canvas.getBoundingClientRect();
        return { x: box.left + point.x, y: box.top + point.y };
      },
      fromDegrees(lon, lat),
    );
    await p.mouse.click(x, y);
  };
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
      await card(true);
      await strict.check(
        p,
        'fire-perimeters',
        'same model; the incident card survives the switch',
        await p.evaluate(
          () =>
            window.qaFire ===
            window.__godsEyeView.dataManager.layers.get('fire-perimeters')
              .module,
        ),
      );
    }
    await click(-79.51, 43.65);
    await card(false);
    await strict.passed(
      p,
      'fire-perimeters',
      'a click outside the perimeter clears the card',
    );
    await click(-79.435, 43.65);
    await card(true);
    await strict.check(
      p,
      'fire-perimeters',
      'a click on the ring selects the fire',
      await p.evaluate(() => window.qaFire.getSelectedInfo?.()?.id ?? true),
    );
    // Not vacuous: the fire is selected, so the card only goes when the
    // click in the hole is handled as a click outside the polygon.
    await click(-79.38, 43.65);
    await card(false);
    await strict.passed(
      p,
      'fire-perimeters',
      'a click in the hole deselects the selected fire',
    );
    await click(-79.435, 43.65);
    await card(true);
    console.log(
      'PASS',
      kind,
      'select fire under GNSS, exclude hole, retain incident card',
    );
  }
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;
    for (const id of ['gnss-integrity', 'fire-perimeters', 'air-quality'])
      await dataManager.setEnabled(id, false);
    await dataManager.setEnabled('ais-live-vessels', true, { origin: 'user' });
    window.qaVesselEntry = dataManager.layers.get('ais-live-vessels');
  });
  await p.waitForFunction(
    () => window.qaVesselEntry.module.qaDrawn()?.chevrons[0]?.show,
  );
  const selectVessel = () =>
    clickUntilSelected(
      p,
      async () => {
        const { x, y } = await p.evaluate(() => {
          const { engine } = window.__godsEyeView;
          const vessel = window.qaVesselEntry.module
            .qaDrawn()
            .chevrons.find((row) => row.id === '123456789' && row.show);
          const point =
            vessel && engine.projector.worldToWindow(vessel.position);
          if (!point) throw Error('the vessel is not in view');
          const box = engine.host.canvas.getBoundingClientRect();
          return { x: box.left + point.x, y: box.top + point.y };
        });
        // Vessels also resolve painted-card hits in their click handler;
        // picker.pick cannot see those. Retry at the live anchor, including
        // its sea datum, and verify selection through the real click path.
        await p.mouse.click(x, y);
      },
      () => window.qaVesselEntry.module.getSelectedInfo()?.mmsi === '123456789',
    );
  // Click-picking on the running engine: clear the selection with a click on
  // empty water, then select the vessel with a click on its chevron.
  const pickVessel = async () => {
    // The last selection flies the camera to the vessel, and a click does
    // not cut that flight short: click once it has landed.
    await waitForCameraAtRest(p);
    // Empty ground: a point in the middle of the view where the engine
    // picks nothing and nothing covers the canvas.
    await clickEmptyGround(p, {
      left: 300,
      top: 220,
      right: 720,
      bottom: 560,
      step: 11,
      radius: 10,
    });
    await p.waitForFunction(
      () => !window.qaVesselEntry.module.getSelectedInfo(),
    );
    await selectVessel();
    await strict.passed(
      p,
      'ais-live-vessels',
      'a click on the chevron selects the vessel',
    );
    // The next switch starts from the landed view.
    await waitForCameraAtRest(p);
  };
  await selectVessel();
  await strict.passed(
    p,
    'ais-live-vessels',
    'a click on the chevron selects the vessel',
  );
  let histories = await p.evaluate(() => window.qaVesselHistories);
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
    }
    const sample = await p.evaluate(() => {
      const entry =
        window.__godsEyeView.dataManager.layers.get('ais-live-vessels');
      const drawn = entry.module.qaDrawn();
      return {
        retained: entry === window.qaVesselEntry,
        selected: entry.module.getSelectedInfo()?.mmsi,
        chevron: drawn.chevrons.find((c) => c.selected && c.show)?.id,
        card: drawn.cards.find((c) => c.selected)?.id,
        histories: window.qaVesselHistories,
      };
    });
    assert.deepEqual(
      sample,
      {
        retained: true,
        selected: '123456789',
        chevron: '123456789',
        card: 'vessel:123456789',
        histories,
      },
      kind,
    );
    await strict.passed(
      p,
      'ais-live-vessels',
      'same entry; selection, chevron and card kept; no new track request',
    );
    if (kind === 'cesium' || histories === 1) {
      await pickVessel();
      histories = await p.evaluate(() => window.qaVesselHistories);
    }
    console.log(
      'PASS',
      kind,
      'retained selected AIS vessel, chevron, card and single track request',
    );
  }
  assert.deepEqual(errors, []);
});
