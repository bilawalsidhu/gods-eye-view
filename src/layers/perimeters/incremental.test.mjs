import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFirePerimetersLayer,
  PERIMETER_AGE_BANDS,
  PERIMETER_SET_SIZES,
} from './index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';

const HOUR = 3600000;
const AT = Date.UTC(2026, 7, 20, 12);

/** A small square ring at `lon, lat`, `size` degrees across. */
const square = (lon, lat, size = 0.01) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
  [lon, lat],
];
const fireAt = (id, lon, lat) => ({
  id,
  name: id,
  containedPct: 0,
  lastGrowthTime: null,
  anchor: { lon, lat },
});
/** A piece of `count` squares beside each other, each outlined. */
const piece = (fireId, id, born, { lon = -120, lat = 38, count = 1 } = {}) => {
  const polygons = [];
  for (let i = 0; i < count; i++) polygons.push([square(lon + i * 0.02, lat)]);
  return {
    ...(id === null ? {} : { id }),
    fireId,
    born,
    polygons,
    outline: polygons.map((rings) => rings[0]),
  };
};
const snapshot = (fires, pieces, { at = AT, revision } = {}) => ({
  at,
  fetchedAt: at,
  stale: false,
  revision: revision ?? pieces.map((p) => p.id ?? '').join('|'),
  note: null,
  fires,
  pieces,
});

/**
 * The layer drawn on the stub renderer, every write to its draw sets
 * logged as `{set, call, ids}` (`set` the set's id, `call` set, upsert or
 * remove, `ids` the item ids).
 */
function harness(read, extra = {}) {
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  const writes = [];
  const sets = new Map();
  const draw = renderer.draw;
  for (const kind of ['shapes', 'lines']) {
    const make = draw[kind].bind(draw);
    draw[kind] = (spec) => {
      const set = make(spec);
      sets.set(spec.id, set);
      for (const call of ['set', 'upsert', 'remove']) {
        const write = set[call].bind(set);
        set[call] = (items) => {
          writes.push({
            set: spec.id,
            call,
            ids: items.map((item) => (call === 'remove' ? item : item.id)),
          });
          return write(items);
        };
      }
      return set;
    };
  }
  const layer = createFirePerimetersLayer({
    source: { getSnapshot: async () => read() },
    ...extra,
  });
  layer.init(viewer);
  layer.enable(viewer);
  /** The items drawn now in the layer's sets of `kind`, by id. */
  const items = (kind) => {
    const out = new Map();
    for (const id of renderer.testing.sets()) {
      if (!id.startsWith('fire-perimeters:') || !id.endsWith(`:${kind}`))
        continue;
      for (const [itemId, item] of renderer.testing.setRecord(id).items)
        out.set(itemId, { ...item, set: id });
    }
    return out;
  };
  return { renderer, viewer, layer, writes, items, sets };
}

const fillOf = (band) => hexColor(PERIMETER_AGE_BANDS[band].color, 0.35);
const lineOf = (band) => hexColor(PERIMETER_AGE_BANDS[band].color, 0.9);

test('a read with nothing changed writes nothing', async () => {
  const fires = [fireAt('a', -120, 38)];
  let at = AT;
  const pieces = [
    piece('a', 'p1', AT - HOUR),
    piece('a', 'p2', AT - 30 * HOUR),
  ];
  const h = harness(() => snapshot(fires, pieces, { at }));
  await h.layer.update();
  assert.ok(h.writes.length > 0, 'the first read draws');
  h.writes.length = 0;
  await h.layer.update();
  // An hour on, every piece still in its band.
  at += HOUR;
  await h.layer.update();
  // A source that gives no revision, the same pieces.
  const unrevised = () => ({
    ...snapshot(fires, pieces, { at }),
    revision: undefined,
  });
  const again = harness(unrevised);
  await again.layer.update();
  again.writes.length = 0;
  await again.layer.update();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(again.writes, [], 'compared piece by piece');
  h.layer.destroy();
  again.layer.destroy();
});

test('a piece that changes band is recoloured in its own two sets, and nothing else is written', async () => {
  const fires = [fireAt('a', -120, 38), fireAt('b', -119, 39)];
  let at = AT;
  const pieces = [
    piece('a', 'young', AT - 5 * HOUR, { count: 2 }),
    piece('a', 'old', AT - 40 * HOUR),
    piece('b', 'other', AT - 2 * HOUR, { lon: -119, lat: 39 }),
  ];
  const h = harness(() => snapshot(fires, pieces, { at }));
  await h.layer.update();
  const before = h.items('fills');
  h.writes.length = 0;
  // Two hours on, `young` is 7 h old: band 1; the rest keep theirs.
  at += 2 * HOUR;
  await h.layer.update();
  const young = [...before.values()].filter(({ id }) =>
    id.startsWith('fire-perimeter:a:young:'),
  );
  assert.equal(young.length, 2);
  assert.deepEqual(
    h.writes.map(({ set, call, ids }) => [set.split(':').at(-1), call, ids]),
    [
      [
        'fills',
        'upsert',
        ['fire-perimeter:a:young:0', 'fire-perimeter:a:young:1'],
      ],
      [
        'lines',
        'upsert',
        ['fire-perimeter:a:young:line:0', 'fire-perimeter:a:young:line:1'],
      ],
    ],
  );
  assert.equal(new Set(h.writes.map(({ set }) => set)).size, 2);
  const fills = h.items('fills');
  const lines = h.items('lines');
  assert.deepEqual(fills.get('fire-perimeter:a:young:0').fill, fillOf(1));
  assert.deepEqual(
    lines.get('fire-perimeter:a:young:line:1').style.color,
    lineOf(1),
  );
  assert.deepEqual(fills.get('fire-perimeter:a:old:0').fill, fillOf(2));
  assert.deepEqual(fills.get('fire-perimeter:b:other:0').fill, fillOf(0));
  // Recoloured where it is: the same set, the same geometry.
  const was = before.get('fire-perimeter:a:young:0');
  const now = fills.get('fire-perimeter:a:young:0');
  assert.equal(now.set, was.set);
  assert.deepEqual(now.geometry, was.geometry);
  h.layer.destroy();
});

test('a new piece is only upserted, and a piece gone only removed', async () => {
  const fires = [fireAt('a', -120, 38)];
  let pieces = [piece('a', 'p1', AT - HOUR)];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  h.writes.length = 0;
  pieces = [...pieces, piece('a', 'p 2/b', AT, { lon: -120.5 })];
  await h.layer.update();
  assert.deepEqual(
    h.writes.map(({ call, ids }) => [call, ids]),
    [
      ['upsert', ['fire-perimeter:a:p%202%2Fb:0']],
      ['upsert', ['fire-perimeter:a:p%202%2Fb:line:0']],
    ],
  );
  h.writes.length = 0;
  pieces = pieces.slice(1);
  await h.layer.update();
  assert.deepEqual(
    h.writes.map(({ call, ids }) => [call, ids]),
    [
      ['remove', ['fire-perimeter:a:p1:0']],
      ['remove', ['fire-perimeter:a:p1:line:0']],
    ],
  );
  assert.deepEqual(
    [...h.items('fills').keys()],
    ['fire-perimeter:a:p%202%2Fb:0'],
  );
  // A set left with nothing is let go, not written.
  h.writes.length = 0;
  pieces = [];
  await h.layer.update();
  assert.deepEqual(h.writes, []);
  assert.equal(h.items('fills').size, 0);
  assert.equal(h.items('lines').size, 0);
  h.layer.destroy();
});

test('a set that loses and gains pieces in one read is written once, whole', async () => {
  const fires = [fireAt('a', -120, 38)];
  let pieces = [piece('a', 'p1', AT - HOUR), piece('a', 'p2', AT - HOUR)];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  h.writes.length = 0;
  pieces = [pieces[1], piece('a', 'p3', AT)];
  await h.layer.update();
  assert.deepEqual(
    h.writes.map(({ call, ids }) => [call, ids]),
    [
      ['set', ['fire-perimeter:a:p2:0', 'fire-perimeter:a:p3:0']],
      ['set', ['fire-perimeter:a:p2:line:0', 'fire-perimeter:a:p3:line:0']],
    ],
  );
  h.layer.destroy();
});

test('new pieces start a new set once the newest is full, drawn over the older', async () => {
  const fires = [fireAt('a', -120, 38)];
  const per = PERIMETER_SET_SIZES.lines;
  let pieces = [piece('a', 'p1', AT - HOUR, { count: per })];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  pieces = [...pieces, piece('a', 'p2', AT, { lon: -110 })];
  h.writes.length = 0;
  await h.layer.update();
  const lineSets = h.renderer.testing
    .sets()
    .filter((id) => id.endsWith(':lines'));
  assert.equal(lineSets.length, 2, 'the full set is left as it is');
  assert.deepEqual(
    h.writes.filter(({ set }) => set.endsWith(':lines')),
    [{ set: lineSets[1], call: 'upsert', ids: ['fire-perimeter:a:p2:line:0'] }],
  );
  // Its fills, under their own budget, still go in the one set.
  assert.equal(
    h.renderer.testing.sets().filter((id) => id.endsWith(':fills')).length,
    1,
  );
  h.layer.destroy();
});

test('every line set is drawn over every fill set, made again after a new one', async () => {
  const fires = [fireAt('a', -120, 38)];
  const full = PERIMETER_SET_SIZES.fills;
  let pieces = [piece('a', 'p1', AT - HOUR, { count: full })];
  const h = harness(() => snapshot(fires, pieces));
  const ours = () =>
    h.renderer.testing.sets().filter((id) => id.startsWith('fire-perimeters'));
  const kinds = () => ours().map((id) => id.split(':').at(-1));
  await h.layer.update();
  assert.deepEqual(kinds(), ['fills', 'lines']);
  const [, firstLines] = ours();
  h.writes.length = 0;
  pieces = [...pieces, piece('a', 'p2', AT, { lon: -110 })];
  await h.layer.update();
  assert.deepEqual(kinds(), ['fills', 'fills', 'lines', 'lines']);
  const [, newFills, relaid, newLines] = ours();
  assert.equal(ours().includes(firstLines), false, 'made again');
  assert.deepEqual(
    h.writes.map(({ set, call, ids }) => [set, call, ids.length]),
    [
      [relaid, 'set', full],
      [newFills, 'upsert', 1],
      [newLines, 'upsert', 1],
    ],
  );
  // Its lines still pick as their fire.
  assert.equal(h.items('lines').get('fire-perimeter:a:p1:line:0').set, relaid);
  h.layer.destroy();
});

test('a snapshot without piece ids is drawn whole every time it changes', async () => {
  const fires = [fireAt('a', -120, 38)];
  let at = AT;
  let revision = 'r1';
  const pieces = [piece('a', null, AT - 5 * HOUR), piece('a', null, AT - HOUR)];
  const h = harness(() => snapshot(fires, pieces, { at, revision }));
  await h.layer.update();
  const whole = [
    ['set', ['fire-perimeter:a:0', 'fire-perimeter:a:1']],
    ['set', ['fire-perimeter:a:line:0', 'fire-perimeter:a:line:1']],
  ];
  const calls = () => h.writes.map(({ call, ids }) => [call, ids]);
  assert.deepEqual(calls(), whole);
  h.writes.length = 0;
  await h.layer.update();
  assert.deepEqual(calls(), [], 'the same revision and bands');
  at += 2 * HOUR;
  await h.layer.update();
  assert.deepEqual(calls(), whole, 'a band changed: all drawn again');
  h.writes.length = 0;
  revision = 'r2';
  await h.layer.update();
  assert.deepEqual(calls(), whole);
  // One piece without an id is enough to draw them all.
  h.writes.length = 0;
  pieces[0] = { ...pieces[0], id: 'given' };
  revision = 'r3';
  await h.layer.update();
  assert.deepEqual(calls(), whole);
  h.layer.destroy();
});

test('pieces with ids after pieces without start over in new sets, and back', async () => {
  const fires = [fireAt('a', -120, 38)];
  let pieces = [piece('a', null, AT)];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  const first = h.renderer.testing.sets().filter((id) => id.startsWith('fire'));
  pieces = [piece('a', 'p1', AT)];
  await h.layer.update();
  const second = h.renderer.testing
    .sets()
    .filter((id) => id.startsWith('fire'));
  assert.equal(
    first.some((id) => second.includes(id)),
    false,
  );
  assert.deepEqual([...h.items('fills').keys()], ['fire-perimeter:a:p1:0']);
  pieces = [piece('a', null, AT)];
  await h.layer.update();
  assert.deepEqual([...h.items('fills').keys()], ['fire-perimeter:a:0']);
  h.layer.disable();
  for (const id of h.renderer.testing.sets())
    if (id.startsWith('fire')) assert.equal(h.sets.get(id).show, false);
  h.layer.destroy();
  assert.deepEqual(
    h.renderer.testing.sets().filter((id) => id.startsWith('fire')),
    [],
  );
});

test('a click on a piece drawn by id selects its own fire, through the stub pick', async () => {
  const fires = [fireAt('a', -120, 38), fireAt('b', -119.9, 38)];
  let at = AT;
  let pieces = [
    piece('a', 'pa', AT - HOUR, { lon: -120 }),
    piece('b', 'pb', AT - HOUR, { lon: -119.9 }),
  ];
  let onClick = null;
  const entries = [];
  const h = harness(() => snapshot(fires, pieces, { at }), {
    overlayHost: {
      setEntries: (sourceId, list) => entries.push(...list),
      setVisible() {},
      clearSource() {},
    },
    inputFor: () => ({
      onClick(handler) {
        onClick = handler;
        return () => {};
      },
    }),
    picking: {
      clickCard: () => null,
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
  });
  await h.layer.update();
  // A band change and a new piece since: the picks still find their fire.
  at += 2 * HOUR;
  pieces = [...pieces, piece('b', 'pb2', at, { lon: -119.95 })];
  await h.layer.update();
  h.renderer.camera.setView({
    destination: { lon: -119.9, lat: 38.005, height: 20000 },
  });
  for (const [lon, fireId] of [
    [-119.9, 'b'],
    [-120, 'a'],
    [-119.95, 'b'],
  ]) {
    const point = h.renderer.query.project(fromDegrees(lon, 38.005));
    assert.ok(point, 'the fire line is in view');
    const hit = h.renderer.query.pick(point.x, point.y, {
      width: 9,
      height: 9,
    });
    assert.ok(hit && !hit.surface, `a hit at ${lon}`);
    entries.length = 0;
    onClick({ topHit: hit, drawHit: hit });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, `fire-perimeter-card:${fireId}`);
  }
  h.layer.destroy();
});
