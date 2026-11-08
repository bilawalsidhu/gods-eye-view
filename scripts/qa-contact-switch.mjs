import assert from 'node:assert/strict';
import { fromDegrees } from '../src/geo/cartesian3.js';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=43.6500&lon=-79.3800&alt=46000&heading=0&pitch=-90&roll=0&map=sentinel2&l=4';
const strict = createStrict({
  origin: base.origin,
  layers: ['military-awareness', 'military-installations'],
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
  await p.evaluateOnNewDocument(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const { pathname } = new URL(input.url ?? input, document.baseURI);
      if (pathname === '/api/vessels')
        return Promise.resolve(
          Response.json({
            status: 'live',
            rows: ['123456789', '223456789'].map((mmsi, i) => ({
              mmsi,
              name: 'Toronto ' + i,
              lat: 43.65,
              lon: -79.38 + i * 0.05,
              last_position_epoch: Date.now() / 1000,
            })),
          }),
        );
      // Contacts reads air quality near the subject; no station here.
      if (
        new URL(input.url ?? input, document.baseURI).hostname ===
        'api.weather.gc.ca'
      )
        return Promise.resolve(
          Response.json({ type: 'FeatureCollection', features: [] }),
        );
      if (pathname === '/api/vessels/track')
        return Promise.resolve(Response.json({ samples: [] }));
      if (pathname === '/api/flights')
        return Promise.resolve(
          Response.json({ time: Date.now() / 1000, states: [] }),
        );
      if (pathname === '/api/military')
        return Promise.resolve(Response.json({ now: Date.now(), ac: [] }));
      // One mapped station next to the Contacts subject, with a footprint.
      if (pathname === '/api/military-installations') {
        window.qaInstallationReads = (window.qaInstallationReads ?? 0) + 1;
        const ring = [
          [43.665, -79.345],
          [43.665, -79.315],
          [43.68, -79.315],
          [43.68, -79.345],
          [43.665, -79.345],
        ];
        return Promise.resolve(
          Response.json({
            status: 'ok',
            elements: [
              {
                type: 'way',
                id: 424242,
                tags: { military: 'naval_base', name: 'QA Harbour Station' },
                center: { lat: 43.6725, lon: -79.33 },
                geometry: ring.map(([lat, lon]) => ({ lat, lon })),
              },
            ],
          }),
        );
      }
      return fetch(input, options);
    };
    window.qaSelected = [];
    for (const type of ['gev:entity-selected', 'gev:entity-selection-cleared'])
      window.addEventListener(type, ({ detail }) =>
        window.qaSelected.push({
          type,
          id: detail?.id,
          layerId: detail?.layerId,
        }),
      );
  });
  await p.goto(base.href);
  await waitForEngine(p, 'navara');
  await p.evaluate(async () => {
    const { dataManager, styleManager } = window.__godsEyeView;

    await dataManager.setEnabled('ais-live-vessels', true, { origin: 'user' });
    window.qaBefore = [...dataManager.getEnabledLayerIds()].sort();
    const outcome = await styleManager.setContextMode('contacts');
    if (!outcome.ok) throw Error(JSON.stringify(outcome));
    window.qaContext = dataManager.layers.get('military-awareness').module;
    window.qaSites = dataManager.layers.get('military-installations').module;
    const vessels = dataManager.layers.get('ais-live-vessels').module;
    if (!vessels.selectById('123456789')) throw Error('Missing first vessel');
    if (!window.qaContext.navigateNext({ targetLayer: 'ais-live-vessels' }))
      throw Error('Cannot navigate to the second vessel');
  });
  const sample = () =>
    p.evaluate(() => {
      const { dataManager, styleManager, engine } = window.__godsEyeView;
      return {
        context:
          window.qaContext ===
          dataManager.layers.get('military-awareness').module,
        sites:
          window.qaSites ===
          dataManager.layers.get('military-installations').module,
        mode: styleManager.getContextModeState().mode,
        subject: window.qaContext.getContextSnapshot()?.subject?.id,
        history:
          window.qaContext._getAwarenessNavigationStateForTest().historyKeys,
        enabled: [...dataManager.getEnabledLayerIds()].sort(),
        ring:
          engine.kind === 'navara'
            ? engine.lines
                .list()
                .filter((line) => line.id === 'gev-awareness-rim').length
            : null,
      };
    });
  // The station zone: the fixture's installation is the one mapped site
  // within the Contacts radius of the subject, and the engine draws it where
  // a pointer can reach it (the engine's own picker returns it at an
  // uncovered canvas point at its marker or inside its footprint).
  const inside = [fromDegrees(-79.33, 43.6725)];
  for (let i = 1; i < 6; i++)
    for (let k = 1; k < 6; k++)
      inside.push(fromDegrees(-79.345 + 0.005 * k, 43.665 + 0.0025 * i));
  const zone = async () => {
    await p.waitForFunction(
      () =>
        !window.qaSites.getStats().loading &&
        window.qaSites
          .getAnalystRecords()
          .some((r) => r.name === 'QA Harbour Station'),
      { timeout: 30000 },
    );
    const drawn = await p
      .waitForFunction(
        (points) => {
          const { engine } = window.__godsEyeView;
          const canvas = engine.host.canvas;
          const box = canvas.getBoundingClientRect();
          for (const world of points) {
            const centre = engine.projector.worldToWindow(world, {});
            if (!centre) continue;
            for (const [dx, dy] of [
              [0, 0],
              [0, -8],
              [8, 0],
              [-8, 0],
              [0, 8],
            ]) {
              const at = { x: centre.x + dx, y: centre.y + dy };
              if (
                !canvas.contains(
                  document.elementFromPoint(box.left + at.x, box.top + at.y),
                )
              )
                continue;
              const id = engine.picker.pick(at)?.id;
              if (String(id?.id ?? id) === 'osm:way:424242')
                return [Math.round(at.x), Math.round(at.y)];
            }
          }
          return false;
        },
        { timeout: 20000 },
        inside,
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    return p.evaluate(
      (drawn) => ({
        drawn,
        records: window.qaSites.getAnalystRecords().map((r) => r.name),
        coverage: window.qaSites.getStats().coverage,
        count: window.qaSites.getStats().count,
        reads: window.qaInstallationReads,
        subject: window.qaContext.getContextSnapshot()?.subject?.id,
      }),
      drawn,
    );
  };
  const checkZone = async () => {
    const station = await zone();
    await strict.check(
      p,
      'military-installations',
      'the station zone holds the fixture station, drawn and pickable',
      station.count === 1 &&
        station.records.length === 1 &&
        station.records[0] === 'QA Harbour Station' &&
        station.coverage?.kind === 'subject' &&
        Array.isArray(station.drawn),
      station,
    );
    return station;
  };
  const firstZone = await checkZone();
  const baseline = await sample();
  console.log('baseline', JSON.stringify(baseline));
  assert.equal(baseline.mode, 'flights');
  assert.equal(baseline.subject, '223456789');
  assert.ok(baseline.history.includes('ais-live-vessels:123456789'));
  assert.ok(baseline.ring >= 1);
  await strict.passed(
    p,
    'military-awareness',
    'Contacts subject, navigation history and awareness rim',
    baseline,
  );
  for (const kind of ['cesium', 'navara']) {
    await strict.switchTo(p, kind);
    const current = await sample();
    console.log('handoff', kind, JSON.stringify(current));
    assert.deepEqual(current, {
      ...baseline,
      ring: kind === 'navara' ? baseline.ring : null,
    });
    await strict.passed(
      p,
      'military-awareness',
      'same awareness model, Contacts mode, subject, history and enabled layers',
    );
    await strict.passed(
      p,
      'military-installations',
      'same installations model and enabled through the switch',
    );
    const station = await checkZone();
    await strict.check(
      p,
      'military-installations',
      'the switch reads no installation snapshot',
      station.reads === firstZone.reads,
      { before: firstZone.reads, after: station.reads },
    );
  }
  await checkZone();
  const restored = await p.evaluate(async () => {
    const { dataManager, styleManager } = window.__godsEyeView;
    const result = await styleManager.setContextMode('off');
    return (
      result.ok &&
      JSON.stringify([...dataManager.getEnabledLayerIds()].sort()) ===
        JSON.stringify(window.qaBefore)
    );
  });
  assert.ok(
    restored,
    'Restore layers enabled by the user before entering Contacts',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS Contacts history, dependency ownership and exit restore across both globes',
  );
});
