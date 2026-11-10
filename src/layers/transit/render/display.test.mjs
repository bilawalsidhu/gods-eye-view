// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { cameraSensitivityClaims } from '../../../data/cameraSensitivity.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { transitIcon } from '../../../data/transitIcons.js';
import { rgbaFromCss } from '../../shared/color.js';
import { createTransitDisplay, transitAtlasIcons } from './display.js';
import { TRAIL_BANDS, trailAlpha, trailBand, trailBandAlpha } from './style.js';
import { transitAtlasLayout, transitTestAtlas } from './testAtlas.mjs';

const AUSTIN = { lat: 30.2672, lon: -97.7431 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

function fakeHarness(options = {}) {
  const engine = createFakeEngine(options.engine);
  return {
    name: 'the fake engine',
    engine,
    frame: () => engine.fake.frame(),
    commits: (id) => engine.fake.moverSet(id).commits,
    sprite(id, index) {
      const { store, options: set } = engine.fake.moverSet(id);
      return {
        shown: index < store.count && store.shows[index] === 1,
        sizePx: set.sprite.sizePx * store.scales[index],
        color: [...store.colors.slice(index * 4, index * 4 + 4)],
        rotation: store.rotations[index],
        cell: store.cellKeys[store.cells[index]],
        id: store.pickIds[index],
      };
    },
    line: (id) => {
      const line = engine.fake.line(id);
      return {
        color: [...line.color],
        widthPx: line.options.widthPx,
        depthFailAlpha: line.options.depthFailAlpha,
        shown: line.shown,
        points: line.positions.length / 3,
      };
    },
    click(position, picked) {
      engine.fake.script('pick', picked);
      engine.fake.input('click', { position });
    },
  };
}

const HARNESSES = [fakeHarness];

function setup(
  makeHarness,
  { vehicles = new Map(), credits = [], mesh = [] } = {},
) {
  const h = makeHarness();
  const groundRecords = new Map();
  const createSet = h.engine.ground.createSet;
  h.engine.ground.createSet = (options) => {
    const set = createSet(options);
    const record = { options, commits: 0, fraction: 1 };
    groundRecords.set(options.id, record);
    const { replace, commit, setReveal } = set;
    set.replace = (items) => {
      record.items = items;
      replace(items);
    };
    set.commit = () => {
      record.commits++;
      commit();
    };
    set.setReveal = (fraction) => {
      record.fraction = fraction;
      setReveal(fraction);
    };
    return set;
  };
  h.trailLines = () =>
    h.engine.ground.list().map((set) => ({
      ...set,
      points: groundRecords.get(set.id).items?.[0]?.positions.length ?? 0,
    }));
  h.trailLine = (id) => {
    const record = groundRecords.get(id);
    return {
      ...record.items[0],
      ...record,
      points: record.items[0].positions.length,
    };
  };
  h.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 2000),
  });
  const state = {
    _stylePreset: 'normal',
    _vehicles: vehicles,
    _markers: null,
    _animatedMarkers: null,
  };
  const display = createTransitDisplay(h.engine, {
    state,
    services: {
      credits: {
        registerDynamicCredit: (target, credit) =>
          credits.push([target, credit]),
        transitFeedCredit: (feed, timestamps) => ({
          timestamps,
          key: `transit-${feed.id}`,
          html: feed.name,
        }),
      },
      mesh: {
        sampleMeshFloorCells: (...args) => mesh.push(args),
      },
    },
    drawAtlas: transitTestAtlas,
  });
  display.attach();
  [state._markers, state._animatedMarkers] = display.createMarkers();
  return { ...h, display, state, credits, mesh };
}

const spec = (id, overrides = {}) => ({
  id,
  position: geo.cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 5),
  image: transitIcon('bus'),
  width: 20,
  height: 20,
  color: rgbaFromCss('#5EF08A'),
  rotation: 0,
  show: true,
  ...overrides,
});

test('the atlas holds every glyph the markers draw, once each', () => {
  const icons = transitAtlasIcons();
  assert.equal(new Set(icons).size, icons.length);
  const { cells } = transitAtlasLayout();
  for (const mode of ['bus', 'tram', 'subway', 'rail', 'ferry', 'unknown'])
    for (const style of [
      'normal',
      'thermal',
      'surveillance',
      'noir',
      'retro',
      'anime',
    ])
      for (const px of [undefined, 96])
        assert.ok(
          cells[transitIcon(mode, px, { style })],
          `${mode} ${style} ${px}`,
        );
});

test('the age bands keep the trail alpha anchors', () => {
  assert.equal(trailAlpha(0), 0.8);
  assert.equal(trailAlpha(120000), 0.45);
  assert.equal(trailAlpha(600000), 0.2);
  assert.equal(trailAlpha(900000), 0.08);
  assert.ok(Math.abs(trailAlpha(60000) - 0.625) < 1e-10);
  assert.equal(trailBandAlpha(trailBand(0.8)), 0.8);
  assert.equal(trailBandAlpha(trailBand(0.08)), 0.08);
  for (let age = 0; age <= 1_000_000; age += 1000)
    assert.ok(
      Math.abs(trailBandAlpha(trailBand(trailAlpha(age))) - trailAlpha(age)) <=
        0.72 / TRAIL_BANDS / 2 + 1e-12,
      `age ${age}`,
    );
});

test('a late atlas cannot resurrect destroyed markers', async () => {
  let resolve;
  const engine = createFakeEngine();
  const display = createTransitDisplay(engine, {
    state: {},
    services: {},
    drawAtlas: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  display.attach();
  const [stationary] = display.createMarkers();
  stationary.add(spec('late'));
  await Promise.resolve();
  display.destroy();
  resolve(await transitTestAtlas());
  await settle();
  assert.deepEqual(engine.movers.list(), []);
});

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`markers are two over-the-scene sprite sets written once per frame (${name})`, async () => {
    const f = setup(makeHarness);
    await f.display.whenReady();
    const [stationary, moving] = [f.state._markers, f.state._animatedMarkers];
    stationary.show = moving.show = true;
    for (let i = 0; i < 50; i++) stationary.add(spec(`static-${i}`));
    const source = spec('moving');
    const marker = moving.add(source);
    await settle();
    f.frame();
    await settle();
    const sets = f.engine.movers.list();
    assert.deepEqual(
      sets.map(({ id, count }) => [id, count]),
      [
        ['transit-1', 50],
        ['transit-motion-1', 1],
      ],
    );
    source.position.x += 99;
    assert.notEqual(
      marker.position.x,
      source.position.x,
      'creation copies coordinates',
    );
    const glyph = f.sprite('transit-motion-1', 0);
    assert.equal(glyph.shown, true);
    assert.equal(glyph.id, 'moving', 'a pick returns the vehicle key');
    near(glyph.sizePx, 20, 'size');
    rgbaFromCss('#5EF08A')
      .rgba()
      .forEach((value, i) => near(glyph.color[i], value, `colour ${i}`));
    {
      const { options } = f.engine.fake.moverSet('transit-1');
      assert.equal(options.depthTest, 'always');
      assert.equal(options.pickable, true);
      assert.equal(options.sprite.sizePx, 20);
      assert.equal(options.order, SPRITE_LAYER_ORDER.indexOf('transit'));
      assert.equal(
        f.engine.fake.moverSet('transit-motion-1').options.order,
        SPRITE_LAYER_ORDER.indexOf('transit-motion'),
      );
      assert.equal(glyph.cell, transitIcon('bus'));
    }
    // A frame's writes are one commit of the set they touch.
    const before = [f.commits('transit-1'), f.commits('transit-motion-1')];
    let wrote = false;
    const remove = f.display.onPreRender(() => {
      if (wrote) return;
      wrote = true;
      marker.position = geo.cartesian3.fromDegrees(
        AUSTIN.lon,
        AUSTIN.lat + 0.001,
        5,
      );
      marker.rotation = 0.3;
      marker.width = 30;
      marker.color = rgbaFromCss('#FF4538');
    });
    f.frame();
    remove();
    const moved = f.sprite('transit-motion-1', 0);
    near(moved.rotation, 0.3, 'rotation');
    near(moved.sizePx, 30, 'the width sets the size');
    rgbaFromCss('#FF4538')
      .rgba()
      .forEach((value, i) => near(moved.color[i], value, `new colour ${i}`));
    if (before) {
      assert.equal(
        f.commits('transit-1'),
        before[0],
        'the fleet is not rewritten',
      );
      assert.equal(f.commits('transit-motion-1'), before[1] + 1);
      // Equal writes are idle.
      f.display.onPreRender(() => {
        marker.rotation = 0.3;
        marker.width = 30;
        marker.show = true;
        marker.color = marker.color.clone();
      });
      f.frame();
      assert.equal(f.commits('transit-motion-1'), before[1] + 1);
    }
    // Moving between sets keeps the vehicle's key.
    const migrated = stationary.add({
      ...spec('moving'),
      position: marker.position,
    });
    moving.remove(marker);
    await settle();
    assert.equal(migrated.id, 'moving');
    assert.equal(
      f.engine.movers.list().find(({ id }) => id === 'transit-motion-1').count,
      0,
    );
    stationary.show = false;
    await settle();
    assert.equal(
      f.engine.movers.list().find(({ id }) => id === 'transit-1').count,
      0,
    );
    f.display.destroy();
    f.display.destroy();
    assert.deepEqual(f.engine.movers.list(), []);
    f.engine.destroy();
  });

  test(`course rotation is the shared perspective projection (${name})`, () => {
    const f = setup(makeHarness);
    const position = geo.cartesian3.fromDegrees(-97.7401, 30.2682, 10);
    for (const height of [600, 20000, 1000000])
      for (const heading of [0, 1.2, 3.1]) {
        f.engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(
            AUSTIN.lon,
            AUSTIN.lat,
            height,
          ),
          orientation: { heading, pitch: -0.8, roll: 0 },
        });
        f.frame();
        for (const course of [0, 90, 180, 270]) {
          const rotation = f.display.rotation(position, course, 0);
          assert.ok(Number.isFinite(rotation));
        }
      }
    assert.equal(f.display.rotation(position, NaN, 0.4), 0.4);
    f.display.destroy();
    f.engine.destroy();
  });

  test(`the view test keeps a five-metre margin and the horizon (${name})`, () => {
    const f = setup(makeHarness);
    f.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 2000),
    });
    f.frame();
    const tester = f.display.visibilityTester();
    assert.equal(tester.hasFrustum, true);
    const below = tester.test(
      geo.cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 0),
    );
    assert.deepEqual(below, { horizon: true, inFrustum: true });
    const behind = tester.test(
      geo.cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 2100),
    );
    assert.equal(behind.inFrustum, false, 'above the camera');
    const far = tester.test(
      geo.cartesian3.fromDegrees(AUSTIN.lon + 90, AUSTIN.lat, 0),
    );
    assert.equal(far.horizon, false, 'over the horizon');
    // Just outside the side plane, inside the margin.
    const pose = f.engine.camera.pose();
    const { width, height } = f.engine.host.size();
    const tanX = Math.tan(pose.fovy / 2) * (pose.aspectRatio ?? width / height);
    const ground = geo.cartesian3.fromDegrees(AUSTIN.lon, AUSTIN.lat, 0);
    const depth = geo.cartesian3.distance(pose.position, ground);
    const edge = (offset) =>
      geo.cartesian3.add(
        ground,
        geo.cartesian3.multiplyByScalar(
          pose.right,
          depth * tanX + offset,
          geo.cartesian3.create(),
        ),
        geo.cartesian3.create(),
      );
    assert.equal(tester.test(edge(4)).inFrustum, true);
    assert.equal(tester.test(edge(12)).inFrustum, false);
    f.display.destroy();
    f.engine.destroy();
  });

  test(`clicks pick where they land and name the vehicle's set (${name})`, async () => {
    const vehicles = new Map();
    const f = setup(makeHarness, { vehicles });
    await f.display.whenReady();
    f.state._markers.show = f.state._animatedMarkers.show = true;
    const marker = f.state._animatedMarkers.add(spec('mbta:1'));
    vehicles.set('mbta:1', {
      marker,
      markerCollection: f.state._animatedMarkers,
    });
    await settle();
    const clicks = [];
    const binding = f.display.bindClick(
      (picked) => clicks.push(picked),
      () => true,
    );
    f.click(
      { x: 40, y: 50 },
      { id: 'mbta:1', owner: 'transit-motion-1', instance: 0 },
    );
    assert.deepEqual(clicks.at(-1), {
      id: 'mbta:1',
      primitiveId: null,
      x: 40,
      y: 50,
      collection: 'animated',
    });

    vehicles.get('mbta:1').markerCollection = f.state._markers;
    f.click(
      { x: 40, y: 50 },
      { id: 'mbta:1', owner: 'transit-motion-1', instance: 0 },
    );
    assert.equal(clicks.at(-1).collection, 'stationary');
    f.click({ x: 40, y: 50 }, undefined);
    assert.deepEqual(clicks.at(-1), {
      id: null,
      primitiveId: null,
      x: 40,
      y: 50,
      collection: null,
    });
    // A tool that owns the pointer takes the click.
    const owned = f.display.bindClick(
      (picked) => clicks.push(picked),
      () => false,
    );
    const count = clicks.length;
    owned.destroy();
    binding.destroy();
    f.click({ x: 40, y: 50 }, undefined);
    assert.equal(clicks.length, count, 'removed handlers hear nothing');
    f.display.destroy();
    f.engine.destroy();
  });

  test(`camera, surface, credits and teardown go through the engine (${name})`, () => {
    const f = setup(makeHarness);
    const listeners = {
      changed: f.engine.camera.changed.numberOfListeners,
      preRender: f.engine.frames.preRender.numberOfListeners,
      postRender: f.engine.frames.postRender.numberOfListeners,
    };
    f.display.claimCamera();
    assert.equal(f.engine.camera.percentageChanged, 0.05);
    assert.ok(cameraSensitivityClaims(f.engine).includes('transit'));
    const heard = [];
    f.display.onCameraChanged(() => heard.push('changed'));
    f.display.onPreRender(() => heard.push('pre'));
    f.display.onPostRender(() => heard.push('post'));
    f.frame();
    assert.deepEqual(heard, ['pre', 'post']);
    near(f.display.cameraCartographic().height, 2000, 'camera height', 1e-3);
    assert.ok(f.display.viewRectangle());
    assert.match(f.display.cameraSignature(), /^-?\d+:-?\d+:-?\d+:/);
    // The mesh sampler gets the engine and leaves the marker sets out.
    f.display.sampleMeshFloorCells([{ lat: 1, lon: 2 }], { viewerLat: 1 });
    assert.equal(f.mesh[0][0], f.engine);
    assert.deepEqual(f.mesh[0][2].excludeObjects, []);
    assert.equal(f.mesh[0][2].viewerLat, 1);
    f.display.addCredit({ id: 'mbta', name: 'MBTA' });
    assert.equal(f.credits[0][0], f.engine);
    assert.equal(f.credits[0][1].key, 'transit-mbta');
    const timestamps = { feedTimestamp: 123, fetchedAt: 456 };
    f.display.addCredit({ id: 'mbta', name: 'MBTA' }, timestamps);
    assert.deepEqual(f.credits[1][1].timestamps, timestamps);
    f.display.destroy();
    assert.equal(f.engine.camera.changed.numberOfListeners, listeners.changed);
    assert.equal(
      f.engine.frames.preRender.numberOfListeners,
      listeners.preRender,
    );
    assert.equal(
      f.engine.frames.postRender.numberOfListeners,
      listeners.postRender,
    );
    assert.equal(cameraSensitivityClaims(f.engine).includes('transit'), false);
    assert.equal(f.display.ready, false);
    f.engine.destroy();
  });

  test(`the selected trail draws its passed history in age bands and its head to the marker (${name})`, () => {
    const f = setup(makeHarness);
    const trail = f.display.createTrailRenderer();
    const positions = [0, 1, 2].map((i) =>
      geo.cartesian3.fromDegrees(-71, 42 + i * 0.001, 11.5),
    );
    trail.replaceHistory({
      revision: 1,
      segments: [
        {
          fromSeq: 0,
          toSeq: 1,
          fromT: 0,
          toT: 10000,
          positions: positions.slice(0, 2),
        },
        {
          fromSeq: 0,
          toSeq: 1,
          fromT: 10000,
          toT: 20000,
          positions: positions.slice(1, 3),
        },
      ],
    });
    assert.deepEqual(
      f.trailLines(),
      [],
      'nothing before the clock passes a segment',
    );
    const marker = geo.cartesian3.lerp(
      positions[1],
      positions[2],
      0.5,
      geo.cartesian3.create(),
    );
    const sample = { displayT: 15000, fromSeq: 0, toSeq: 1, fraction: 0.75 };
    for (let i = 0; i < 120; i++) trail.setDisplaySample(sample, marker);
    const lines = f.trailLines();
    // The first segment (two lanes) and one backed reveal head.
    assert.equal(lines.length, 3);
    const lanes = lines.map(({ id }) => ({ id, ...f.trailLine(id) }));
    assert.ok(lanes.every((lane) => lane.options.dynamic));

    const [bodyBacking, bodyLane, headLane] = lanes;
    assert.equal(bodyBacking.points, 2);
    assert.equal(bodyLane.points, 2);
    near(bodyBacking.color[0], 0.02, 'dark edge');
    near(bodyLane.color[0], rgbaFromCss('#5EF08A').rgba()[0], 'style colour');
    // Five seconds old: the newest band.
    near(
      bodyLane.color[3],
      trailBandAlpha(trailBand(trailAlpha(5000))),
      'age alpha',
    );
    near(headLane.color[3], 0.8, 'head alpha');
    assert.deepEqual(headLane.backing, {
      widthPx: 5,
      color: [0.02, 0.03, 0.05, 0.8],
    });
    assert.equal(headLane.fraction, 0.5);
    assert.equal(headLane.commits, 1, 'head geometry built once');
    assert.equal(headLane.options.pickable, undefined, 'picks pass through');
    {
      assert.equal(bodyBacking.widthPx, 5);
      assert.equal(bodyLane.widthPx, 3);
    }
    const result = trail.diagnostics();
    assert.equal(result.rebuilds, 1);
    assert.equal(
      result.headRebuilds,
      1,
      '120 frames at one marker write the head once',
    );
    assert.equal(result.head.width, 3);
    assert.equal(result.backing.width, 5);
    assert.equal(result.head.positions.length, 2);
    assert.ok(geo.cartesian3.equals(result.head.positions.at(-1), marker));
    assert.equal(result.ground, true);
    trail.setDisplaySample({ ...sample, displayT: 16000 }, marker);
    assert.equal(f.trailLine(headLane.id).commits, 1);
    assert.equal(f.trailLine(headLane.id).fraction, 0.6);
    // Rewind: the passed segment is future again.
    trail.setDisplaySample(
      { ...sample, displayT: 5000, fraction: 0.25 },
      positions[0],
    );
    assert.equal(f.trailLines().length, 1, 'only the head');
    // Past the end the head goes too; long after, both segments share the
    // oldest band.
    trail.setDisplaySample(
      { ...sample, displayT: 2_000_000, fraction: 1, fromSeq: 1, toSeq: 1 },
      positions[2],
    );
    const done = f.trailLines();
    assert.equal(
      done.filter((line) => line.shown).length,
      2,
      'the whole history, no head',
    );
    assert.equal(
      done.find((line) => line.shown).points,
      3,
      'joined segments are one line',
    );
    trail.setVisible(false);
    assert.ok(f.trailLines().every((line) => !line.shown));
    trail.setVisible(true);
    trail.destroy();
    trail.destroy();
    assert.deepEqual(f.trailLines(), []);
    f.display.destroy();
    f.engine.destroy();
  });

  test(`history bands age once per displayed second and restyle in place (${name})`, () => {
    const f = setup(makeHarness);
    const trail = f.display.createTrailRenderer();
    const step = 0.0002;
    const at = (i) => geo.cartesian3.fromDegrees(-71, 42 + i * step, 10);
    // 100 joined half-second segments, then a gap, then 10 more.
    const segments = [];
    for (let i = 0; i < 110; i++) {
      const from = i < 100 ? i : i + 5;
      segments.push({
        fromSeq: 0,
        toSeq: 1,
        fromT: i * 500,
        toT: (i + 1) * 500,
        positions: [at(from), at(from + 1)],
      });
    }
    trail.replaceHistory({ revision: 1, segments });
    const shownLines = () => f.trailLines().filter((line) => line.shown);
    // Ten minutes on, the passed history spans several bands; across the gap
    // it is two runs.
    const display = (displayT) =>
      trail.setDisplaySample(
        { displayT, fromSeq: 9, toSeq: 9, fraction: 1 },
        at(0),
      );
    display(55000 + 120000);
    const bands = new Set();
    let points = 0;
    for (const { id, points: count } of shownLines()) {
      const { color } = f.trailLine(id);
      if (color[0] > 0.1) {
        bands.add(color[3]);
        points += count;
      }
    }
    assert.ok(bands.size >= 1);
    assert.equal(points, 101 + 11 + (bands.size - 1) * 1, 'each band one span');
    const listed = f.trailLines().map(({ id }) => id);
    // Within the same second nothing is rewritten.
    display(55000 + 120400);
    assert.deepEqual(
      f.trailLines().map(({ id }) => id),
      listed,
    );
    // A new style recolours the colour lanes, not the dark edges.
    trail.setStyle('#FF4538');
    const red = rgbaFromCss('#FF4538').rgba();
    for (const { id } of shownLines()) {
      const { color } = f.trailLine(id);
      if (color[0] > 0.1) near(color[0], red[0], 'restyled');
      else near(color[0], 0.02, 'dark edge kept');
    }
    // Old history reaches the floor band and merges per run.
    display(55000 + 2_000_000);
    const old = shownLines();
    assert.equal(old.length, 4, 'two runs, two lanes each');
    for (const { id } of old)
      near(f.trailLine(id).color[3], 0.08, 'oldest alpha');
    trail.destroy();
    f.display.destroy();
    f.engine.destroy();
  });
}

test('sensor styles drawn by the engine move a click to the pixel the shader showed', () => {
  const engine = createFakeEngine({
    width: 1920,
    height: 1080,
    canvas: { width: 1920, height: 1080 },
    visualStyles: { surveillance: ['pixelation'], thermal: ['pixelation'] },
  });
  const state = { _stylePreset: 'surveillance', _vehicles: new Map() };
  const display = createTransitDisplay(engine, {
    state,
    services: {},
    drawAtlas: transitTestAtlas,
  });
  display.attach();
  const seen = [];
  display.bindClick(
    ({ x, y }) => seen.push([x, y]),
    () => true,
  );
  const click = (x, y) => engine.fake.input('click', { position: { x, y } });
  click(1440, 540);
  assert.deepEqual(
    seen.at(-1),
    [1440, 540],
    'a style at intensity 0 bends nothing',
  );
  engine.render.setStyle('surveillance', {
    intensity: 1,
    uniforms: { pixelation: 1 },
  });
  click(1440, 540);
  near(seen.at(-1)[0], 1472, 'barrel distortion');
  near(seen.at(-1)[1], 540, 'on the axis');
  state._stylePreset = 'thermal';
  engine.render.setStyle('thermal', {
    intensity: 1,
    uniforms: { pixelation: 1.5 },
  });
  click(100.9, 200.1);
  near(seen.at(-1)[0], 100.5, 'pixel grid x');
  near(seen.at(-1)[1], 201, 'pixel grid y');
  state._stylePreset = 'noir';
  click(100.9, 200.1);
  assert.deepEqual(
    seen.at(-1),
    [100.9, 200.1],
    'other styles do not bend clicks',
  );
  display.destroy();
  engine.destroy();
});

test('terrain answers the floor unless photoreal tiles hide the globe', async () => {
  const engine = createFakeEngine();
  const display = createTransitDisplay(engine, {
    state: {},
    services: {},
    drawAtlas: transitTestAtlas,
  });
  engine.fake.script('terrainHeight', (cartographic) => {
    near(geo.math.toDegrees(cartographic.latitude), AUSTIN.lat, 'latitude');
    return 151;
  });
  assert.equal(display.terrainHeight(AUSTIN.lat, AUSTIN.lon), 151);
  await engine.maps.setPhotorealTiles({ kind: 'photoreal' });
  assert.equal(display.terrainHeight(AUSTIN.lat, AUSTIN.lon), undefined);
  display.destroy();
  engine.destroy();
});
