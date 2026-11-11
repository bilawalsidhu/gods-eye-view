// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { claimPointer, releasePointer } from '../../../data/inputOwnership.js';
import { rgbaFromCss } from '../../shared/color.js';
import {
  BASE_CABLE_COLOR,
  BASE_LANDING_COLOR,
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
} from '../policy.js';
import { createCablesDisplay } from './display.js';

// GroundPolylinePrimitive checks its render state's line width against the
// context's limits, which a stub scene has none of.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;

function watch(engine) {
  const sets = new Map();
  const createSet = engine.ground.createSet.bind(engine.ground);
  engine.ground.createSet = (options) => {
    const set = createSet(options);
    const record = { options, pending: [], items: [], commits: 0 };
    const { replace, commit } = set;
    set.replace = (items) => {
      replace(items);
      record.pending = items;
    };
    set.commit = () => {
      commit();
      record.items = record.pending;
      record.commits++;
    };
    sets.set(options.id, record);
    return set;
  };
  const segments = new Map();
  const createSegments = engine.lines.createSegments.bind(engine.lines);
  engine.lines.createSegments = (options) => {
    const batch = createSegments(options);
    const { replace, commit, destroy } = batch;
    let pending = [];
    batch.replace = (items) => {
      replace(items);
      pending = items.map((item) => ({
        ...item,
        positions: item.positions.map((p) => geo.cartesian3.clone(p)),
      }));
    };
    batch.commit = () => {
      commit();
      const next = new Map();
      for (const item of pending) {
        const id = `${CABLE_OVERLAY_SOURCE_ID}-stem-${item.pickId}`;
        next.set(id, {
          ...item,
          owner: options.id,
          commits: (segments.get(id)?.commits ?? 0) + 1,
        });
      }
      segments.clear();
      for (const [id, item] of next) segments.set(id, item);
    };
    batch.destroy = () => {
      destroy();
      segments.clear();
    };
    return batch;
  };
  const flights = [];
  engine.camera.flyTo = (options) => flights.push(options);
  return {
    /** A live ground set: its options and last committed items. */
    groundSet(id) {
      const listed = engine.ground.list().find((entry) => entry.id === id);
      return listed ? sets.get(id) : undefined;
    },
    /** How often a line's positions were set. */
    positionsSet: (id) => segments.get(id)?.commits ?? 0,
    line: (id) => segments.get(id),
    flights,
    lineIds: () => [...segments.keys()],
    look(lon, lat, height) {
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(lon, lat, height),
      });
    },
  };
}

function fakeHarness() {
  const engine = createFakeEngine();
  const watched = watch(engine);
  return {
    name: 'the fake engine',
    engine,
    ...watched,
    preRender: () => engine.fake.emit('frames.preRender', 0),
    moveEnd: () => engine.fake.emit('camera.moveEnd'),
    /** A mover set's instance: shown, colour, size and pickId. */
    point(id, index) {
      const entry = engine.fake.moverSet(id);
      if (!entry || index >= entry.store.count) return undefined;
      const { store, options } = entry;
      return {
        shown: store.shows[index] === 1,
        color: [...store.colors.slice(index * 4, index * 4 + 4)],
        sizePx: options.point.sizePx,
        outlinePx: options.point.outlinePx,
        id: store.pickIds[index],
        position: {
          x: store.positions[index * 3],
          y: store.positions[index * 3 + 1],
          z: store.positions[index * 3 + 2],
        },
      };
    },
    click(target) {
      const picked =
        target?.ground !== undefined
          ? {
              id: watched.groundSet(target.ground).items[target.instance]
                .pickId,
              owner: target.ground,
              instance: target.instance,
            }
          : target?.mover !== undefined
            ? {
                id: engine.fake.moverSet(target.mover).store.pickIds[
                  target.instance
                ],
                owner: target.mover,
                instance: target.instance,
              }
            : target?.line !== undefined
              ? {
                  id: watched.line(target.line).pickId,
                  owner: watched.line(target.line).owner,
                }
              : target;
      engine.fake.script('pick', picked);
      engine.fake.input('click', { position: { x: 100, y: 100 } });
      engine.fake.unscript('pick');
    },
  };
}

const HARNESSES = [fakeHarness];

const PATHS = `${CABLE_OVERLAY_SOURCE_ID}-paths`;
const MARKERS = `${CABLE_OVERLAY_SOURCE_ID}-markers`;
const CABLE_TIPS = `${CABLE_OVERLAY_SOURCE_ID}-cable-tips`;
const LANDING_TIPS = `${CABLE_OVERLAY_SOURCE_ID}-landing-point-tips`;
const rgba = (css, alpha) => [...rgbaFromCss(css).rgba().slice(0, 3), alpha];
const near = (actual, expected, label) =>
  actual.forEach((value, index) =>
    assert.ok(
      Math.abs(value - expected[index]) < 1e-6,
      `${label}: ${actual} vs ${expected}`,
    ),
  );

const alpha = {
  type: 'Feature',
  properties: {
    id: 'alpha',
    name: 'Alpha cable',
    color: '#ff0000',
    coordinates: [-40, 35],
  },
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [-40, 35],
        [-39, 36],
      ],
      [
        [-38, 37],
        [-37, 38],
      ],
    ],
  },
};
// No colour of its own and no reference coordinates: the base colour and a
// reference averaged from its path.
const beta = {
  type: 'Feature',
  properties: { id: 'beta', name: 'Beta cable' },
  geometry: {
    type: 'LineString',
    coordinates: [
      [140, -35],
      [141, -34],
    ],
  },
};
const lisbon = {
  type: 'Feature',
  properties: { id: 'lisbon', name: 'Lisbon, Portugal', is_tbd: false },
  geometry: { type: 'Point', coordinates: [-9.1, 38.7] },
};
const dataset = (cables = [alpha, beta], landings = [lisbon]) => ({
  cables: { type: 'FeatureCollection', features: cables },
  landingPoints: { type: 'FeatureCollection', features: landings },
});

function stackTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
}

function fixture(t, makeHarness, options = {}) {
  const harness = makeHarness();
  const hostCalls = [];
  let clock = 0;
  const display = createCablesDisplay(harness.engine, {
    overlayHost: {
      setVisible: (...args) => hostCalls.push(['visible', ...args]),
      setEntries: (...args) => hostCalls.push(['entries', ...args]),
      clearSource: (...args) => hostCalls.push(['clear', ...args]),
    },
    sweepClock: () => clock,
    ...options,
  });
  t.after(() => {
    display.destroy();
    harness.engine.destroy();
  });
  return {
    ...harness,
    display,
    hostCalls,
    publishes: () => hostCalls.filter(([type]) => type === 'entries'),
    advance(ms) {
      clock += ms;
    },
  };
}

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`cable paths draw as one pixel corridor set in their colours, one item per path (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.display.show(dataset());
    const set = f.groundSet(PATHS);
    assert.equal(set.options.kind, 'corridor');
    assert.equal(set.options.pickable, true);
    assert.equal(set.options.drape, 'terrain', 'no photoreal tiles: terrain');
    assert.equal(set.items.length, 3, 'every path of a multipart cable');
    assert.deepEqual(
      set.items.map((item) => item.widthPx),
      [2.5, 2.5, 2.5],
    );
    near(set.items[0].color, rgba('#ff0000', 0.92), 'own colour at 0.92');
    near(set.items[1].color, rgba('#ff0000', 0.92), 'every segment');
    near(set.items[2].color, rgba(BASE_CABLE_COLOR, 0.92), 'base colour');
    assert.equal(set.items[0].pickId, set.items[1].pickId);
    assert.notEqual(set.items[0].pickId, set.items[2].pickId);
    assert.deepEqual(set.items[0].positions, alpha.geometry.coordinates[0]);
  });

  test(`the paths drape on the active map stack's surface and follow its changes (${name})`, (t) => {
    const target = stackTarget();
    const f = fixture(t, makeHarness, { mapStackEventTarget: target });
    f.display.show(dataset());
    const listener = target.listeners.get('gev:map-stack-changed');
    assert.equal(typeof listener, 'function');
    listener({ detail: { activeId: 'photoreal', status: 'ready' } });
    assert.equal(f.groundSet(PATHS).options.drape, 'tiles');
    assert.equal(f.groundSet(PATHS).items.length, 3, 'rebuilt whole');

    listener({ detail: { activeId: 'osm', status: 'ready' } });
    assert.equal(f.groundSet(PATHS).options.drape, 'terrain');
    listener({ detail: { activeId: 'some-future-stack' } });
    assert.equal(f.groundSet(PATHS).options.drape, 'both');
    assert.equal(
      f.engine.ground.list().length,
      1,
      'one set at a time: the old one goes',
    );
    f.display.hide();
    listener({ detail: { activeId: 'photoreal' } });
    assert.equal(f.display.drape(), 'tiles', 'kept for the next show');
    f.display.show(dataset());
    assert.equal(f.groundSet(PATHS).options.drape, 'tiles');
    f.display.destroy();
    assert.equal(
      target.listeners.has('gev:map-stack-changed'),
      false,
      'destroy detaches the stack listener',
    );
  });

  test(`landing points are small ground markers, horizon-culled on the sweep (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.display.show(dataset());
    const marker = f.point(MARKERS, 0);
    assert.equal(marker.sizePx, 4, "the 6 px GeoJSON pin's width");
    assert.equal(marker.outlinePx, 0);
    near(marker.color, rgba(BASE_LANDING_COLOR, 1), 'the marker colour');
    assert.equal(marker.shown, true);
    assert.equal(marker.id, `landing-point-reference-2-lisbon`);
    // The far side of the planet from Lisbon.
    f.look(170.9, -38.7, 4_500_000);
    f.preRender();
    assert.equal(f.point(MARKERS, 0).shown, false);
    f.look(-9.1, 38.7, 4_500_000);
    f.moveEnd();
    f.preRender();
    assert.equal(f.point(MARKERS, 0).shown, true);
  });

  test(`the sweep shows visible tips, publishes their labels once and stems the winners (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(-40, 35, 4_500_000);
    f.display.show(dataset());
    assert.equal(f.point(CABLE_TIPS, 0).shown, false, 'hidden until a sweep');
    f.preRender();
    const alphaTip = f.point(CABLE_TIPS, 0);
    assert.equal(alphaTip.shown, true);
    assert.equal(alphaTip.sizePx, 7);
    assert.equal(alphaTip.outlinePx, 1);
    near(alphaTip.color, rgba(BASE_CABLE_COLOR, 0.84), 'cable tip');
    assert.equal(alphaTip.id, 'cable-reference-0-alpha');
    assert.equal(f.point(CABLE_TIPS, 1).shown, false, 'beyond the horizon');
    const landingTip = f.point(LANDING_TIPS, 0);
    assert.equal(landingTip.sizePx, 8);
    near(landingTip.color, rgba(BASE_LANDING_COLOR, 0.94), 'landing tip');

    const tipHeight = geo.cartographic.fromCartesian(alphaTip.position).height;
    assert.ok(tipHeight >= 700 && tipHeight <= 85_000, `tip ${tipHeight} m`);

    const [publish] = f.publishes();
    assert.equal(f.publishes().length, 1);
    const [, sourceId, entries, options] = publish;
    assert.equal(sourceId, CABLE_OVERLAY_SOURCE_ID);
    assert.deepEqual(
      entries.map((entry) => entry.title),
      ['Alpha cable', 'Lisbon, Portugal'],
      'the visible references, nearest first',
    );
    assert.ok(
      geo.cartesian3.equalsEpsilon(
        entries[0].position,
        alphaTip.position,
        0,
        1e-3,
      ),
      'the label sits at the tip',
    );
    assert.deepEqual(options, {
      cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
      collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
    assert.equal(f.display.stats().referenceLabelCount, 2);

    const stems = f.lineIds();
    assert.deepEqual(stems, [
      `${CABLE_OVERLAY_SOURCE_ID}-stem-cable-reference-0-alpha`,
      `${CABLE_OVERLAY_SOURCE_ID}-stem-landing-point-reference-2-lisbon`,
    ]);
    assert.ok(
      stems.every((id) => f.line(id)),
      'each stem is drawn',
    );
    assert.equal(
      f.engine.lines.list().length,
      1,
      'one batch draws both styles',
    );
    const cableStem = f.line(stems[0]);
    assert.equal(cableStem.widthPx, 2);
    near(cableStem.color, rgba(BASE_CABLE_COLOR, 0.58), 'cable stem');
    assert.equal(cableStem.positions.length, 2, 'base and tip');
    const landingStem = f.line(stems[1]);
    assert.equal(landingStem.widthPx, 2.4);
    near(landingStem.color, rgba(BASE_LANDING_COLOR, 0.68), 'landing stem');

    // A moveEnd at an unchanged camera re-runs the sweep; the identical
    // cohort is not published again.
    f.moveEnd();
    f.preRender();
    f.preRender();
    assert.equal(f.publishes().length, 1, 'identical cohorts are skipped');
    // A move past the 50 km priority quantum publishes.
    f.look(-40, 35, 6_500_000);
    f.moveEnd();
    f.preRender();
    assert.equal(f.publishes().length, 2, 'a changed cohort publishes');
  });

  test(`stems re-size only on moveEnd or the motion probe, never mid-drag (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(-35, 37.5, 400_000);
    f.display.show(dataset());
    f.preRender();
    const stem = `${CABLE_OVERLAY_SOURCE_ID}-stem-cable-reference-0-alpha`;
    assert.equal(f.positionsSet(stem), 1);
    // A drag: the camera moves every frame, no moveEnd, the probe window
    // stays closed.
    for (let tick = 0; tick < 30; tick++) {
      f.look(-35, 37.5, 400_000 + 2_000 * (tick + 1));
      f.advance(10);
      f.preRender();
    }
    assert.equal(f.positionsSet(stem), 1, 'no re-size mid-drag');
    f.moveEnd();
    f.preRender();
    assert.equal(f.positionsSet(stem), 2, 'moveEnd re-sizes once');
    f.preRender();
    assert.equal(f.positionsSet(stem), 2, 'the next frame does not');
    // A follow camera never raises moveEnd: past the probe window, moved
    // past the motion epsilon, one sweep.
    f.look(-35, 37.5, 300_000);
    f.advance(CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS + 1);
    f.preRender();
    assert.equal(f.positionsSet(stem), 3, 'the motion fallback sweeps');
    f.advance(CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS + 1);
    f.preRender();
    assert.equal(f.positionsSet(stem), 3, 'a parked camera never sweeps');
  });

  test(`a click on a path, marker, tip or stem flies to its reference (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(-40, 35, 4_500_000);
    f.display.show(dataset());
    f.preRender();
    const stem = `${CABLE_OVERLAY_SOURCE_ID}-stem-landing-point-reference-2-lisbon`;
    for (const target of [
      { ground: PATHS, instance: 1 },
      { mover: MARKERS, instance: 0 },
      { mover: CABLE_TIPS, instance: 0 },
      { line: stem },
    ])
      f.click(target);
    assert.equal(f.flights.length, 4);
    const [path, marker, tip, stemFlight] = f.flights;
    const at = (flight) => {
      const place = geo.cartographic.fromCartesian(flight.destination);
      return [
        geo.math.toDegrees(place.longitude),
        geo.math.toDegrees(place.latitude),
        place.height,
      ];
    };
    near(at(path), [-40, 35, 6500], 'the cable reference');
    near(at(marker), [-9.1, 38.7, 6500], 'the landing point');
    near(at(tip), [-40, 35, 6500], 'the tip');
    near(at(stemFlight), [-9.1, 38.7, 6500], 'the stem');
    assert.equal(path.duration, 1.35);
    assert.equal(path.easing, 'cubicInOut');
    assert.ok(
      Math.abs(path.orientation.pitch - geo.math.toRadians(-52)) < 1e-12,
    );
    assert.equal(path.orientation.roll, 0);
    assert.ok(
      Math.abs(path.orientation.heading - f.engine.camera.pose().heading) <
        1e-9,
      'keeps the heading',
    );

    // A tool owns the pointer: the click is the tool's.
    const lease = claimPointer('draw');
    try {
      f.click({ ground: PATHS, instance: 0 });
    } finally {
      releasePointer(lease);
    }
    // Nothing, the map, or another layer's object.
    f.click(undefined);
    f.click({ id: 'cable-reference-0-alpha', owner: 'someone-else' });
    assert.equal(f.flights.length, 4);
    f.display.hide();

    f.engine.fake.script('pick', {
      id: 'cable-reference-0-alpha',
      owner: PATHS,
    });
    f.engine.fake.input('click', { position: { x: 1, y: 1 } });
    f.engine.fake.unscript('pick');
    assert.equal(f.flights.length, 4, 'a hidden display takes no clicks');
  });

  test(`hide clears what the display drew and its labels; show draws it again (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(-40, 35, 4_500_000);
    f.display.show(dataset());
    f.preRender();
    assert.equal(f.engine.ground.list().length, 1);
    assert.equal(f.engine.movers.list().length, 3);
    assert.equal(f.engine.lines.list().length, 1);
    f.hostCalls.length = 0;
    f.display.hide();
    assert.deepEqual(f.hostCalls, [
      ['clear', CABLE_OVERLAY_SOURCE_ID],
      ['visible', CABLE_OVERLAY_SOURCE_ID, false],
    ]);
    assert.equal(f.engine.ground.list().length, 0);
    assert.equal(f.engine.movers.list().length, 0);
    assert.equal(f.engine.lines.list().length, 0);
    assert.equal(f.display.stats().referenceLabelCount, 0);
    f.preRender();
    assert.equal(f.publishes().length, 0, 'no sweep while hidden');
    // An identical cohort publishes again after the hide cleared the host.
    const same = dataset();
    f.display.show(same);
    f.preRender();
    assert.equal(f.publishes().length, 1);
    f.display.show(same);
    assert.equal(f.engine.ground.list().length, 1, 'the same dataset stays');
    f.display.destroy();
    assert.equal(f.engine.ground.list().length, 0);
    assert.equal(f.engine.movers.list().length, 0);
    f.display.show(same);
    assert.equal(f.engine.ground.list().length, 0, 'destroyed: draws nothing');
  });
}

test('every bundled cable path draws with its own feature, one reference per feature', (t) => {
  const read = (file) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../../data/local_data/telegeography_submarine_cables/${file}`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  const cables = read('cable-geo.json');
  const landings = read('landing-point-geo.json');
  const [makeFake] = HARNESSES;
  const f = fixture(t, makeFake);
  f.display.show({ cables, landingPoints: landings });
  const items = f.groundSet(PATHS).items;
  const expanded = cables.features.flatMap((feature) =>
    feature.geometry.coordinates.map(() => feature),
  );
  assert.equal(items.length, expanded.length);
  const ids = new Map();
  items.forEach((item, index) => {
    const feature = expanded[index];
    near(item.color, rgba(feature.properties.color, 0.92), feature.id);
    const owner = ids.get(item.pickId);
    if (owner) assert.equal(owner, feature, 'one reference per feature');
    ids.set(item.pickId, feature);
  });
  assert.equal(ids.size, cables.features.length);
  assert.equal(
    f.engine.movers.list().find(({ id }) => id === CABLE_TIPS).count,
    cables.features.length,
  );
  assert.equal(
    f.engine.movers.list().find(({ id }) => id === MARKERS).count,
    landings.features.length,
  );
});

test('the display draws on the contract only', () => {
  const source = readFileSync(new URL('./display.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from 'cesium'|from 'three'|@navaramap/);
  assert.doesNotMatch(source, /engine\.kind|extensions|defineGroundEffect/);
  assert.doesNotMatch(source, /ScreenSpaceEventHandler/);
});

const FIJI = [178.44, -18.12];
// Cable A leaves Fiji eastwards across the antimeridian as ONE unsplit path
// and has no reference coordinates, so its reference comes from its geometry.
const cableA = {
  type: 'Feature',
  properties: { id: 'cable-a', name: 'Cable A' },
  geometry: {
    type: 'LineString',
    coordinates: [FIJI, [-170, -10]],
  },
};
// Cable B ends at the same landing point and runs south-west.
const cableB = {
  type: 'Feature',
  properties: { id: 'cable-b', name: 'Cable B', coordinates: [174, -24] },
  geometry: {
    type: 'LineString',
    coordinates: [FIJI, [170, -30]],
  },
};
const landing = {
  type: 'Feature',
  properties: { id: 'suva', name: 'Suva' },
  geometry: { type: 'Point', coordinates: FIJI },
};

function fijiFixture(t) {
  const harness = fakeHarness();
  const { engine } = harness;
  engine.fake.setPose({
    longitude: geo.math.toRadians(FIJI[0]),
    latitude: geo.math.toRadians(FIJI[1]),
    height: 400000,
  });
  const host = { setVisible() {}, setEntries() {}, clearSource() {} };
  const cables = createCablesDisplay(engine, { overlayHost: host });
  cables.show({
    cables: { type: 'FeatureCollection', features: [cableA, cableB] },
    landingPoints: { type: 'FeatureCollection', features: [landing] },
  });
  harness.preRender();
  t.after(() => {
    cables.destroy();
    engine.destroy();
  });
  return harness;
}

const fijiScreen = (engine, [lon, lat]) =>
  engine.projector.worldToWindow(geo.cartesian3.fromDegrees(lon, lat), {});

test('edge:telegeography-submarine-cables: an antimeridian crossing draws no segment across the whole map', (t) => {
  const { engine, groundSet } = fijiFixture(t);
  // The path keeps its own two points: the ground set follows the short
  // great circle across 180°, as Cesium's ground polylines do.
  const [first] = groundSet(PATHS).items;
  assert.deepEqual(first.positions, cableA.geometry.coordinates);
  // Picks find it along the short way and nowhere on the long way round.
  const edgeLat = -18.12 + ((180 - 178.44) / (190 - 178.44)) * (-10 + 18.12);
  const beyond = fijiScreen(engine, [180.5, edgeLat + 0.35]);
  assert.equal(engine.picker.pick(beyond)?.id, 'cable-reference-0-cable-a');
  for (const lon of [170, 160, 150])
    assert.notEqual(
      engine.picker.pick(fijiScreen(engine, [lon, -14]))?.owner,
      PATHS,
      `no cable at ${lon}°`,
    );
});

test('edge:telegeography-submarine-cables: a click on a cable beside its landing point returns that cable and flies to its own reference', (t) => {
  const { engine, flights } = fijiFixture(t);
  const edgeLat = -18.12 + ((180 - 178.44) / (190 - 178.44)) * (-10 + 18.12);
  const from = fijiScreen(engine, FIJI);
  const to = fijiScreen(engine, [180, edgeLat]);
  // Halfway along cable A's first stretch, well clear of the landing point.
  const at = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  assert.ok(Math.hypot(at.x - from.x, at.y - from.y) > 20);
  const picked = engine.picker.pick(at);
  assert.equal(picked?.id, 'cable-reference-0-cable-a');
  // The landing point itself still answers as the landing point.
  assert.equal(engine.picker.pick(from)?.id, 'landing-point-reference-2-suva');
  engine.fake.input('click', { position: at });
  const [flight] = flights;
  assert.ok(flight, 'the click flies to the cable');
  const target = geo.cartographic.fromCartesian(flight.destination);
  // The reference of a cable across the antimeridian stays beside it, not at 0°.
  assert.ok(
    Math.abs(geo.math.toDegrees(target.longitude)) > 170,
    `reference at ${geo.math.toDegrees(target.longitude)}°`,
  );
});

test('landing point markers stand on the coastal 3D tiles, pickable at close range', async (t) => {
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  await engine.maps.setPhotorealTiles({ id: 'photoreal' });
  engine.projector.worldToWindow = () => ({ x: 100, y: 100 });
  let height = 40;
  let loaded = false;
  engine.fake.script('sampleHeight', () => height);
  engine.fake.script('tilesLoaded', () => loaded);
  const display = createCablesDisplay(engine, {
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
  });
  t.after(() => display.destroy());
  display.show({
    cables: [],
    landingPoints: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'coast',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
      ],
    },
  });
  const { options } = engine.fake.moverSet(
    `${CABLE_OVERLAY_SOURCE_ID}-markers`,
  );
  assert.deepEqual(options.depthTest, { disableWithinM: 2500 });
  assert.equal(options.pickable, true);
  const altitude = () => {
    const { store } = engine.fake.moverSet(
      `${CABLE_OVERLAY_SOURCE_ID}-markers`,
    );
    return geo.cartographic.fromCartesian({
      x: store.positions[0],
      y: store.positions[1],
      z: store.positions[2],
    }).height;
  };
  assert.ok(Math.abs(altitude() - 40) < 0.01, 'on the tiles, not under them');
  engine.fake.frames(1);
  height = 46;
  loaded = true;
  engine.fake.frames(1);
  assert.ok(Math.abs(altitude() - 46) < 0.01, 'refined once tiles load');
});
