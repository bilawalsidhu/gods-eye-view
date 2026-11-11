import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { CHUNK_POINTS, createTrail } from './trailRenderer.js';

function fixture() {
  const engine = createFakeEngine();
  const trail = createTrail(engine, { color: '#ffffff' });
  const runs = () =>
    engine.lines
      .list()
      .filter(({ points, shown }) => points >= 2 && shown)
      .map(({ id }) => {
        const flat = engine.fake.line(id).positions;
        return Array.from({ length: flat.length / 3 }, (_, i) =>
          geo.cartesian3.create(...flat.slice(i * 3, i * 3 + 3)),
        );
      });
  const points = () => new Set(runs().flat().map(key));
  return { engine, trail, runs, points };
}
const key = ({ x, y, z }) => `${x},${y},${z}`;
const line = (count, offset = 0) =>
  Array.from({ length: count }, (_, i) =>
    geo.cartesian3.create(6_378_137 + offset, i * 1000, 0),
  );

test('trail visibility can change without discarding its accumulated geometry', () => {
  const { engine, trail, runs } = fixture();
  const positions = line(2);
  trail.setVisible(false);
  trail.setPositions(positions);
  assert.equal(engine.lines.list().length, 1);
  assert.equal(engine.lines.list()[0].shown, false);
  assert.equal(engine.lines.list()[0].points, 2);
  trail.setVisible(true);
  assert.deepEqual(runs(), [positions]);
  trail.destroy();
  assert.deepEqual(engine.lines.list(), []);
});

test('a trail with breaks draws each segment and nothing between them', () => {
  const { engine, trail, runs } = fixture();
  const first = line(2);
  const lone = line(1, 50_000);
  const second = line(3, 100_000);
  trail.setSegments([first, lone, second]);
  assert.deepEqual(
    runs().sort((a, b) => a[0].x - b[0].x),
    [first, second],
  );
  for (const { id } of engine.lines.list()) {
    const { options } = engine.fake.line(id);
    assert.match(id, /^gev-trail:/);
    assert.equal(options.widthPx, 2.5);
    assert.equal(options.arc, 'geodesic');
    assert.equal(options.color[3], 0.85);
    assert.equal(options.color[3] * options.depthFailAlpha, 0.4);
  }
  trail.setSegments([second]);
  assert.deepEqual(runs(), [second]);
  trail.setVisible(false);
  assert.ok(engine.lines.list().every(({ shown }) => !shown));
  trail.destroy();
  assert.deepEqual(engine.lines.list(), []);
});

test('chunks share their boundary points and only the newest chunk changes', () => {
  const { trail, points } = fixture();
  const positions = line(300);
  trail.setPositions(positions);
  const { frozen, dynamic } = trail._chunksForTest();
  assert.deepEqual(
    frozen.map((chunk) => chunk.positions.length),
    [CHUNK_POINTS, CHUNK_POINTS],
  );
  assert.equal(frozen[0].positions.at(-1), frozen[1].positions[0]);
  assert.equal(dynamic.length, 1);
  assert.equal(frozen[1].positions.at(-1), dynamic[0][0]);
  assert.equal(dynamic[0].at(-1), positions.at(-1));
  assert.equal(points().size, positions.length);
  trail.destroy();
});

test('freezing a chunk keeps every point drawn without waiting for another frame', () => {
  const { engine, trail, points } = fixture();
  const positions = line(CHUNK_POINTS + 20);
  for (let n = 2; n <= positions.length; n++) {
    trail.setPositions(positions.slice(0, n));
    assert.equal(points().size, n, `points drawn at ${n}`);
  }
  const { frozen } = trail._chunksForTest();
  assert.equal(frozen.length, 1);
  const handle = frozen[0].line;
  engine.fake.frame();
  assert.equal(trail._chunksForTest().frozen[0].line, handle);
  assert.equal(points().size, positions.length);
  trail.destroy();
});

test('a hidden trail keeps all geometry through freezing and showing', () => {
  const { engine, trail, points } = fixture();
  trail.setVisible(false);
  const positions = line(300);
  trail.setPositions(positions);
  const before = trail._chunksForTest().frozen;
  engine.fake.frame();
  assert.ok(engine.lines.list().every(({ shown }) => !shown));
  trail.setVisible(true);
  assert.equal(points().size, positions.length);
  assert.equal(trail._chunksForTest().frozen[0].line, before[0].line);
  trail.destroy();
});

test('dropping the oldest point rebuilds only the first frozen chunk', () => {
  const { engine, trail, points } = fixture();
  const positions = line(400);
  trail.setPositions(positions);
  const before = trail._chunksForTest().frozen;
  trail.setPositions(positions.slice(1));
  const after = trail._chunksForTest().frozen;
  assert.equal(after.length, before.length);
  assert.notEqual(after[0].line, before[0].line);
  assert.ok(!engine.lines.list().some(({ id }) => id === before[0].line.id));
  for (let k = 1; k < before.length; k++)
    assert.equal(after[k].line, before[k].line);
  assert.equal(after[0].positions.at(-1), after[1].positions[0]);
  assert.equal(points().size, 399);
  trail.destroy();
});

test('a backfill prepended ahead of frozen chunks keeps them and joins at a shared point', () => {
  const { trail, runs, points } = fixture();
  const live = line(300);
  trail.setPositions(live);
  const before = trail._chunksForTest().frozen;
  const history = Array.from({ length: 200 }, (_, i) =>
    geo.cartesian3.create(6_378_137, -(200 - i) * 1000, 0),
  );
  trail.setPositions(history.concat(live));
  const after = trail._chunksForTest().frozen;
  for (const chunk of before)
    assert.ok(after.some((c) => c.line === chunk.line));
  for (let k = 0; k + 1 < after.length; k++)
    assert.equal(after[k].positions.at(-1), after[k + 1].positions[0]);
  assert.equal(points().size, 500);
  trail.setSegments([history, live]);
  assert.equal(points().size, 500);
  assert.ok(
    !runs().some(
      (run) =>
        run.some((p) => key(p) === key(history.at(-1))) &&
        run.some((p) => key(p) === key(live[0])),
    ),
  );
  trail.destroy();
});

test('clearing and re-tracking release every frozen chunk', () => {
  const { engine, trail, runs, points } = fixture();
  trail.setPositions(line(600));
  const frozen = trail._chunksForTest().frozen;
  assert.ok(frozen.length >= 4);
  trail.clear();
  for (const chunk of frozen)
    assert.ok(!engine.lines.list().some(({ id }) => id === chunk.line.id));
  assert.equal(runs().length, 0);
  trail.setPositions(line(200, 900_000));
  assert.equal(points().size, 200);
  trail.destroy();
  assert.deepEqual(engine.lines.list(), []);
});

test('replacing the newest point and removing points inside the trail draws exactly the new trail', () => {
  const { trail, runs, points } = fixture();
  const positions = line(400);
  trail.setPositions(positions.slice());
  positions[positions.length - 1] = geo.cartesian3.create(
    6_378_137,
    399_500,
    10,
  );
  positions.splice(200, 1);
  positions.splice(CHUNK_POINTS - 1, 1);
  trail.setPositions(positions.slice());
  assert.deepEqual(points(), new Set(positions.map(key)));
  const next = new Map(
    positions.slice(0, -1).map((p, i) => [key(p), key(positions[i + 1])]),
  );
  for (const run of runs())
    for (let i = 1; i < run.length; i++)
      assert.equal(next.get(key(run[i - 1])), key(run[i]));
  trail.destroy();
});
