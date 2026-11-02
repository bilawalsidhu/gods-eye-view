import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import * as selection from '../../data/selectionDispatcher.js';
import * as picking from '../../data/pickRegistry.js';
import { createVesselLayer } from './index.js';
import { createVesselsCesiumRenderer } from './render/cesium.js';
import { missingVesselRendererMembers } from './render/contract.js';
import { allVesselChevronIcons, vesselChevronIcon } from './icons.js';
import {
  VESSEL_TYPE_CSS_COLORS,
  vesselTypeCss,
} from '../../data/vesselLabels.js';

const noop = () => {};

/** A renderer of plain records over the engine: what the logic asks for. */
function recordingRenderer(engine) {
  const sprites = new Set();
  const followListeners = new Set();
  let following = false;
  let attached = false;
  return {
    sprites,
    raiseFollow(active) {
      following = active;
      for (const listener of followListeners) listener();
    },
    renderer: {
      kind: 'plain',
      engine,
      view: {
        camera: {
          positionWC: { x: 0, y: 0, z: 20_000_000 },
          positionCartographic: { latitude: 0, longitude: 0, height: 1e7 },
          rightWC: { x: 1, y: 0, z: 0 },
          upWC: { x: 0, y: 1, z: 0 },
          heading: 0,
          pitch: 0,
          roll: 0,
        },
        scene: { canvas: { clientWidth: 0, clientHeight: 0 } },
        horizon: () => ({ isPointVisible: () => true }),
        worldToWindow: () => undefined,
        canvasSize: () => ({ width: 1280, height: 800 }),
        requestRender: noop,
        on: () => noop,
      },
      fleet: {
        collection: null,
        attached: () => attached,
        attach() {
          attached = true;
        },
        setVisible: noop,
        add(spec) {
          const sprite = { ...spec };
          sprites.add(sprite);
          return sprite;
        },
        remove: (sprite) => sprites.delete(sprite),
        detach() {
          attached = false;
        },
      },
      pickedRecord: (picked) =>
        picked?.id && typeof picked.id === 'object' ? picked.id : null,
      follow: {
        onChanged(listener) {
          followListeners.add(listener);
          return () => followListeners.delete(listener);
        },
        active: () => following,
      },
      trails: { create: () => null },
      destroy: noop,
    },
  };
}

function services(renderer) {
  return {
    context: {
      clearSelectedEntityContextForLayer: noop,
      registerEntityContext: () => null,
      selectEntityContext: noop,
    },
    trails: { createTrail: null },
    labels: {},
    picking,
    overlay: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
      hitTestWorldOverlay: () => null,
    },
    geoid: { ensureGeoidReady: () => new Promise(noop), geoidHeight: () => 0 },
    sprites: {
      registerSpriteCollection: noop,
      restoreSpriteOrder: noop,
      restoreSpriteOrderOnEnable: noop,
    },
    focus: {
      focusNowMs: (now) => now,
      getFocusTarget: () => null,
      focusPassIsNeeded: () => false,
      forgetSpriteFocus: noop,
    },
    worldFocus: { requestWorldFocus: noop },
    render: {
      holdContinuousRender: noop,
      releaseContinuousRender: noop,
      governorRequestRender: noop,
    },
    selection,
    renderer: { create: () => renderer },
  };
}

const row = (mmsi, latitude, longitude) => ({
  id: mmsi,
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

test('the vessels Cesium renderer has every member of the contract', () => {
  const renderer = createVesselsCesiumRenderer(null, {
    viewer: { scene: {}, camera: {} },
  });
  assert.deepEqual(missingVesselRendererMembers(renderer), []);
  assert.equal(renderer.kind, 'cesium');
  // The record a pick is of: Cesium's billboard id is the record.
  const record = { mmsi: '111' };
  assert.equal(renderer.pickedRecord({ id: record }), record);
  assert.equal(renderer.pickedRecord({ primitive: { id: record } }), record);
  assert.equal(renderer.pickedRecord({ id: 'ae01ce' }), null);
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

test('vessels on the Navara renderer: one always-on-top chevron bank, MMSI picks, the trail on engine.lines', async () => {
  const { createVesselsNavaraRenderer, vesselAtlasLayout } =
    await import('./render/navara.js');
  const engine = createFakeEngine();
  const layout = vesselAtlasLayout();
  const renderer = createVesselsNavaraRenderer(engine, {
    drawAtlas: async () => ({ canvas: { kind: 'atlas' }, cells: layout.cells }),
  });
  assert.deepEqual(missingVesselRendererMembers(renderer), []);
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

test('a vessel bank commits rows arriving after its empty visibility commit and after growth', async () => {
  const { createMoverBank } = await import('../aircraft/render/navara.js');
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
