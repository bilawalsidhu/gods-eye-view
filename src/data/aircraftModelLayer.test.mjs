import test from 'node:test';
import assert from 'node:assert/strict';
import { createAircraftModels } from './aircraftModelLayer.js';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import { bindRenderer } from '../render/rendererOf.js';
import { fromDegrees } from '../geo/ellipsoid.js';

const POLICY = {
  MODEL_ALT_CEIL_M: 800_000,
  MODEL_MAX: 40,
  MODEL_MAX_ALL: 350,
  COCKPIT_MODEL_MAX: 60,
  MODEL_PROX_ADD_M: 150_000,
  MODEL_PROX_KEEP_M: 185_000,
  MODEL_ALL_ADD_M: 400_000,
  MODEL_ALL_KEEP_M: 450_000,
  MODEL_MIN_PX: 24,
  TRACKED_MODEL_MIN_PX: 48,
  TRACKED_MODEL_MAX_PX: 600,
  MODEL_HEADING_OFFSET_DEG: 0,
  FLEET_DR_INTERVAL_MS: 80,
  TRACKED_MODEL_MAX_LOAD_FAILS: 3,
  TRACKED_MODEL_RETRY_BACKOFF_MS: 1500,
};

const SPEC = {
  url: 'plane.glb',
  scale: 1,
  bellyM: 3,
  nativeRadiusM: 20,
  blendAmount: 0.9,
};

/**
 * A fleet of airborne contacts at `positions` (icao → ECEF), drawn by a
 * models layer over a fake draw port whose fleet set can be told to fail a
 * write. The eye sits above them at 30 km.
 */
function fleetFixture(positions) {
  const base = fakeDrawPort();
  const removes = [];
  let failNextUpsert = false;
  const draw = {
    ...base,
    models(spec) {
      const set = base.models(spec);
      return {
        ...set,
        get show() {
          return set.show;
        },
        set show(value) {
          set.show = value;
        },
        id: set.id,
        upsert(items) {
          if (failNextUpsert && spec.id.includes('-models:')) {
            failNextUpsert = false;
            throw new Error('simulated write failure');
          }
          return set.upsert(items);
        },
        remove(ids) {
          removes.push([...ids]);
          return set.remove(ids);
        },
      };
    },
  };
  const eye = fromDegrees(-97.71, 30.21, 30_000);
  const viewer = {};
  bindRenderer(viewer, {
    draw,
    camera: {
      pose: () => ({
        position: eye,
        direction: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
        right: { x: 1, y: 0, z: 0 },
        fovy: Math.PI / 3,
        aspectRatio: 1,
        height: 30_000,
      }),
    },
  });
  const shown = new Map([...positions.keys()].map((id) => [id, true]));
  const icons = {
    show: true,
    setId: 'flights-icons:1',
    ids: () => [...positions.keys()],
    has: (id) => positions.has(id),
    position: (id) => positions.get(id),
    course: () => 90,
    alpha: () => 1,
    focus: () => 1,
    setShown: (id, value) => shown.set(id, value),
    flush() {},
  };
  const state = {
    _viewer: viewer,
    _icons: icons,
    _models: new Map(),
    _modelSets: null,
    _trackedIcao: null,
    _trackedModel: null,
    _models3dEnabled: true,
    _models3dMode: 'proximity',
    _cockpitContactMode: false,
    _irBoost: false,
    _lastFleetTickMs: 0,
    _lastModelCapWarnMs: 0,
    records: {
      data: new Map(
        [...positions.keys()].map((id) => [id, { klass: 'airliner' }]),
      ),
    },
  };
  let now = 1_000_000;
  const parts = {
    icons: {
      _displayMs: () => now,
      _syncImageSwitch() {},
      _replanExpired() {},
      _focusIcons() {},
      _occluder: () => null,
      _aboveHorizon: () => true,
    },
    motion: { _displayTimeAt: () => null },
    tracking: {
      _refreshCockpitNearContacts() {},
      _trackedModelRegimeActive: () => false,
    },
  };
  const models = createAircraftModels({
    state,
    services: {
      aircraftPresentation: { isTr3b: () => false },
      camera: { trackedModelScaleForPixelCap: ({ baseScale }) => baseScale },
      focus: { focusNowMs: () => now, getFocusTarget: () => null },
    },
    parts,
    resolveAsset: (url) => url,
    logLabel: 'Test',
    setPrefix: 'flights',
    policy: POLICY,
    modelSpec: () => SPEC,
    modelColor: () => ({ red: 1, green: 1, blue: 1, alpha: 1 }),
  });
  models._createModelSets(viewer);
  const fleetId = models._modelSetIds()[0];
  return {
    models,
    state,
    draw: base,
    fleet: () => base.set(fleetId),
    fleetId,
    removes,
    shown,
    failNextUpsert: () => (failNextUpsert = true),
    /** One fleet tick, past the tick interval. */
    tick() {
      now += 1000;
      models._fleetTick();
    },
  };
}

const near = (k) => fromDegrees(-97.71 + k * 0.01, 30.21, 10_000);
const far = (k) => fromDegrees(-90 + k * 0.01, 30.21, 10_000);

test('the fleet tick hands contacts to ready models and back without a gap', () => {
  const positions = new Map([
    ['a1', near(1)],
    ['a2', near(2)],
  ]);
  const f = fleetFixture(positions);
  f.tick();
  assert.deepEqual([...f.fleet().items.keys()].sort(), ['a1', 'a2']);
  assert.equal(
    f.shown.get('a1'),
    true,
    'icons carry contacts until models load',
  );
  f.draw.ready(f.fleetId, 'a1');
  f.tick();
  assert.equal(f.shown.get('a1'), false, 'a ready, placed model takes over');
  assert.equal(f.fleet().items.get('a1').show, true);
  assert.equal(
    f.shown.get('a2'),
    true,
    'a model still loading leaves its icon',
  );
});

test('contacts leaving the model band are released in one write', () => {
  const positions = new Map([
    ['a1', near(1)],
    ['a2', near(2)],
    ['a3', near(3)],
  ]);
  const f = fleetFixture(positions);
  f.tick();
  for (const id of ['a1', 'a2', 'a3']) f.draw.ready(f.fleetId, id);
  f.tick();
  positions.set('a2', far(2));
  positions.set('a3', far(3));
  f.removes.length = 0;
  f.tick();
  assert.deepEqual(
    f.removes,
    [['a2', 'a3']],
    'one remove for every evicted model',
  );
  assert.deepEqual([...f.fleet().items.keys()], ['a1']);
  assert.equal(
    f.shown.get('a2'),
    true,
    'a released model hands back to its icon',
  );
  assert.equal(f.shown.get('a3'), true);
});

test('a failed fleet write leaves the icons in charge and is sent again', () => {
  const positions = new Map([['a1', near(1)]]);
  const f = fleetFixture(positions);
  f.tick();
  f.draw.ready(f.fleetId, 'a1');
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    f.failNextUpsert();
    f.tick();
  } finally {
    console.warn = realWarn;
  }
  assert.equal(f.shown.get('a1'), true, 'the contact keeps its icon');
  assert.equal(
    f.fleet().items.get('a1').show,
    false,
    'the set still has the hidden model',
  );
  assert.equal(f.models._modelOwnsVisual('a1'), false);
  f.tick();
  assert.equal(
    f.fleet().items.get('a1').show,
    true,
    'the next tick sends it again',
  );
  assert.equal(f.shown.get('a1'), false);
});

test('a fleet model whose load failed is loaded again after a wait, not before', () => {
  const positions = new Map([['a1', near(1)]]);
  const f = fleetFixture(positions);
  const realNow = Date.now;
  let clock = 50_000_000;
  Date.now = () => clock;
  try {
    f.tick();
    const writes = f.fleet().writes;
    clock += 60_000;
    f.tick();
    assert.equal(
      f.fleet().writes,
      writes,
      'a model still loading is not rewritten, however long it takes',
    );
    f.draw.loadFailed(f.fleetId, 'a1');
    f.removes.length = 0;
    clock += 4_999;
    f.tick();
    assert.deepEqual(f.removes, [], 'not before the wait');
    assert.equal(f.shown.get('a1'), true, 'the icon carries the contact');
    clock += 1;
    f.tick();
    assert.deepEqual(f.removes, [['a1']], 'removed once the wait is over');
    assert.ok(f.fleet().items.has('a1'), 'and added again in the same tick');
    assert.equal(f.state._models.get('a1').failedAt, 0);
    assert.equal(f.state._models.get('a1').ready, false, 'a fresh load');
    f.removes.length = 0;
    clock += 60_000;
    f.tick();
    assert.deepEqual(f.removes, [], 'tried again only after another failure');
    // A renderer's own retry that loads before the layer's: nothing is due.
    f.draw.loadFailed(f.fleetId, 'a1');
    f.draw.ready(f.fleetId, 'a1');
    clock += 60_000;
    f.tick();
    assert.deepEqual(f.removes, [], 'a model that loaded is not tried again');
    assert.equal(
      f.shown.get('a1'),
      false,
      'the model takes over once it loads',
    );
  } finally {
    Date.now = realNow;
  }
});
