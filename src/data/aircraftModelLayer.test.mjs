import test from 'node:test';
import assert from 'node:assert/strict';
import { createAircraftModels, paceSpanMs } from './aircraftModelLayer.js';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import { bindRenderer } from '../render/rendererOf.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import * as flightsPolicy from '../layers/flights/policy.js';

// The flights layer's own model policy: its radii, ceiling and caps.
const POLICY = {
  ...flightsPolicy,
  MODEL_MAX: 40,
  MODEL_HEADING_OFFSET_DEG: 0,
};

/** The eye's height (m): 1 km above the contacts. */
const EYE_M = 11_000;

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
 * write. The eye sits at `eyeM`, by default 1 km above them (`EYE_M`).
 */
function fleetFixture(positions, { eyeM = EYE_M } = {}) {
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
  const eye = fromDegrees(-97.71, 30.21, eyeM);
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
        height: eyeM,
      }),
    },
  });
  const shown = new Map([...positions.keys()].map((id) => [id, true]));
  let alphaOf = 1;
  let focusOf = 1;
  const unseenIds = new Set();
  const icons = {
    show: true,
    setId: 'flights-icons:1',
    ids: () => [...positions.keys()],
    has: (id) => positions.has(id),
    position: (id) => positions.get(id),
    course: () => 90,
    alpha: () => alphaOf,
    focus: () => focusOf,
    setShown: (id, value) => shown.set(id, value),
    unseen: (id) => unseenIds.has(id),
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
  let iconRecedeSyncs = 0;
  const replanViews = [];
  const parts = {
    icons: {
      _displayMs: () => now,
      _syncImageSwitch() {},
      _replanExpired(_t, view) {
        replanViews.push(view);
      },
      _focusIcons() {},
      _occluder: () => null,
      _aboveHorizon: () => true,
      _syncRecede() {
        iconRecedeSyncs += 1;
      },
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
    /** How often the icons were told to recede by the tuning as it is now. */
    iconRecedeSyncs: () => iconRecedeSyncs,
    /** The camera each fleet tick re-planned the icons with. */
    replanViews,
    eye,
    /** Mark a contact as not there yet at the time drawn, or there again. */
    setUnseen(id, value) {
      if (value) unseenIds.add(id);
      else unseenIds.delete(id);
    },
    /** The icons' alpha and focus the fleet models take. */
    look(alpha, focus) {
      alphaOf = alpha;
      focusOf = focus;
    },
    /** One fleet tick, past the tick interval. */
    tick() {
      now += 1000;
      models._fleetTick();
    },
  };
}

// About 0.5 km apart, within 2 km of the eye.
const near = (k) => fromDegrees(-97.71 + k * 0.005, 30.21, 10_000);
/** A contact at the eye's height, `m` metres north of it. */
const north = (m) => fromDegrees(-97.71, 30.21 + m / 110_850, EYE_M);
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

test('fleet model alpha is worked out once a fleet tick from the camera then, as base × max(floor, focus × haze); the IR boost draws full strength', async () => {
  const {
    aircraftTreatmentAlpha,
    setAircraftRecessionParams,
    resetAircraftRecessionParams,
  } = await import('./aircraftRecession.js');
  const position = near(1);
  const f = fleetFixture(new Map([['a1', position]]));
  assert.equal(f.fleet().spec.recede ?? null, null, 'the set does not recede');
  const eye = fromDegrees(-97.71, 30.21, EYE_M);
  const expected = (focusFactor) =>
    aircraftTreatmentAlpha({
      baseAlpha: 0.8,
      focusFactor,
      cameraDistanceM: Math.hypot(
        eye.x - position.x,
        eye.y - position.y,
        eye.z - position.z,
      ),
      cameraHeightM: EYE_M,
    });
  try {
    // Recede from the eye on, so the haze is not 1 here.
    setAircraftRecessionParams({ startLimbRatio: 0, alphaFloor: 0.05 });
    f.look(0.8, 0.5);
    f.tick();
    f.draw.ready(f.fleetId, 'a1');
    f.tick();
    const item = f.fleet().items.get('a1');
    assert.equal(item.tint[3], expected(0.5), 'the tint carries it all');
    assert.equal(item.focus ?? 1, 1, 'with no focus for the set to compose');
    // A frame inside the fleet interval writes nothing, whatever changed.
    f.look(0.8, 0.25);
    f.models._fleetTick();
    assert.equal(f.fleet().items.get('a1').tint[3], item.tint[3]);
    f.tick();
    assert.equal(
      f.fleet().items.get('a1').tint[3],
      expected(0.25),
      'the next tick takes it',
    );
  } finally {
    resetAircraftRecessionParams();
  }
  f.state._irBoost = true;
  f.models._reloadModelsForIrBoost();
  f.tick();
  assert.equal(f.fleet().items.get('a1').tint[3], 1, 'boosted: full strength');
});

test('a tuning change reaches the icons on the next frame, icons shown or not', async () => {
  const f = fleetFixture(new Map([['a1', near(1)]]));
  f.state._icons.show = false;
  const before = f.iconRecedeSyncs();
  f.models._fleetTick();
  assert.ok(f.iconRecedeSyncs() > before, 'the icons are told');
});

test('a contact not there yet at the time drawn has its fleet model hidden, as one beyond the horizon', () => {
  const f = fleetFixture(new Map([['a1', near(1)]]));
  f.tick();
  f.draw.ready(f.fleetId, 'a1');
  f.tick();
  assert.equal(f.fleet().items.get('a1').show, true, 'drawn while there');
  f.setUnseen('a1', true);
  f.tick();
  assert.equal(f.fleet().items.get('a1').show, false, 'hidden while unseen');
  f.setUnseen('a1', false);
  f.tick();
  f.tick();
  assert.equal(f.fleet().items.get('a1').show, true, 'drawn again');
});

test('aircraft draw as models only within 3 km of the camera, in either mode', () => {
  for (const mode of ['proximity', 'all']) {
    const positions = new Map([
      ['inside', north(2_900)],
      ['outside', north(3_100)],
    ]);
    const f = fleetFixture(positions);
    f.state._models3dMode = mode;
    f.tick();
    for (const id of positions.keys())
      if (f.fleet().items.has(id)) f.draw.ready(f.fleetId, id);
    f.tick();
    assert.equal(f.shown.get('inside'), false, `${mode}: a model at 2.9 km`);
    assert.equal(f.fleet().items.get('inside').show, true);
    assert.equal(f.shown.get('outside'), true, `${mode}: an icon at 3.1 km`);
    assert.equal(f.fleet().items.has('outside'), false);
  }
});

test('a model is kept out to about 3.6 km, then its icon takes over', () => {
  const positions = new Map([['a1', north(2_000)]]);
  const f = fleetFixture(positions);
  f.tick();
  f.draw.ready(f.fleetId, 'a1');
  f.tick();
  assert.equal(f.shown.get('a1'), false, 'a model at 2 km');
  positions.set('a1', north(3_500));
  f.tick();
  assert.equal(f.shown.get('a1'), false, 'kept at 3.5 km');
  assert.equal(f.fleet().items.get('a1').show, true);
  positions.set('a1', north(3_700));
  f.tick();
  assert.equal(f.shown.get('a1'), true, 'released at 3.7 km');
  assert.equal(f.fleet().items.has('a1'), false);
  positions.set('a1', north(3_300));
  f.tick();
  assert.equal(
    f.fleet().items.has('a1'),
    false,
    'not taken again until it is back within 3 km',
  );
});

test('a camera high above the ground still models an aircraft within 3 km of it', () => {
  // A plane at 30 km with the camera 2 km above it: the altitude ceiling
  // sits above every contact's height plus the keep radius.
  const plane = fromDegrees(-97.71, 30.21, 30_000);
  const f = fleetFixture(new Map([['high', plane]]), { eyeM: 32_000 });
  f.tick();
  f.draw.ready(f.fleetId, 'high');
  f.tick();
  assert.equal(f.shown.get('high'), false, 'its model draws it');
  assert.equal(
    POLICY.MODEL_ALT_CEIL_M,
    POLICY.MODEL_HIGHEST_CONTACT_M + POLICY.MODEL_KEEP_M,
  );
});

test('models are drawn at their true size, with no minimum pixel size', () => {
  const f = fleetFixture(new Map([['a1', near(1)]]));
  f.tick();
  assert.equal(f.fleet().items.get('a1').minPixelSize ?? 0, 0);
});

test('the selected contact keeps a loaded, hidden fleet model that takes it back on deselect', () => {
  const positions = new Map([['a1', near(1)]]);
  const f = fleetFixture(positions);
  // Selected while an icon: the fleet pass admits its model all the same.
  f.state._trackedIcao = 'a1';
  f.shown.set('a1', false); // selecting it hides its icon
  f.tick();
  assert.ok(f.fleet().items.has('a1'), 'admitted and loading while selected');
  f.draw.ready(f.fleetId, 'a1');
  positions.set('a1', near(2));
  f.tick();
  const item = f.fleet().items.get('a1');
  assert.equal(item.show, false, 'never drawn while selected');
  assert.deepEqual(
    item.pos,
    { x: near(2).x, y: near(2).y, z: near(2).z },
    'placed where its icon is',
  );
  assert.equal(f.shown.get('a1'), false, 'the icon stays hidden');

  // Deselected: its model draws it in the same frame, its icon never shows.
  f.state._trackedIcao = null;
  f.models._handBackDeselected('a1');
  assert.equal(f.fleet().items.get('a1').show, true);
  assert.equal(f.shown.get('a1'), false);
});

test('the fleet tick re-plans the icons with the camera: its eye, and what it sees', () => {
  const f = fleetFixture(new Map([['a1', far(1)]]));
  f.tick();
  const [view] = f.replanViews;
  assert.equal(view.eye, f.eye);
  // The camera looks along -z: ahead of the eye is in view, behind it not.
  const ahead = { x: f.eye.x, y: f.eye.y, z: f.eye.z - 10_000 };
  const behind = { x: f.eye.x, y: f.eye.y, z: f.eye.z + 10_000 };
  assert.equal(view.inView(ahead), true);
  assert.equal(view.inView(behind), false);
});

test("an icon's speed is read over what is left of its drawn path", () => {
  assert.equal(paceSpanMs(1_000, null), 1_000);
  assert.equal(paceSpanMs(1_000, Infinity), 1_000);
  assert.equal(paceSpanMs(1_000, 5_000), 1_000);
  assert.equal(paceSpanMs(1_000, 1_050), 50);
  assert.equal(paceSpanMs(1_000, 1_010), 0);
  assert.equal(paceSpanMs(1_000, 900), 0);
});
