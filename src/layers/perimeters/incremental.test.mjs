import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees } from '../../geo/ellipsoid.js';
import {
  AT,
  HOUR,
  fireAt,
  piece,
  snapshot,
  harness,
  FILL,
  EDGE,
  LINE_MIN_VERTICES,
  SQUARE_VERTICES,
} from '../../testSupport/perimeterLayerHarness.mjs';

test('a read with nothing changed writes nothing', async () => {
  const fires = [fireAt('a', -120, 38)];
  let at = AT;
  const pieces = [
    piece('a', 'p1', AT - HOUR),
    piece('a', 'p2', AT - 30 * HOUR, { lon: -120.5 }),
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

test('every fire draws in one fill and one edge, whatever its age; time passing redraws nothing', async () => {
  const fires = [fireAt('a', -120, 38), fireAt('b', -119, 39)];
  let at = AT;
  const pieces = [
    piece('a', 'old', AT - 100 * HOUR, { lon: -121 }),
    piece('a', 'young', AT - HOUR, { count: 2 }),
    piece('b', 'unknown', null, { lon: -119, lat: 39 }),
  ];
  const h = harness(() => snapshot(fires, pieces, { at }));
  await h.layer.update();
  const ours = (kind) =>
    h.renderer.testing
      .sets()
      .filter((id) => id.startsWith('fire-perimeters:') && id.endsWith(kind));
  // Small fires: one set of each kind.
  assert.equal(ours(':fills').length, 1);
  assert.equal(ours(':halos').length, 1);
  assert.equal(ours(':lines').length, 1);
  for (const item of h.items('fills').values())
    assert.deepEqual(item.fill, FILL);
  for (const item of h.items('lines').values()) {
    assert.deepEqual(item.style, EDGE.style);
    assert.equal(item.widthPx, EDGE.widthPx);
  }
  h.writes.length = 0;
  at += 100 * HOUR;
  await h.layer.update();
  assert.deepEqual(h.writes, []);
  h.layer.destroy();
});

test("one fire's change writes only its own items, and its own edge sets", async () => {
  const fires = [fireAt('a', -120, 38), fireAt('b', -119, 39)];
  const at = AT;
  // Each fire's edge more than half a group's room: a group each.
  const count = Math.ceil(LINE_MIN_VERTICES / 2 / SQUARE_VERTICES) + 1;
  let pieces = [
    piece('a', 'a1', AT - 30 * HOUR, { count }),
    piece('b', 'b1', AT - 30 * HOUR, { lon: -119, lat: 39, count }),
    piece('b', 'b2', AT - 5 * HOUR, { lon: -118.9, lat: 39.1 }),
  ];
  const h = harness(() => snapshot(fires, pieces, { at }));
  await h.layer.update();
  const edgeSetsOf = (fire) =>
    new Set(
      [...h.items('halos').values(), ...h.items('lines').values()]
        .filter(({ id }) => id.startsWith(`fire-perimeter:${fire}:`))
        .map(({ set }) => set),
    );
  const ofA = edgeSetsOf('a');
  const ofB = edgeSetsOf('b');
  assert.equal(ofA.size, 2, 'a halo set and a line set');
  assert.equal(ofB.size, 2);
  assert.equal(
    [...ofA].some((set) => ofB.has(set)),
    false,
  );
  const fills = new Set([...h.items('fills').values()].map(({ set }) => set));
  /** Every write is to `fire`'s edge sets, or of its own fills only. */
  const onlyOf = (fire, ofFire) => {
    assert.ok(h.writes.length > 0);
    for (const { set, call, ids } of h.writes)
      if (fills.has(set)) {
        assert.notEqual(call, 'set', 'no fill set written whole');
        for (const id of ids)
          assert.ok(id.startsWith(`fire-perimeter:${fire}:`), id);
      } else assert.ok(ofFire.has(set), set);
  };
  // `b` grows and loses a piece; `a` stays.
  for (const step of [
    () =>
      (pieces = [...pieces, piece('b', 'b3', at, { lon: -118.8, lat: 39.2 })]),
    () => (pieces = pieces.filter(({ id }) => id !== 'b1')),
  ]) {
    h.writes.length = 0;
    step();
    await h.layer.update();
    onlyOf('b', ofB);
  }
  // And `a` growing writes `a` alone.
  h.writes.length = 0;
  pieces.push(piece('a', 'a2', at, { lon: -120.1, lat: 38.2 }));
  await h.layer.update();
  onlyOf('a', ofA);
  h.layer.destroy();
});

test("a fire's edge leaves out a line newer growth was cut along", async () => {
  const fires = [fireAt('a', -120, 38)];
  const square = (lon) => [
    [lon, 38],
    [lon + 0.01, 38],
    [lon + 0.01, 38.01],
    [lon, 38.01],
    [lon, 38],
  ];
  const old = {
    id: 'old',
    fireId: 'a',
    born: AT - 50 * HOUR,
    polygons: [[square(-120)]],
    outline: [square(-120)],
  };
  // Growth east of it, cut from the area around it: its ring runs along
  // the old east side; its line is the new edge only.
  const grown = square(-119.99);
  const growth = {
    id: 'growth',
    fireId: 'a',
    born: AT - HOUR,
    polygons: [[grown]],
    outline: [grown.slice(0, 4)],
  };
  const h = harness(() => snapshot(fires, [old, growth]));
  await h.layer.update();
  const runs = [...h.items('lines').values()].map(({ id, positions }) => [
    id,
    positions.length,
  ]);
  // The old square's east side runs inside the fire now: its line is cut
  // there, leaving its south side, and its north and west sides.
  assert.deepEqual(runs, [
    ['fire-perimeter:a:old:line:0', 2],
    ['fire-perimeter:a:old:line:1', 3],
    ['fire-perimeter:a:growth:line:0', 4],
  ]);
  assert.deepEqual(
    [...h.items('halos').keys()],
    [
      'fire-perimeter:a:old:halo:0',
      'fire-perimeter:a:old:halo:1',
      'fire-perimeter:a:growth:halo:0',
    ],
  );
  h.layer.destroy();
});

test('a new fill is only upserted, a fill gone only removed; the edge is drawn again', async () => {
  const fires = [fireAt('a', -120, 38)];
  let pieces = [piece('a', 'p1', AT - HOUR)];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  h.writes.length = 0;
  pieces = [...pieces, piece('a', 'p 2/b', AT, { lon: -120.5 })];
  await h.layer.update();
  const calls = () => h.writes.map(({ call, ids }) => [call, ids]);
  const edge = (...pieceIds) => [
    ['set', pieceIds.map((id) => `fire-perimeter:a:${id}:halo:0`)],
    ['set', pieceIds.map((id) => `fire-perimeter:a:${id}:line:0`)],
  ];
  assert.deepEqual(calls(), [
    ['upsert', ['fire-perimeter:a:p%202%2Fb:0']],
    ...edge('p1', 'p%202%2Fb'),
  ]);
  h.writes.length = 0;
  pieces = pieces.slice(1);
  await h.layer.update();
  assert.deepEqual(calls(), [
    ['remove', ['fire-perimeter:a:p1:0']],
    ...edge('p%202%2Fb'),
  ]);
  assert.deepEqual(
    [...h.items('fills').keys()],
    ['fire-perimeter:a:p%202%2Fb:0'],
  );
  // A set left with nothing is let go, not written.
  h.writes.length = 0;
  pieces = [];
  await h.layer.update();
  assert.deepEqual(h.writes, []);
  for (const kind of ['fills', 'halos', 'lines'])
    assert.equal(h.items(kind).size, 0);
  h.layer.destroy();
});

test('a fill set that loses and gains pieces in one read is written once, whole', async () => {
  const fires = [fireAt('a', -120, 38)];
  let pieces = [
    piece('a', 'p1', AT - HOUR),
    piece('a', 'p2', AT - HOUR, { lon: -120.5 }),
  ];
  const h = harness(() => snapshot(fires, pieces));
  await h.layer.update();
  h.writes.length = 0;
  pieces = [pieces[1], piece('a', 'p3', AT, { lon: -121 })];
  await h.layer.update();
  assert.deepEqual(
    h.writes
      .filter(({ set }) => set.endsWith(':fills'))
      .map(({ call, ids }) => [call, ids]),
    [['set', ['fire-perimeter:a:p2:0', 'fire-perimeter:a:p3:0']]],
  );
  h.layer.destroy();
});

test("new fills go into the newest fill set until it holds a share of the fills; each fire's edge joins the smallest group with room", async () => {
  // A fire whose edge takes nearly a group's room.
  const most = LINE_MIN_VERTICES / SQUARE_VERTICES - 5;
  const fires = ['a', 'b', 'c', 'd'].map((id, i) => fireAt(id, -120 + i, 38));
  let pieces = [
    piece('a', 'a1', AT, { lon: -120, count: most }),
    piece('b', 'b1', AT, { lon: -119, count: 10 }),
  ];
  const h = harness(() => snapshot(fires, pieces));
  const ours = (kind) =>
    h.renderer.testing
      .sets()
      .filter((id) => id.startsWith('fire-perimeters') && id.endsWith(kind));
  const lineSetOf = (id) => h.items('lines').get(id).set;
  await h.layer.update();
  // `b`'s edge does not fit beside `a`'s: a group of its own.
  assert.notEqual(
    lineSetOf('fire-perimeter:a:a1:line:0'),
    lineSetOf('fire-perimeter:b:b1:line:0'),
  );
  assert.equal(ours(':lines').length, 2);
  assert.equal(ours(':fills').length, 1, 'the fills fit one set');
  const first = ours('');
  h.writes.length = 0;
  // The first fill set is full: `c` and `d`'s fills start a second. `c`'s
  // edge fits beside `b`'s, the smaller; `d`'s fits nowhere.
  pieces = [
    ...pieces,
    piece('c', 'c1', AT, { lon: -118, count: 400 }),
    piece('d', 'd1', AT, { lon: -117, count: most }),
  ];
  await h.layer.update();
  assert.equal(
    lineSetOf('fire-perimeter:c:c1:line:0'),
    lineSetOf('fire-perimeter:b:b1:line:0'),
  );
  const made = ours('').filter((id) => !first.includes(id));
  assert.deepEqual(
    made.map((id) => id.split(':').at(-1)),
    ['fills', 'halos', 'lines'],
    'a fill set, and an edge group for d',
  );
  assert.equal(lineSetOf('fire-perimeter:d:d1:line:0'), made[2]);
  assert.equal(h.items('fills').get('fire-perimeter:d:d1:0').set, made[0]);
  // `a`'s edge sets are not written.
  const ofA = new Set([
    lineSetOf('fire-perimeter:a:a1:line:0'),
    h.items('halos').get('fire-perimeter:a:a1:halo:0').set,
  ]);
  assert.equal(
    h.writes.some(({ set }) => ofA.has(set)),
    false,
  );
  const order = (id) => h.renderer.testing.setRecord(id).spec.drawOrder;
  assert.deepEqual(
    ours('')
      .filter((id) => !id.endsWith(':markers'))
      .map(order),
    [0, 1, 2, 1, 2, 0, 1, 2],
  );
  // A fire gone leaves its group, and a group with nothing left goes; the
  // second fill set keeps `c`'s fills.
  pieces = pieces.filter(({ fireId }) => fireId !== 'd');
  await h.layer.update();
  assert.deepEqual(ours(''), [...first, made[0]]);
  h.layer.destroy();
});

test('a snapshot without piece ids is drawn whole every time it changes', async () => {
  const fires = [fireAt('a', -120, 38)];
  let at = AT;
  let revision = 'r1';
  const pieces = [
    piece('a', null, AT - 5 * HOUR),
    piece('a', null, AT - HOUR, { lon: -120.5 }),
  ];
  const h = harness(() => snapshot(fires, pieces, { at, revision }));
  await h.layer.update();
  const whole = [
    ['set', ['fire-perimeter:a:0', 'fire-perimeter:a:1']],
    ['set', ['fire-perimeter:a:halo:0', 'fire-perimeter:a:halo:1']],
    ['set', ['fire-perimeter:a:line:0', 'fire-perimeter:a:line:1']],
  ];
  const calls = () => h.writes.map(({ call, ids }) => [call, ids]);
  assert.deepEqual(calls(), whole);
  h.writes.length = 0;
  await h.layer.update();
  at += 20 * HOUR;
  await h.layer.update();
  assert.deepEqual(calls(), [], 'the same revision, a day on');
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
  // The markers stay; the perimeter sets start over.
  const perimeters = () =>
    h.renderer.testing
      .sets()
      .filter((id) => id.startsWith('fire') && !id.endsWith(':markers'));
  const first = perimeters();
  pieces = [piece('a', 'p1', AT)];
  await h.layer.update();
  const second = perimeters();
  assert.equal(
    first.some((id) => second.includes(id)),
    false,
  );
  assert.deepEqual([...h.items('fills').keys()], ['fire-perimeter:a:p1:0']);
  pieces = [piece('a', null, AT)];
  await h.layer.update();
  assert.deepEqual([...h.items('fills').keys()], ['fire-perimeter:a:0']);
  h.layer.disable();
  for (const id of perimeters()) assert.equal(h.sets.get(id).show, false);
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
      setEntries: (sourceId, list) =>
        sourceId === 'fire-perimeters' && entries.push(...list),
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
  // A day on, and a new piece: the picks still find their fire.
  at += 24 * HOUR;
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

test('a piece id repeated within a fire draws the snapshot whole; the same id in two fires does not', async () => {
  const fires = [fireAt('a', -120, 38), fireAt('b', -119, 39)];
  const a = piece('a', 'p', AT);
  const separate = harness(() =>
    snapshot(fires, [a, piece('b', 'p', AT, { lon: -119, lat: 39 })]),
  );
  await separate.layer.update();
  assert.deepEqual(
    [...separate.items('fills').keys()],
    ['fire-perimeter:a:p:0', 'fire-perimeter:b:p:0'],
  );
  separate.layer.destroy();
  const repeated = harness(() =>
    snapshot(fires, [a, piece('a', 'p', AT, { lon: -120.5 })]),
  );
  await repeated.layer.update();
  assert.deepEqual(
    [...repeated.items('fills').keys()],
    ['fire-perimeter:a:0', 'fire-perimeter:a:1'],
  );
  repeated.layer.destroy();
});
