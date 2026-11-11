// The datacenter and dam display on the engine contract, on the fake engine
// and on the Cesium engine: what it draws (tips, stems, pins, footprints,
// lines) and their styles; the camera-height LOD; the card cohort and its
// publish skip; tip sizing and the stem updates; ground sampling, the
// terrain floor and the bounded retry; clicks, selection and teardown.
// Each harness drives preRender and moveEnd by hand, scripts the surface,
// records what the ground sets, lines and flights were given, and clicks
// with a pick of a mover instance, a ground item or a line.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { claimPointer, releasePointer } from '../../../data/inputOwnership.js';
import {
  INFRA_LOD_ACTIVE_MAX,
  INFRA_LOD_ACTIVE_MIN,
} from '../../../data/localGeojsonLod.js';
import { LOCAL_OVERLAY_COHORT_LIMIT } from '../../../data/localGeojsonCore.js';
import { rgbaFromCss } from '../../shared/color.js';
import {
  LOCAL_STEM_TIP_EPSILON_M,
  createInfrastructureDisplay,
} from './display.js';

// GroundPolylinePrimitive checks its render state's line width against the
// context's limits, which a stub scene has none of.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;

const DAMS = {
  id: 'local-dams',
  name: 'Dams',
  color: '#0088ff',
  source: 'USACE',
  osmDerived: true,
  labels: true,
  labelMax: 900,
  labelGridPx: 132,
};
const DATACENTERS = {
  id: 'local-datacenters',
  name: 'Datacenters',
  color: '#00ffff',
  source: 'Local',
  osmDerived: true,
  labels: true,
  labelMax: 700,
  labelGridPx: 138,
};
const BLUE = rgbaFromCss(DAMS.color).rgba();
const near = (actual, expected, label = '') =>
  expected.forEach((value, index) =>
    assert.ok(
      Math.abs(actual[index] - value) < 1e-6,
      `${label} ${actual} vs ${expected}`,
    ),
  );
const samePosition = (actual, expected, label = '') =>
  near(
    [actual.x, actual.y, actual.z],
    [expected.x, expected.y, expected.z],
    label,
  );

// What the engine's ground sets, lines, flights, camera inputs and render
// requests were given.
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
  const lines = new Map();
  const createSegments = engine.lines.createSegments.bind(engine.lines);
  engine.lines.createSegments = (options) => {
    const batch = createSegments(options);
    const { replace, commit, show, destroy } = batch;
    let pending = [],
      ids = [];
    batch.replace = (items) => {
      replace(items);
      pending = items.map((item) => ({
        ...item,
        positions: item.positions.map((p) => geo.cartesian3.clone(p)),
      }));
    };
    batch.commit = () => {
      commit();
      const nextIds = [];
      for (const item of pending) {
        const id = item.pickId.replace(':', '-stem-');
        const record = lines.get(id) ?? { positionsSet: 0, shows: [] };
        record.options = { ...options, ...item };
        record.positions = item.positions;
        record.positionsSet++;
        record.owner = options.id;
        lines.set(id, record);
        nextIds.push(id);
      }
      for (const id of ids) if (!nextIds.includes(id)) lines.delete(id);
      ids = nextIds;
    };
    batch.show = (visible) => {
      for (const id of ids) lines.get(id).shows.push(visible);
      show(visible);
    };
    batch.destroy = () => {
      destroy();
      for (const id of ids) lines.delete(id);
    };
    return batch;
  };
  const flights = [];
  engine.camera.flyTo = (options) => flights.push(options);
  // Camera inputs off at each suspension, on again at its resume.
  const cameraInputs = [];
  const suspend = engine.input.suspendCameraInputs.bind(engine.input);
  engine.input.suspendCameraInputs = () => {
    cameraInputs.push(false);
    const resume = suspend();
    return () => {
      cameraInputs.push(true);
      resume();
    };
  };
  const requests = [];
  const request = engine.render.request.bind(engine.render);
  engine.render.request = (reason) => {
    requests.push(reason);
    request(reason);
  };
  const liveLines = () => [...lines.keys()];
  return {
    groundSet(id) {
      const listed = engine.ground.list().find((entry) => entry.id === id);
      return listed ? sets.get(id) : undefined;
    },
    /** A live line: its options, last positions and setPositions count. */
    line: (id) => (liveLines().includes(id) ? lines.get(id) : undefined),
    liveLines,
    flights,
    cameraInputs,
    retries: () =>
      requests.filter((reason) =>
        String(reason).startsWith('local-ground-retry'),
      ).length,
    requests,
    look(lon, lat, height, orientation) {
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(lon, lat, height),
        ...(orientation ? { orientation } : {}),
      });
    },
  };
}

function fakeHarness() {
  const engine = createFakeEngine({ width: 800, height: 600 });
  const watched = watch(engine);
  let sampleCalls = 0;
  return {
    name: 'the fake engine',
    engine,
    ...watched,
    preRender: () => engine.fake.emit('frames.preRender', 0),
    moveEnd: () => engine.fake.emit('camera.moveEnd'),
    /** The scene under the features (heights in metres). */
    surface({
      supported = false,
      sample = () => undefined,
      terrain,
      tilesLoaded = true,
      photoreal = false,
    } = {}) {
      engine.surface.supported = supported;
      engine.fake.script('sampleHeight', (carto) => {
        sampleCalls++;
        return sample(carto);
      });
      engine.fake.script('terrainHeight', () => terrain());
      engine.fake.script('tilesLoaded', () => tilesLoaded());
      engine.fake.maps.photoreal = photoreal ? {} : null;
    },
    sampleCalls: () => sampleCalls,
    /** A mover set's instance: shown, colour, size, pickId and position. */
    point(id, index) {
      const entry = engine.fake.moverSet(id);
      if (!entry || index >= entry.store.count) return undefined;
      const { store, options } = entry;
      return {
        shown: store.shows[index] === 1,
        color: [...store.colors.slice(index * 4, index * 4 + 4)],
        sizePx: options.point.sizePx,
        outlinePx: options.point.outlinePx,
        depthTest: options.depthTest,
        id: store.pickIds[index],
        position: {
          x: store.positions[index * 3],
          y: store.positions[index * 3 + 1],
          z: store.positions[index * 3 + 2],
        },
      };
    },
    moverIds: () => engine.movers.list().map(({ id }) => id),
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
                  id: watched.line(target.line).options.pickId,
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

/** Freezes performance.now so the 450 ms walk gate is under test control. */
function installFakeClock(t, startMs = 1_000_000) {
  const original = performance.now;
  let nowMs = startMs;
  performance.now = () => nowMs;
  t.after(() => {
    performance.now = original;
  });
  return {
    advance(ms) {
      nowMs += ms;
    },
  };
}

function services() {
  const calls = [];
  const contexts = new Map();
  const selected = [];
  return {
    calls,
    contexts,
    selected,
    publishes: () => calls.filter(([type]) => type === 'entries'),
    services: {
      overlayHost: {
        setVisible: (...args) => calls.push(['visible', ...args]),
        setEntries: (...args) => calls.push(['entries', ...args]),
        clearSource: (...args) => calls.push(['clear', ...args]),
      },
      registerEntityContext(entity, metadata) {
        contexts.set(metadata.id, { entity, ...metadata });
      },
      selectEntityContext: (entity) => selected.push(entity),
      clearSelectedEntityContextForLayer: (layerId) =>
        calls.push(['clear-selection', layerId]),
      removeEntityContextsForLayer(layerId) {
        for (const [key, record] of contexts)
          if (record.layerId === layerId) contexts.delete(key);
      },
      showOsmCredit: (target, owner) => calls.push(['credit', target, owner]),
      hideOsmCredit: (target, owner) => calls.push(['uncredit', target, owner]),
    },
  };
}

const ring = (lon, lat, size = 0.01) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat],
];

/** The session's dataset: features, and records for points and polygons. */
function dataset(features) {
  const records = [];
  for (const feature of features) {
    const g = feature.geometry;
    let lon, lat;
    if (g.type === 'Point') [lon, lat] = g.coordinates;
    else if (g.type === 'Polygon') {
      const center = geo.boundingSphere.fromPoints(
        g.coordinates[0].map(([x, y]) => geo.cartesian3.fromDegrees(x, y)),
      ).center;
      const carto = geo.cartographic.fromCartesian(center);
      lon = geo.math.toDegrees(carto.longitude);
      lat = geo.math.toDegrees(carto.latitude);
    } else continue;
    records.push({
      id: feature.id,
      lon,
      lat,
      properties: feature.properties ?? {},
      geometry: g,
    });
  }
  return { features, records };
}

const DAM = {
  type: 'Feature',
  id: 'real-dam',
  properties: {
    name: 'Runtime Dam',
    tags: { associated_river: 'Test River' },
  },
  geometry: { type: 'Polygon', coordinates: [ring(-97.7, 30.2)] },
};
const DAM_LON = -97.695;
const DAM_LAT = 30.2033;

function fixture(t, makeHarness, { config = DAMS, surface = {} } = {}) {
  const harness = makeHarness();
  const host = services();
  harness.surface({
    terrain: () => undefined,
    tilesLoaded: () => true,
    ...surface,
  });
  const display = createInfrastructureDisplay(harness.engine, {
    config,
    services: host.services,
  });
  t.after(() => {
    display.destroy();
    harness.engine.destroy();
  });
  const tips = `${config.id}-tips`;
  return {
    ...harness,
    ...host,
    display,
    tips,
    tip: (index = 0) => harness.point(tips, index),
    shownCount: () => {
      let shown = 0;
      for (let index = 0; harness.point(tips, index); index++)
        if (harness.point(tips, index).shown) shown++;
      return shown;
    },
    stemId: (featureId) => `${config.id}-stem-${featureId}`,
    /** The dam's base height: 0 until a sample lands. */
    baseHeight(featureId = DAM.id) {
      const line = harness.line(`${config.id}-stem-${featureId}`);
      return geo.cartographic.fromCartesian(line.positions[0]).height;
    },
  };
}

/** The camera `southM` south of the dam at `cameraM`, aimed at `groundM`. */
function aim(f, { groundM, cameraM, southM, away = false }) {
  const lat = DAM_LAT - geo.math.toDegrees(southM / 6_371_000);
  const pitch = Math.atan2(groundM - cameraM, southM);
  f.look(DAM_LON, lat, cameraM, {
    heading: away ? Math.PI : 0,
    pitch: away ? -pitch : pitch,
    roll: 0,
  });
}

/** Whether a position is off the screen (or behind the camera). */
function offScreen(engine, position) {
  const at = engine.projector.worldToWindow(position);
  const { width, height } = engine.host.size();
  return !at || at.x < 0 || at.y < 0 || at.x > width || at.y > height;
}

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`references are 10 px tips over the scene on 3.5 px stems, pins under Point features (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(DAM_LON, DAM_LAT, 20_000);
    f.display.show(
      dataset([
        DAM,
        {
          type: 'Feature',
          id: 'point-dam',
          properties: { name: 'Point Dam' },
          geometry: { type: 'Point', coordinates: [-97.69, 30.21] },
        },
      ]),
    );
    f.preRender();
    const tip = f.tip(0);
    assert.equal(tip.sizePx, 10);
    assert.equal(tip.outlinePx, 2);
    assert.equal(tip.depthTest, 'always', 'never hidden by the scene');
    near(tip.color, BLUE);
    assert.equal(tip.id, 'local-dams:real-dam');
    assert.equal(f.tip(1).id, 'local-dams:point-dam');
    const stem = f.line(f.stemId('real-dam'));
    assert.equal(stem.options.widthPx, 3.5);
    assert.deepEqual(stem.options.color, BLUE);
    assert.equal(stem.options.pickId, 'local-dams:real-dam');
    assert.equal(stem.options.depthFailAlpha ?? 0, 0, 'hidden by the scene');
    assert.ok(f.line(f.stemId('point-dam')));
    assert.equal(f.engine.lines.list().length, 1, 'one batch draws both stems');
    // The pin sits at the base of the Point feature only.
    const pin = f.point('local-dams-pins', 0);
    assert.equal(f.point('local-dams-pins', 1), undefined);
    assert.equal(pin.sizePx, 5);
    assert.equal(pin.outlinePx, 0);
    assert.equal(pin.depthTest, 'normal');
    near(pin.color, BLUE);
    assert.equal(pin.id, 'local-dams:point-dam');
    const base = geo.cartographic.fromCartesian(pin.position);
    assert.ok(Math.abs(geo.math.toDegrees(base.longitude) + 97.69) < 1e-9);
    assert.ok(Math.abs(base.height) < 0.01, 'on the ellipsoid until sampled');
  });

  test(`footprints fill at 0.3 without an outline, holes kept; lines are 2 px corridors (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(DAM_LON, DAM_LAT, 20_000);
    const holed = {
      type: 'Feature',
      id: 'holed',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [ring(-97.6, 30.2, 0.02), ring(-97.595, 30.205, 0.005)],
      },
    };
    const line = {
      type: 'Feature',
      id: 'weir',
      properties: { name: 'Weir' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-97.5, 30.2],
          [-97.49, 30.21],
        ],
      },
    };
    f.display.show(dataset([DAM, holed, line]));
    const lines = f.groundSet('local-dams-lines');
    assert.equal(lines.options.kind, 'corridor');
    assert.equal(lines.options.pickable, true);
    assert.equal(lines.options.order, 1, 'over the footprints');
    assert.deepEqual(lines.items, [
      {
        positions: line.geometry.coordinates,
        color: BLUE,
        widthPx: 2,
        pickId: 'local-dams:weir',
      },
    ]);
    f.preRender();
    const footprints = f.groundSet('local-dams-footprints');
    assert.equal(footprints.options.kind, 'polygon');
    assert.equal(footprints.options.pickable, true);
    assert.deepEqual(
      footprints.items.map(({ pickId }) => pickId),
      ['local-dams:real-dam', 'local-dams:holed'],
    );
    const [first, second] = footprints.items;
    assert.deepEqual(first.fill, [...BLUE.slice(0, 3), 0.3]);
    assert.equal(first.outline, undefined, 'Cesium draws no clamped outline');
    assert.equal(second.rings.length, 2, 'the hole is kept');
    assert.equal(f.liveLines().includes(f.stemId('weir')), false);
    assert.equal(f.display.lod().total, 2, 'a line has no reference');
  });

  test(`records register their context, the OSM credit follows the data (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.display.show(dataset([DAM]));
    const context = f.contexts.get('local-dams:real-dam');
    assert.equal(context.layerId, 'local-dams');
    assert.equal(context.layerName, 'Dams');
    assert.equal(context.source, 'USACE');
    assert.equal(context.label, 'Runtime Dam');
    assert.deepEqual(context.properties, DAM.properties);
    assert.equal(context.latitude, Number(context.entity.lat.toFixed(6)));
    assert.equal(context.longitude, Number(context.entity.lon.toFixed(6)));
    assert.deepEqual(
      f.calls.filter(([type]) => type === 'credit'),
      [['credit', f.engine, 'local-dams']],
    );
    f.display.hide();
    assert.equal(f.contexts.size, 0);
    assert.ok(f.calls.some((call) => call[0] === 'uncredit'));
    assert.ok(
      f.calls.some(
        ([type, layerId]) =>
          type === 'clear-selection' && layerId === 'local-dams',
      ),
    );
  });

  test(`a layer that is not OSM-derived shows no OSM credit (${name})`, (t) => {
    const f = fixture(t, makeHarness, {
      config: { ...DAMS, osmDerived: false },
    });
    f.display.show(dataset([DAM]));
    assert.equal(f.calls.filter(([type]) => type === 'credit').length, 0);
  });

  test(`parked frames do not republish the same cohort; a move or a re-show does (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    const clock = installFakeClock(t);
    f.look(DAM_LON, DAM_LAT, 100_000);
    const data = dataset([DAM]);
    f.display.show(data);
    f.preRender();
    assert.equal(f.publishes().length, 1);
    assert.ok(f.publishes()[0][2].length > 0, 'the cohort is populated');
    assert.deepEqual(f.publishes()[0][3], {
      cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
      collisionCapacity: 96,
      moving: false,
    });
    for (let i = 0; i < 6; i++) {
      clock.advance(1_000);
      f.preRender();
    }
    assert.equal(f.publishes().length, 1);
    f.look(DAM_LON + 0.1, DAM_LAT, 100_000);
    f.moveEnd();
    f.preRender();
    assert.equal(f.publishes().length, 2, 'moved tips reach the host');
    f.display.hide();
    assert.ok(
      f.calls.some(([type, id]) => type === 'clear' && id === 'local-dams'),
    );
    f.display.show(data);
    f.preRender();
    assert.equal(f.publishes().length, 3, 'a re-show republishes');
  });

  test(`the first walk runs on the next frame and the cards follow the visible tips (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(DAM_LON, DAM_LAT, 100_000);
    f.display.show(dataset([DAM]));
    assert.equal(f.publishes().length, 0);
    assert.equal(f.display.lod().computed, false);
    assert.ok(f.requests.includes('local-dams'), 'asks for that frame');
    f.preRender();
    const [entry] = f.publishes()[0][2];
    assert.equal(entry.id, 'real-dam');
    assert.equal(entry.title, 'Runtime Dam');
    assert.deepEqual(entry.details, ['Test River']);
    samePosition(entry.position, f.tip(0).position);
  });

  test(`unchanged moveEnds do not redraw the stem; each real tip change draws once (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(DAM_LON, DAM_LAT, 100_000);
    f.display.show(dataset([DAM]));
    f.preRender();
    const stem = () => f.line(f.stemId('real-dam'));
    const drawn = stem().positionsSet;
    f.moveEnd();
    f.preRender();
    f.moveEnd();
    f.preRender();
    assert.equal(stem().positionsSet, drawn);
    const camera = f.engine.camera.pose().position;
    const move = (dx) =>
      f.engine.camera.setView({
        destination: geo.cartesian3.add(
          camera,
          geo.cartesian3.create(dx, 0, 0),
          geo.cartesian3.create(),
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    move(LOCAL_STEM_TIP_EPSILON_M / 10);
    f.moveEnd();
    f.preRender();
    assert.equal(stem().positionsSet, drawn, 'sub-epsilon noise is not drawn');
    for (const [index, dx] of [10_000, 20_000, 30_000].entries()) {
      move(dx);
      f.moveEnd();
      f.preRender();
      assert.equal(stem().positionsSet, drawn + index + 1);
      samePosition(stem().positions[1], f.tip(0).position);
    }
  });

  for (const [heightM, minStemM, maxStemM] of [
    [500, 45, 90],
    [10000, 1100, 1400],
  ])
    test(`stems stay proportional at ${heightM} m (${name})`, (t) => {
      const f = fixture(t, makeHarness);
      const data = dataset([DAM]);
      const { lon, lat } = data.records[0];
      f.look(lon, lat, heightM);
      f.display.show(data);
      f.preRender();
      const [base, tip] = f.line(f.stemId('real-dam')).positions;
      const stemM = geo.cartesian3.distance(base, tip);
      assert.ok(
        stemM >= minStemM && stemM <= maxStemM,
        `${stemM.toFixed(1)} m at ${heightM} m`,
      );
    });

  test(`ground sampling waits for the loaded globe before caching a height (${name})`, (t) => {
    let loaded = false;
    const f = fixture(t, makeHarness, {
      surface: {
        supported: true,
        sample: () => 117,
        terrain: () => 117,
        tilesLoaded: () => loaded,
      },
    });
    const clock = installFakeClock(t);
    f.look(DAM_LON, DAM_LAT, 20_000);
    f.display.show(dataset([DAM]));
    f.preRender();
    assert.equal(f.sampleCalls(), 0, 'streaming terrain is not a final sample');
    assert.ok(Math.abs(f.baseHeight()) < 0.01);
    loaded = true;
    clock.advance(2_100);
    f.preRender();
    assert.equal(f.sampleCalls(), 1, 'the retry samples the settled scene');
    assert.ok(Math.abs(f.baseHeight() - 117) < 0.01);
    assert.ok(
      Math.abs(geo.cartographic.fromCartesian(f.tip(0).position).height - 117) >
        1,
      'the tip stands above the new base',
    );
  });

  test(`an unseen base is not sampled and arms no retry until it is in view (${name})`, (t) => {
    const f = fixture(t, makeHarness, {
      surface: { supported: true, sample: () => 117, terrain: () => 117 },
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clock = installFakeClock(t);
    // Looking away from the dam.
    aim(f, { groundM: 117, cameraM: 20_000, southM: 5_000, away: true });
    f.display.show(dataset([DAM]));
    clock.advance(10_500);
    f.preRender();
    assert.equal(f.sampleCalls(), 0, 'an off-screen base is not sampled');
    assert.equal(f.retries(), 0, 'nor keeps a parked camera rendering');
    // In view but over the horizon: 50 m up, about 67 km away.
    f.look(-97.0, DAM_LAT, 50, {
      heading: -Math.PI / 2,
      pitch: 0,
      roll: 0,
    });
    f.moveEnd();
    clock.advance(10_500);
    f.preRender();
    assert.equal(f.sampleCalls(), 0, 'a base over the horizon is not sampled');
    assert.equal(f.retries(), 0);
    f.look(DAM_LON, DAM_LAT, 20_000);
    f.moveEnd();
    f.preRender();
    assert.equal(f.sampleCalls(), 1, 'sampled on the first walk that sees it');
    assert.ok(Math.abs(f.baseHeight() - 117) < 0.01);
  });

  for (const { label, photoreal, groundM, cameraM, southM, baseOffScreen } of [
    // 2,500 m terrain from 3 km away at a shallow angle: the ellipsoid-height
    // base is far below the bottom of the screen.
    {
      label: 'high ground with loaded terrain',
      photoreal: false,
      groundM: 2_500,
      cameraM: 3_500,
      southM: 3_000,
      baseOffScreen: true,
    },
    {
      label: 'high ground under photoreal tiles',
      photoreal: true,
      groundM: 2_500,
      cameraM: 3_500,
      southM: 3_000,
      baseOffScreen: true,
    },
    // A low-geoid coast (about -63 m near Mumbai) from 50 m up: the
    // ellipsoidal horizon would hide the ground itself.
    {
      label: 'ground below the ellipsoid',
      photoreal: false,
      groundM: -63,
      cameraM: 50,
      southM: 2_000,
      baseOffScreen: false,
    },
  ])
    test(`${label} in view is sampled (${name})`, (t) => {
      const f = fixture(t, makeHarness, {
        surface: {
          supported: true,
          sample: () => groundM,
          terrain: () => (photoreal ? undefined : groundM),
          photoreal,
        },
      });
      const clock = installFakeClock(t);
      const data = dataset([DAM]);
      f.display.show(data);
      aim(f, { groundM, cameraM, southM });
      const base = geo.cartesian3.fromDegrees(
        data.records[0].lon,
        data.records[0].lat,
      );
      if (baseOffScreen)
        assert.ok(
          offScreen(f.engine, base),
          'precondition: the ellipsoid-height base is off screen',
        );
      clock.advance(2_100);
      f.preRender();
      assert.equal(f.sampleCalls(), 1, 'the ground in view is sampled');
      assert.ok(Math.abs(f.baseHeight() - groundM) < 0.01);
    });

  test(`under photoreal tiles, ground behind the camera is not sampled (${name})`, (t) => {
    const f = fixture(t, makeHarness, {
      surface: {
        supported: true,
        sample: () => 2_500,
        terrain: () => undefined,
        photoreal: true,
      },
    });
    const clock = installFakeClock(t);
    aim(f, { groundM: 2_500, cameraM: 3_500, southM: 3_000, away: true });
    f.display.show(dataset([DAM]));
    clock.advance(2_100);
    f.preRender();
    assert.equal(f.sampleCalls(), 0);
  });

  test(`settled terrain lifts a sampled base without another sample (${name})`, (t) => {
    let terrain = 117;
    let loaded = true;
    let photoreal = false;
    const f = fixture(t, makeHarness, {
      surface: {
        supported: true,
        sample: () => 117,
        terrain: () => terrain,
        tilesLoaded: () => loaded,
      },
    });
    const clock = installFakeClock(t);
    f.look(DAM_LON, DAM_LAT, 20_000);
    f.display.show(dataset([DAM]));
    f.preRender();
    assert.ok(Math.abs(f.baseHeight() - 117) < 0.01);
    terrain = 120;
    loaded = false;
    clock.advance(500);
    f.preRender();
    assert.ok(Math.abs(f.baseHeight() - 117) < 0.01, 'waits for the mesh');
    loaded = true;
    clock.advance(500);
    f.preRender();
    assert.ok(Math.abs(f.baseHeight() - 120) < 0.01, 'follows the floor');
    terrain = 110;
    clock.advance(500);
    f.preRender();
    assert.ok(Math.abs(f.baseHeight() - 120) < 0.01, 'never lowered');
    terrain = 140;
    photoreal = true;
    f.surface({
      supported: true,
      sample: () => 117,
      terrain: () => terrain,
      tilesLoaded: () => loaded,
      photoreal,
    });
    clock.advance(500);
    f.preRender();
    assert.ok(
      Math.abs(f.baseHeight() - 117) < 0.01,
      'switching surfaces places the base on the mesh',
    );
    assert.equal(f.sampleCalls(), 3, 'one sample per changed surface');
  });

  for (const [terrainHeight, sampledHeight, expectedHeight, photoreal] of [
    [117, -2238, 117, false],
    [-400, -410, -400, false],
    [117, 180, 180, false],
    [117, -20, -20, true],
  ])
    test(`a sample of ${sampledHeight} over terrain ${terrainHeight} (photoreal ${photoreal}) is ${expectedHeight} (${name})`, (t) => {
      const f = fixture(t, makeHarness, {
        surface: {
          supported: true,
          sample: () => sampledHeight,
          terrain: () => terrainHeight,
          photoreal,
        },
      });
      installFakeClock(t);
      f.look(DAM_LON, DAM_LAT, 20_000);
      f.display.show(dataset([DAM]));
      f.preRender();
      assert.ok(
        Math.abs(f.baseHeight() - expectedHeight) < 0.01,
        `base ${f.baseHeight()}`,
      );
    });

  test(`the stem is excluded when a changed surface is sampled (${name})`, (t) => {
    let height = 50;
    const f = fixture(t, makeHarness, {
      surface: { supported: true, sample: () => height, terrain: () => 0 },
    });
    installFakeClock(t);
    f.look(DAM_LON, DAM_LAT, 20_000);
    f.display.show(dataset([DAM]));
    f.preRender();
    height = 70;
    f.moveEnd();
    f.preRender();
    const call = f.engine.fake.callsOf('surface.sampleHeight').at(-1);
    assert.equal(
      call.args[1].length,
      2,
      'both the tips and the stem batch are excluded',
    );
    assert.ok(Math.abs(f.baseHeight() - 70) < 0.01);
  });

  for (const trigger of ['moveEnd', 'tilesLoaded', 'terrainRevision']) {
    test(`infrastructure follows ${trigger} and stops requesting idle frames (${name})`, async (t) => {
      let height;
      let loaded = true;
      const f = fixture(t, makeHarness, {
        surface: {
          supported: true,
          sample: () => height,
          terrain: () => undefined,
          tilesLoaded: () => loaded,
        },
      });
      installFakeClock(t);
      f.look(DAM_LON, DAM_LAT, 20_000);
      f.display.show(dataset([DAM]));
      f.preRender();
      assert.ok(Math.abs(f.baseHeight()) < 0.01);
      height = 210;
      if (trigger === 'moveEnd') f.moveEnd();
      if (trigger === 'tilesLoaded') {
        loaded = false;
        f.preRender();
        loaded = true;
      }
      if (trigger === 'terrainRevision')
        await f.engine.maps.setTerrain({ kind: 'ellipsoid' });
      f.preRender();
      assert.ok(Math.abs(f.baseHeight() - 210) < 0.01);
      const requests = f.requests.length;
      f.preRender();
      f.preRender();
      assert.equal(f.requests.length, requests);
      f.display.hide();
      f.moveEnd();
      f.preRender();
      assert.equal(f.engine.movers.list().length, 0);
    });
  }
}

// 150 polygons near Austin; the even ones are named (high label priority).
function lodFeatures(count = 150) {
  return Array.from({ length: count }, (_, i) => {
    const lon = -97.7 + (i % 12) * 0.02;
    const lat = 30.2 + Math.floor(i / 12) * 0.02;
    return {
      type: 'Feature',
      id: `dc-${i}`,
      properties:
        i % 2 === 0
          ? {
              name: `Datacenter ${i}`,
              tags: { name: `Datacenter ${i}`, operator: 'Example Cloud' },
            }
          : { tags: {} },
      geometry: { type: 'Polygon', coordinates: [ring(lon, lat, 0.004)] },
    };
  });
}

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();
  const lodFixture = (t, count, heightM) => {
    const f = fixture(t, makeHarness, { config: DATACENTERS });
    const clock = installFakeClock(t);
    f.look(-97.7, 30.2, heightM);
    f.display.show(dataset(lodFeatures(count)));
    return { f, clock };
  };
  const shownIds = (f) => {
    const ids = [];
    for (let index = 0; f.tip(index); index++)
      if (f.tip(index).shown) ids.push(f.tip(index).id);
    return ids.sort();
  };

  test(`the LOD caps references at the camera-height budget and widens on zoom (${name})`, (t) => {
    const { f, clock } = lodFixture(t, 150, 9_000_000);
    f.preRender();
    assert.equal(f.shownCount(), INFRA_LOD_ACTIVE_MIN);
    const shown = new Set(shownIds(f));
    for (let i = 0; i < 150; i += 2)
      assert.ok(shown.has(`local-datacenters:dc-${i}`), 'named ones first');
    assert.equal(
      f.groundSet('local-datacenters-footprints').items.length,
      INFRA_LOD_ACTIVE_MIN,
      'footprints follow the LOD',
    );
    assert.equal(f.liveLines().length, INFRA_LOD_ACTIVE_MIN, 'one stem each');
    f.look(-97.7, 30.2, 1_000_000);
    f.moveEnd();
    clock.advance(500);
    f.preRender();
    assert.equal(f.shownCount(), 150);
    assert.equal(f.groundSet('local-datacenters-footprints').items.length, 150);
  });

  test(`the LOD selection holds between camera moves (${name})`, (t) => {
    const { f, clock } = lodFixture(t, 150, 9_000_000);
    f.preRender();
    const first = shownIds(f);
    const commits = f.groundSet('local-datacenters-footprints').commits;
    clock.advance(500);
    f.preRender();
    assert.deepEqual(shownIds(f), first);
    assert.equal(
      f.groundSet('local-datacenters-footprints').commits,
      commits,
      'no footprint rebuild',
    );
  });

  test(`lod() reports the active/total split and the band budget (${name})`, (t) => {
    const { f, clock } = lodFixture(t, 150, 9_000_000);
    assert.deepEqual(f.display.lod(), {
      total: 150,
      active: 0,
      budgetLimit: 0,
      computed: false,
    });
    f.preRender();
    assert.deepEqual(f.display.lod(), {
      total: 150,
      active: INFRA_LOD_ACTIVE_MIN,
      budgetLimit: INFRA_LOD_ACTIVE_MIN,
      computed: true,
    });
    f.look(-97.7, 30.2, 60_000);
    f.moveEnd();
    clock.advance(500);
    f.preRender();
    assert.equal(f.display.lod().active, 150);
    assert.ok(f.display.lod().budgetLimit >= 150);
  });

  test(`hide releases every reference; a re-show selects afresh (${name})`, (t) => {
    const { f } = lodFixture(t, 40, 9_000_000);
    const data = dataset(lodFeatures(40));
    f.display.hide();
    f.display.show(data);
    f.preRender();
    assert.equal(f.shownCount(), 40);
    f.display.hide();
    assert.deepEqual(f.moverIds(), []);
    assert.deepEqual(f.liveLines(), []);
    assert.equal(f.engine.ground.list().length, 0);
    assert.deepEqual(f.display.lod(), {
      total: 0,
      active: 0,
      budgetLimit: 0,
      computed: false,
    });
    f.display.show(data);
    f.preRender();
    assert.equal(f.shownCount(), 40);
  });

  test(`the LOD re-selects during continuous motion without a moveEnd (${name})`, (t) => {
    const { f, clock } = lodFixture(t, 150, 9_000_000);
    f.preRender();
    assert.equal(f.display.lod().budgetLimit, INFRA_LOD_ACTIVE_MIN);
    f.look(-97.7, 30.2, 60_000);
    clock.advance(500);
    f.preRender();
    assert.equal(
      f.display.lod().budgetLimit,
      INFRA_LOD_ACTIVE_MIN,
      'the probe window rate-limits it',
    );
    clock.advance(600);
    f.preRender();
    assert.equal(f.display.lod().budgetLimit, INFRA_LOD_ACTIVE_MAX);
    assert.equal(f.display.lod().active, 150);
    assert.equal(f.shownCount(), 150);
    const parked = f.display.lod();
    clock.advance(2_000);
    f.preRender();
    assert.deepEqual(
      f.display.lod(),
      parked,
      'a parked camera never re-selects',
    );
  });

  test(`a reference behind the horizon hides with its stem and card (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    const clock = installFakeClock(t);
    f.look(DAM_LON, DAM_LAT, 100_000);
    f.display.show(dataset([DAM]));
    f.preRender();
    assert.equal(f.tip(0).shown, true);
    assert.equal(f.contexts.get('local-dams:real-dam').entity.show, true);
    f.look(DAM_LON + 180, -DAM_LAT, 100_000);
    clock.advance(500);
    f.preRender();
    assert.equal(f.tip(0).shown, false);
    assert.equal(f.liveLines().length, 0);
    assert.equal(
      f.contexts.get('local-dams:real-dam').entity.show,
      false,
      'its context is inactive, as a hidden entity',
    );
    assert.deepEqual(f.publishes().at(-1)[2], []);
  });

  test(`a click on a tip, stem, pin or footprint selects and flies to the feature (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(DAM_LON, DAM_LAT, 20_000);
    const point = {
      type: 'Feature',
      id: 'point-dam',
      properties: { name: 'Point Dam' },
      geometry: { type: 'Point', coordinates: [-97.69, 30.21] },
    };
    const data = dataset([DAM, point]);
    f.display.show(data);
    f.preRender();
    const flight = (lon, lat) => {
      const last = f.flights.at(-1);
      const carto = geo.cartographic.fromCartesian(last.destination);
      assert.ok(Math.abs(geo.math.toDegrees(carto.longitude) - lon) < 1e-9);
      assert.ok(Math.abs(geo.math.toDegrees(carto.latitude) - lat) < 1e-9);
      assert.ok(Math.abs(carto.height - 5000) < 1e-6);
      assert.equal(last.duration, 1.5);
    };
    const [dam, pointRecord] = data.records;
    f.click({ mover: f.tips, instance: 0 });
    assert.equal(f.selected.at(-1).id, 'real-dam');
    flight(dam.lon, dam.lat);
    assert.deepEqual(f.cameraInputs, [false], 'inputs off for the flight');
    f.flights.at(-1).complete();
    assert.deepEqual(f.cameraInputs, [false, true]);
    f.click({ mover: 'local-dams-pins', instance: 0 });
    assert.equal(f.selected.at(-1).id, 'point-dam');
    flight(pointRecord.lon, pointRecord.lat);
    f.flights.at(-1).cancel();
    assert.equal(f.cameraInputs.at(-1), true);
    f.click({ line: f.stemId('point-dam') });
    assert.equal(f.selected.length, 3);
    f.click({ ground: 'local-dams-footprints', instance: 0 });
    assert.equal(f.selected.at(-1).id, 'real-dam');
    assert.equal(f.flights.length, 4);
  });

  test(`a click on a line flies to its first vertex without selecting (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.display.show(
      dataset([
        {
          type: 'Feature',
          id: 'weir',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [-97.5, 30.2],
              [-97.49, 30.21],
            ],
          },
        },
      ]),
    );
    f.click({ ground: 'local-dams-lines', instance: 0 });
    assert.equal(f.selected.length, 0);
    const carto = geo.cartographic.fromCartesian(f.flights[0].destination);
    assert.ok(Math.abs(geo.math.toDegrees(carto.longitude) + 97.5) < 1e-9);
  });

  test(`other picks, a claimed pointer and a hidden display ignore the click (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(DAM_LON, DAM_LAT, 20_000);
    f.display.show(dataset([DAM]));
    f.preRender();
    f.click({ id: 'something-else' });
    f.click(undefined);
    const lease = claimPointer('draw');
    f.click({ mover: f.tips, instance: 0 });
    releasePointer(lease);
    assert.equal(f.flights.length, 0);
    assert.equal(f.selected.length, 0);
    f.display.hide();
    f.click({ id: 'local-dams:real-dam' });
    assert.equal(f.flights.length, 0);
  });

  test(`select() restores a feature's selection; an unknown one is refused (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.display.show(dataset([DAM]));
    assert.equal(f.display.select('real-dam'), true);
    assert.equal(f.selected[0].id, 'real-dam');
    assert.equal(f.display.select('nope'), false);
  });

  test(`destroy releases everything and the display stays inert (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.look(DAM_LON, DAM_LAT, 20_000);
    const data = dataset([DAM]);
    f.display.show(data);
    f.preRender();
    f.display.destroy();
    assert.deepEqual(f.moverIds(), []);
    assert.deepEqual(f.liveLines(), []);
    assert.equal(f.engine.ground.list().length, 0);
    assert.equal(f.contexts.size, 0);
    const calls = f.calls.length;
    f.display.show(data);
    f.preRender();
    f.moveEnd();
    assert.equal(f.calls.length, calls, 'no late host work');
    assert.deepEqual(f.moverIds(), []);
  });
}
