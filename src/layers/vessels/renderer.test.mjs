import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createVesselLayer } from './index.js';
import { recordingRenderer, services } from './testFixtures.mjs';
import { createVesselsDisplay, vesselAtlasLayout } from './render/display.js';
import { allVesselChevronIcons, vesselChevronIcon } from './icons.js';
import {
  VESSEL_TYPE_CSS_COLORS,
  vesselTypeCss,
} from '../../data/vesselLabels.js';

const noop = () => {};

const row = (mmsi, latitude, longitude) => ({
  id: mmsi,
  mmsi,
  reference: mmsi,
  latitude,
  longitude,
  name: `SHIP ${mmsi}`,
  type: 'Cargo',
  observedAtMs: 500,
  speedMps: 2,
  headingDeg: 90,
  courseDeg: 90,
});

test('the chevron artwork: one icon per type colour plus the selected one', () => {
  const icons = allVesselChevronIcons();
  assert.equal(icons.length, VESSEL_TYPE_CSS_COLORS.length + 1);
  assert.equal(new Set(icons).size, icons.length);
  assert.ok(icons.includes(vesselChevronIcon(vesselTypeCss('Tanker'), false)));
  assert.ok(icons.includes(vesselChevronIcon('#ffffff', true)));
});

test('vessel logic draws and selects through a plain renderer on an engine, with no Cesium', async () => {
  const engine = createFakeEngine();
  const recording = recordingRenderer(engine);
  const layer = createVesselLayer({
    source: {
      label: 'Fixture vessels',
      getSnapshot: async () => ({
        records: [row('111', 40.6, -73.9), row('222', 40.7, -74.0)],
        source: 'Fixture vessels',
        complete: true,
        stale: false,
        freshness: 'current',
        observedAtMs: 500,
        transportStatus: 'live',
        rawRowCount: 2,
      }),
    },
    services: services(recording.renderer),
  });
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: () => null,
  });
  try {
    layer.init(null, { engine });
    await layer.enable(null, { engine });
    assert.equal(recording.sprites.size, 2);
    const sprite = [...recording.sprites].find((s) => s.id.mmsi === '111');
    assert.equal(sprite.scale, 0.6);
    assert.equal(sprite.rotation, 0);
    assert.equal(
      sprite.image,
      vesselChevronIcon(vesselTypeCss('Cargo'), false),
    );

    // A click on its sprite selects it (the engine's dispatcher, own rule).
    engine.fake.script('pick', () => ({ id: sprite.id }));
    engine.fake.input('click', { position: { x: 10, y: 10 } });
    assert.equal(layer.getSelectedInfo()?.mmsi, '111');
    assert.equal(sprite.scale, 0.6 * 1.2);
    assert.equal(sprite.image, vesselChevronIcon('#ffffff', true));

    layer.setCockpitSubject('111');
    assert.equal(sprite.show, false, 'the bridge hides its own vessel');
    assert.equal(layer.getCockpitSubject()?.mmsi, '111');
    engine.fake.script('pick', () => undefined);
    engine.fake.input('click', { position: { x: 500, y: 10 } });
    assert.equal(layer.getSelectedInfo()?.mmsi, '111');
    engine.fake.script('pick', () => ({ id: sprite.id }));
    layer.setCockpitSubject(null);
    assert.equal(sprite.show, true, 'leaving the bridge restores the vessel');

    // Another layer takes the camera: the selection goes.
    recording.raiseFollow(true);
    assert.equal(layer.getSelectedInfo(), null);
    recording.raiseFollow(false);

    // Select again, then a click on empty map releases it.
    engine.fake.input('click', { position: { x: 10, y: 10 } });
    assert.equal(layer.getSelectedInfo()?.mmsi, '111');
    engine.fake.script('pick', () => undefined);
    engine.fake.input('click', { position: { x: 500, y: 10 } });
    assert.equal(layer.getSelectedInfo(), null);

    layer.disable(null, { engine });
    layer.destroy(null, { engine });
    assert.equal(recording.renderer.fleet.attached(), false);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('vessels on the display: one always-on-top chevron bank, source-id picks, the trail on engine.lines', async () => {
  const engine = createFakeEngine();
  const layout = vesselAtlasLayout();
  const renderer = createVesselsDisplay(engine, {
    drawAtlas: async () => ({ canvas: { kind: 'atlas' }, cells: layout.cells }),
  });
  const layer = createVesselLayer({
    source: {
      label: 'Fixture vessels',
      getSnapshot: async () => ({
        records: [row('111', 40.6, -73.9), row('222', 40.7, -74.0)],
        source: 'Fixture vessels',
        complete: true,
        stale: false,
        freshness: 'current',
        observedAtMs: 500,
        transportStatus: 'live',
        rawRowCount: 2,
      }),
      getTrack: async () => ({
        records: [{ latitude: 40.5, longitude: -73.8 }],
      }),
    },
    services: {
      ...services(renderer),
      geoid: {
        ensureGeoidReady: () => new Promise(noop),
        geoidHeight: () => 0,
      },
    },
  });
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: () => null,
  });
  try {
    layer.init(null, { engine });
    await layer.enable(null, { engine });
    await renderer.whenReady();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sets = engine.movers.list();
    assert.equal(sets.length, 1);
    assert.equal(sets[0].count, 2);
    const set = engine.fake.moverSet(sets[0].id);
    assert.equal(set.options.depthTest, 'always');
    assert.equal(set.options.sprite.sizePx, 32);
    assert.deepEqual([...set.store.pickIds.slice(0, 2)].sort(), ['111', '222']);

    // A click on its pick (the MMSI) selects it: the white chevron ×1.2.
    engine.fake.script('pick', () => ({ id: '111', owner: sets[0].id }));
    engine.fake.input('click', { position: { x: 10, y: 10 } });
    assert.equal(layer.getSelectedInfo()?.mmsi, '111');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const index = [...set.store.pickIds].indexOf('111');
    assert.ok(Math.abs(set.store.scales[index] - 0.72) < 1e-6);
    // The trail: an engine line (the backfill fix + the live position).
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(engine.fake.line('gev-trail:ais-live-vessels-1'));

    // Another layer follows something: the vessel selection goes.
    const handle = engine.camera.follow({
      position: () => engine.camera.pose().position,
      viewFrom: { x: 0, y: -100, z: 100 },
    });
    assert.equal(layer.getSelectedInfo(), null);
    handle.stop();

    layer.disable(null, { engine });
    layer.destroy(null, { engine });
    assert.equal(engine.movers.list().length, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('a pending AIS poll and selected trail survive replacement of the planet', async (t) => {
  const engines = [createFakeEngine(), createFakeEngine()];
  const recorders = engines.map(recordingRenderer);
  const output = recorders.map(() => []);
  for (const [i, { renderer }] of recorders.entries())
    renderer.trails.create = () => ({
      setPositions: (positions) => output[i].push(positions.slice()),
      clear: noop,
      destroy: noop,
    });
  const injected = services(recorders[0].renderer);
  const restored = [];
  injected.sprites.restoreSpriteOrderOnEnable = (id) => restored.push(id);
  injected.renderer.create = ({ engine }) =>
    recorders[engines.indexOf(engine)].renderer;
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: () => null,
  });
  t.after(() => {
    globalThis.document = previousDocument;
  });
  let polls = 0,
    histories = 0,
    deliver;
  const snapshot = (records) => ({
    records,
    source: 'AIS fixture',
    complete: true,
    transportStatus: 'live',
    rawRowCount: records.length,
    observedAtMs: 500,
    freshness: 'current',
  });
  const layer = createVesselLayer({
    services: injected,
    source: {
      getSnapshot: () =>
        ++polls === 1
          ? snapshot([row('111', 40.6, -73.9)])
          : new Promise((resolve) => {
              deliver = resolve;
            }),
      getTrack: async () => {
        histories++;
        return { records: [{ latitude: 40.59, longitude: -73.92 }] };
      },
    },
  });
  t.after(() => layer.destroy());
  layer.init(null, { engine: engines[0] });
  await layer.enable();
  const record = [...recorders[0].sprites][0].id;
  layer.selectById('111');
  const session = layer.testing._getVesselFeedStateForTest().sessionId;
  const pending = layer.update();
  layer.detachRenderer();
  assert.equal(recorders[0].sprites.size, 0);
  deliver(snapshot([row('111', 40.61, -73.91), row('222', 40.62, -73.92)]));
  await pending;
  assert.equal(layer.getSelectedInfo()?.mmsi, '111');
  assert.ok(layer.findByQuery('222').position);
  assert.equal(layer.testing._getVesselStateForTest().trailPositionCount, 3);
  layer.attachRenderer({ engine: engines[1] });
  assert.equal(recorders[1].sprites.size, 2);
  const selected = [...recorders[1].sprites].find(({ id }) => id === record);
  assert.equal(selected.image, vesselChevronIcon('#ffffff', true));
  assert.equal(selected.scale, 0.72);
  assert.equal(output[1].at(-1).length, 3);
  assert.equal(layer.testing._getVesselFeedStateForTest().sessionId, session);
  assert.equal(polls, 2);
  assert.equal(histories, 1);
  assert.deepEqual(restored, ['ais', 'ais']);
});

test('a vessel bank commits rows arriving after its empty visibility commit and after growth', async () => {
  const { createMoverBank } = await import('../shared/render/moverBank.js');
  let commits = 0;
  let pending = null;
  const bank = createMoverBank(
    {
      movers: {
        createSet: () => ({
          set() {},
          setCount() {},
          destroy() {},
          commit() {
            commits++;
          },
        }),
      },
    },
    {
      options: (capacity) => ({ capacity }),
      write() {},
      onCommit: (next) => {
        pending = next;
      },
    },
  );
  const flush = () => {
    const next = pending;
    pending = null;
    next?.commit();
  };
  bank.setVisible(true);
  flush();
  bank.add({});
  assert.equal(pending, bank, 'first rows schedule their GPU upload');
  flush();
  assert.equal(commits, 1);
  for (let i = 1; i < 1024; i++) bank.add({});
  flush();
  bank.add({});
  assert.equal(pending, bank, 'capacity growth schedules its GPU upload');
  flush();
  assert.equal(commits, 3);
  bank.destroy();
});
