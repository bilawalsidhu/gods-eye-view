import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../../geo/index.js';
import {
  aboveHorizon,
  createStreetLevelDisplay,
  lineColor,
  screenRotation,
  SEQUENCE_LINE_BATCH,
} from './display.js';
import {
  STREET_LEVEL_MAPS,
  streetLevelMap,
} from '../../../testSupport/streetLevelFakes.mjs';

const line = (n) => [
  [-121.49, 38.58 + n * 1e-5],
  [-121.48, 38.58 + n * 1e-5],
];
const STYLE = Object.freeze({
  id: 'test-coverage:14/1/2',
  color: '#00ff00',
  alpha: 0.92,
  widthPx: 2.5,
  pickPrefix: 'mly:seq:',
  order: 0,
});

test('the display needs a globe engine', () => {
  assert.throws(() => createStreetLevelDisplay(null), /globe engine/);
  assert.throws(() => createStreetLevelDisplay({}), /globe engine/);
});

test('a line colour is the CSS colour, its alpha replaced when asked', () => {
  assert.deepEqual(lineColor('#00d4ff'), [0, 0xd4 / 255, 1, 1]);
  assert.deepEqual(lineColor('#05cb63', 0.92), [
    0x05 / 255,
    0xcb / 255,
    0x63 / 255,
    0.92,
  ]);
});

for (const create of STREET_LEVEL_MAPS) {
  const name = create().name;

  test(`sequence lines are pickable pixel corridors draped on terrain and tiles (${name})`, () => {
    const harness = create();
    const lines = harness.map.sequenceLines(
      [
        { id: 'a', parts: [line(0), line(1)] },
        { id: 'b', parts: [line(2)] },
      ],
      STYLE,
    );
    const [set] = harness.groundSets(STYLE.id);
    assert.deepEqual(lines.ids(), [set.id]);
    assert.deepEqual(set.options, {
      id: set.id,
      kind: 'corridor',
      order: 0,
      pickable: true,
      drape: 'both',
    });
    // Every part of a sequence picks it.
    assert.deepEqual(set.items, [
      {
        positions: line(0),
        color: [0, 1, 0, 0.92],
        widthPx: 2.5,
        pickId: 'mly:seq:a',
      },
      {
        positions: line(1),
        color: [0, 1, 0, 0.92],
        widthPx: 2.5,
        pickId: 'mly:seq:a',
      },
      {
        positions: line(2),
        color: [0, 1, 0, 0.92],
        widthPx: 2.5,
        pickId: 'mly:seq:b',
      },
    ]);
    assert.equal(
      harness.engine.ground.list().find((entry) => entry.id === set.id).count,
      3,
      'committed to the engine',
    );
    lines.destroy();
    lines.destroy();
    assert.equal(harness.engine.ground.list().length, 0, 'gone, once');
  });

  test(`a dense tile is drawn in sets of ${SEQUENCE_LINE_BATCH} lines (${name})`, () => {
    const harness = create();
    const sequences = Array.from({ length: 250 }, (_, i) => ({
      id: `s${i}`,
      parts: [line(i)],
    }));
    const lines = harness.map.sequenceLines(sequences, STYLE);
    const sets = harness.groundSets(STYLE.id);
    assert.deepEqual(
      sets.map((set) => set.items.length),
      [SEQUENCE_LINE_BATCH, SEQUENCE_LINE_BATCH, 10],
    );
    assert.deepEqual(
      lines.ids(),
      sets.map((set) => set.id),
    );
    assert.equal(lines.count(), 250);
    harness.map.destroy();
    assert.equal(harness.engine.ground.list().length, 0);
  });
}

test('a part with a bad point is skipped; nothing drawable draws nothing', () => {
  const harness = streetLevelMap();
  const lines = harness.map.sequenceLines(
    [
      {
        id: 'a',
        parts: [
          line(0),
          [[-121.49, 38.58]],
          [
            [-121.49, Number.NaN],
            [-121.48, 38.58],
          ],
          [
            [-121.49, 95],
            [-121.48, 38.58],
          ],
          null,
        ],
      },
      { id: 'b', parts: [] },
      { id: 'c' },
    ],
    STYLE,
  );
  assert.deepEqual(
    harness.corridors(STYLE.id).map((item) => item.pickId),
    ['mly:seq:a'],
  );
  lines.destroy();
  assert.equal(
    harness.map.sequenceLines([{ id: 'b', parts: [] }], STYLE),
    null,
  );
  assert.equal(harness.engine.ground.list().length, 0);
});

/** One sprite of a group on `harness`'s display, and its drawn instance. */
function oneSprite(harness, spec = {}) {
  const group = harness.map.sprites('test-sprites', { order: -1 });
  const row = group.add({
    pickId: 'p:1',
    lon: -121.4944,
    lat: 38.5816,
    bearing: 0,
    image: 'data:image/svg+xml;utf8,<svg/>',
    imageKey: 'glyph',
    sizePx: 26,
    ...spec,
  });
  const drawn = () => {
    harness.frame();
    return harness.spritesShown('test-sprites')[0];
  };
  return { group, row, drawn };
}

const heightOf = (position) => geo.cartographic.fromCartesian(position).height;

test('a sprite sits on the terrain; under Google 3D on the tiles, placed again when they settle', async () => {
  const harness = streetLevelMap({ view: true });
  const { fake } = harness.engine;
  fake.script('terrainHeight', () => 12);
  const globe = oneSprite(harness);
  assert.ok(Math.abs(heightOf(globe.drawn().position) - 12) < 1e-6);
  globe.group.destroy();

  await harness.engine.maps.setPhotorealTiles({ kind: 'photoreal' });
  let tiles;
  const excluded = [];
  fake.script('sampleHeight', (_position, exclude) => {
    excluded.push(exclude);
    return tiles;
  });
  fake.script('tilesLoaded', false);
  const google = oneSprite(harness);
  // Not loaded yet: the terrain until the tiles answer.
  assert.ok(Math.abs(heightOf(google.drawn().position) - 12) < 1e-6);
  tiles = 31;
  harness.frame();
  assert.ok(
    Math.abs(heightOf(google.drawn().position) - 12) < 1e-6,
    'not placed again before the surface settles',
  );
  fake.script('tilesLoaded', true);
  assert.ok(Math.abs(heightOf(google.drawn().position) - 31) < 1e-6);
  assert.ok(
    excluded.every((list) => Array.isArray(list)),
    'its own sprites are left out of the sample',
  );
  // On the tiles now: a later settle samples nothing again.
  const samples = excluded.length;
  fake.script('tilesLoaded', false);
  harness.frame();
  fake.script('tilesLoaded', true);
  harness.frame();
  assert.equal(excluded.length, samples);
  // An implausible sample (tiles still streaming) is not ground.
  tiles = -14_886;
  google.group.move(google.row, { lon: -121.4945 });
  assert.ok(Math.abs(heightOf(google.drawn().position) - 12) < 1e-6);
});

test('a sprite without any ground sits on the ellipsoid', () => {
  const harness = streetLevelMap({ view: true });
  harness.engine.fake.script('terrainHeight', () => undefined);
  assert.ok(Math.abs(heightOf(oneSprite(harness).drawn().position)) < 1e-6);
});

test('a group shows and hides, removes and moves its sprites, and goes for good', () => {
  const harness = streetLevelMap({ view: true });
  const { group, row, drawn } = oneSprite(harness);
  assert.equal(drawn().pickId, 'p:1');
  group.show(false);
  assert.equal(group.shown(), false);
  assert.equal(drawn(), undefined);
  assert.equal(
    harness.moverSets('test-sprites').length,
    1,
    'its set kept, with its atlas',
  );
  group.show(true);
  assert.ok(drawn());
  group.move(row, { bearing: 90 });
  assert.ok(Math.abs(drawn().rotation + Math.PI / 2) < 1e-6);
  group.remove(row);
  assert.equal(drawn(), undefined);
  assert.equal(group.count(), 0);
  // A removed row does not come back with a move.
  group.move(row, { lon: 0 });
  assert.equal(group.count(), 0);
  group.add({ ...row });
  group.removeAll();
  assert.equal(drawn(), undefined);
  group.destroy();
  assert.equal(harness.moverSets('test-sprites').length, 0);
  // Destroyed: nothing paints again.
  group.add({ ...row });
  harness.frame();
  assert.equal(harness.moverSets('test-sprites').length, 0);
});

test('a group grows its sprite set as rows arrive, one set per glyph', () => {
  const harness = streetLevelMap({ view: true });
  const group = harness.map.sprites('test-sprites');
  const add = (n, imageKey) =>
    group.add({
      pickId: `p:${imageKey}:${n}`,
      lon: -121.4944 + n * 1e-5,
      lat: 38.5816,
      bearing: 0,
      image: 'data:,',
      imageKey,
      sizePx: 26,
    });
  add(0, 'flat');
  harness.frame();
  for (let n = 1; n < 5; n++) add(n, 'flat');
  add(0, 'pano');
  harness.frame();
  const sets = harness.moverSets('test-sprites');
  assert.deepEqual(
    sets.map((set) => [set.id, set.options.capacity, set.instances.length]),
    [
      ['test-sprites:flat', 5, 5],
      ['test-sprites:pano', 1, 1],
    ],
  );
  assert.equal(sets[0].options.order, 0, 'order 0 unless asked');
  assert.equal(sets[0].options.sprite.scaleByDistance, undefined);
});

test('a sprite turns with the camera, keeping its compass bearing on screen', () => {
  const harness = streetLevelMap({ view: true });
  const { drawn } = oneSprite(harness, { bearing: 0 });
  assert.ok(Math.abs(drawn().rotation) < 1e-6, 'north is up');
  // The camera turned to face east: north is now to the left.
  harness.engine.fake.setPose({
    position: harness.engine.camera.pose().position,
    heading: Math.PI / 2,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  assert.ok(Math.abs(drawn().rotation - Math.PI / 2) < 1e-6);
});

test('a bearing straight into the screen keeps the last rotation', () => {
  const position = geo.cartesian3.fromDegrees(0, 0);
  // Looking north along the ground: the local north is the view direction.
  const pose = {
    right: geo.cartesian3.create(0, 1, 0),
    up: geo.cartesian3.create(1, 0, 0),
  };
  assert.equal(screenRotation(position, 0, pose, 0.7), 0.7);
  assert.ok(
    Math.abs(screenRotation(position, 90, pose, 0.7) + Math.PI / 2) < 1e-9,
  );
});

const at = (lon, lat, height) => geo.cartesian3.fromDegrees(lon, lat, height);

test('cones and the marker stay visible on ground below the WGS84 ellipsoid', () => {
  // NYC at street level: eye 2.4 m above ground at -22 m, a cone 10 m away.
  assert.equal(
    aboveHorizon(at(-74.006, 40.7128, -19.6), at(-74.006, 40.71289, -22)),
    true,
  );
  // Colombo framing view: camera at -21 m, cones at -95 m about 80 m away.
  const colombo = at(79.8612, 6.9271, -21);
  assert.equal(aboveHorizon(colombo, at(79.8612, 6.92782, -95)), true);
  assert.equal(aboveHorizon(colombo, at(79.86192, 6.9271, -95)), true);
  // Austin, ground well above the ellipsoid.
  assert.equal(
    aboveHorizon(at(-97.7431, 30.2672, 132), at(-97.7431, 30.2681, 130)),
    true,
  );
});

test('the horizon cull still hides the far side of the Earth from orbit', () => {
  const orbit = at(0, 0, 20_000_000);
  assert.equal(aboveHorizon(orbit, at(10, 10, 0)), true);
  assert.equal(aboveHorizon(orbit, at(180, 0, 0)), false);
});

test('destroying the display takes everything it still draws', () => {
  const harness = streetLevelMap({ view: true });
  harness.map.sequenceLines([{ id: 'a', parts: [line(0)] }], STYLE);
  const { drawn } = oneSprite(harness);
  assert.ok(drawn());
  harness.map.destroy();
  assert.equal(harness.engine.ground.list().length, 0);
  assert.equal(harness.engine.movers.list().length, 0);
  harness.map.destroy();
});
