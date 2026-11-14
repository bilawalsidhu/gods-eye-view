import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { CHUNK_POINTS, createTrail } from './trailRenderer.js';
import { findPickOwner } from './pickRegistry.js';

function viewerWithDraw(t) {
  const viewer = { isDestroyed: () => false };
  const { draw, unbind } = bindFakeDraw(viewer);
  t.after(unbind);
  return { viewer, draw };
}

test('a trail draws its history as one dimmed-when-hidden geodesic line', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#00d4ff', width: 2.5 });
  trail.setPositions([
    { x: 1, y: 2, z: 3 },
    { x: 1, y: 2, z: 3.01 },
    { x: 4, y: 5, z: 6 },
  ]);
  const set = draw.find('trail:');
  assert.equal(set.kind, 'lines');
  assert.equal(set.items.size, 1);
  const [line] = set.items.values();
  assert.match(line.id, /^gev-trail:/, 'claimed by the trail pick owner');
  assert.equal(findPickOwner(line.id), 'trails');
  // The near-duplicate merges.
  assert.deepEqual(line.positions, [
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ]);
  assert.equal(line.widthPx, 2.5);
  assert.equal(line.mode, 'geodesic');
  assert.equal(line.style.kind, 'solid');
  assert.deepEqual(line.style.color, [0, 212 / 255, 1, 0.85]);
  assert.deepEqual(line.depthFail, {
    kind: 'solid',
    color: [0, 212 / 255, 1, 0.4],
  });

  // The same positions again change nothing; fewer than two distinct hide it.
  const writes = set.writes;
  trail.setPositions([
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ]);
  assert.equal(set.writes, writes);
  trail.setPositions([{ x: 1, y: 2, z: 3 }]);
  assert.equal(set.items.get(line.id).show, false, 'hidden, kept in place');
});

test('a trail head is a line of its own beside the history, at the head alphas', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#ffb800' });
  trail.setPositions([
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ]);
  trail.setHead([
    { x: 10, y: 0, z: 0 },
    { x: 20, y: 0, z: 0 },
  ]);
  const set = draw.find('trail:');
  assert.equal(set.items.size, 2);
  const head = [...set.items.values()].find((line) =>
    line.id.endsWith(':head'),
  );
  assert.equal(findPickOwner(head.id), 'trails');
  assert.equal(head.style.color[3], 0.9);
  assert.equal(head.depthFail.color[3], 0.45);
  assert.equal(head.mode, '3d', 'short: straight, two positions a frame');
  // No head: hidden once, then nothing more to write.
  trail.setHead(null);
  assert.equal(set.items.get(head.id).show, false);
  const writes = set.writes;
  trail.setHead([]);
  assert.equal(set.writes, writes);
  trail.clear();
  assert.equal(set.items.size, 0);
});

test('trail visibility can change without discarding its accumulated geometry', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#ffffff' });
  trail.setVisible(false);
  trail.setPositions([
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ]);
  const set = draw.find('trail:');
  assert.equal(set.show, false, 'made hidden');
  trail.setVisible(true);
  assert.equal(set.show, true);
  assert.equal(set.items.size, 1, 'history kept');
  trail.destroy();
  assert.equal(set.disposed, true);
  trail.setPositions([
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ]);
  assert.equal(draw.find('trail:'), undefined, 'nothing after destroy');
});

test('a head given while the trail is hidden is drawn once it shows', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#fff' });
  trail.setPositions([
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ]);
  const set = draw.find('trail:');
  trail.setVisible(false);
  const writes = set.writes;
  for (let i = 1; i <= 3; i++)
    trail.setHead([
      { x: 10, y: 0, z: 0 },
      { x: 10 + i, y: 0, z: 0 },
    ]);
  assert.equal(set.writes, writes, 'nothing drawn while hidden');
  trail.setVisible(true);
  const head = [...set.items.values()].find((line) =>
    line.id.endsWith(':head'),
  );
  assert.deepEqual(head.positions.at(-1), { x: 13, y: 0, z: 0 }, 'the last');
  // Any CSS colour, at the trail's alphas.
  assert.deepEqual(head.style.color, [1, 1, 1, 0.9]);
});

test('a hidden line shows again where it is next given', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#39ffd5' });
  const line = (x) => [
    { x: 0, y: 0, z: 0 },
    { x, y: 0, z: 0 },
  ];
  trail.setPositions(line(10));
  trail.setPositions([]);
  trail.setPositions(line(20));
  const [body] = draw.find('trail:').items.values();
  assert.notEqual(body.show, false);
  assert.deepEqual(body.positions, line(20));
});

test('a viewer with nothing to draw with draws no trail', () => {
  const trail = createTrail({ isDestroyed: () => false }, { color: '#fff' });
  assert.doesNotThrow(() =>
    trail.setPositions([
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
    ]),
  );
  trail.destroy();
});

const points = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ x: (from + i) * 10, y: 0, z: 0 }));

/** The set's history lines (the head left out), oldest first. */
const historyLines = (set) =>
  [...set.items.values()]
    .filter((line) => !line.id.endsWith(':head') && line.show !== false)
    .sort((a, b) => a.positions[0].x - b.positions[0].x);

test('a trail with breaks draws each segment and nothing between them', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#00d4ff' });
  trail.setSegments([points(3), points(1, 50), points(4, 100)]);
  const lines = historyLines(draw.find('trail:'));
  assert.deepEqual(
    lines.map((line) => line.positions.map((p) => p.x)),
    [
      [0, 10, 20],
      [1000, 1010, 1020, 1030],
    ],
    'a one-point segment draws nothing, and no line joins the others',
  );
});

test('long segments are cut into lines that share their boundary points', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#00d4ff' });
  const seg = points(CHUNK_POINTS * 2 + 10);
  trail.setSegments([seg]);
  const lines = historyLines(draw.find('trail:'));
  assert.equal(lines.length, 3);
  for (let i = 1; i < lines.length; i++)
    assert.deepEqual(lines[i].positions[0], lines[i - 1].positions.at(-1));
  assert.equal(
    lines.reduce((sum, line) => sum + line.positions.length - 1, 0),
    seg.length - 1,
    'every point drawn once, past the shared ones',
  );
});

test('an update that keeps a line’s points never rewrites it', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#00d4ff' });
  const seg = points(CHUNK_POINTS * 2 + 10);
  trail.setSegments([seg]);
  const set = draw.find('trail:');
  const [first, second] = historyLines(set);
  // Appending only moves the newest line on.
  trail.setSegments([[...seg, ...points(5, seg.length)]]);
  let lines = historyLines(set);
  assert.equal(lines[0], first);
  assert.equal(lines[1], second);
  // A backfill prepended ahead keeps them, joining at a shared point.
  const older = points(20, -20);
  trail.setSegments([[...older, ...seg]]);
  lines = historyLines(set);
  assert.ok(lines.includes(first) && lines.includes(second));
  assert.deepEqual(lines[0].positions.at(-1), first.positions[0]);
  // Dropping the oldest point rewrites only the first line.
  trail.setSegments([seg.slice(1)]);
  lines = historyLines(set);
  assert.notEqual(lines[0], first);
  assert.equal(lines[1], second);
  assert.deepEqual(lines[0].positions.at(-1), second.positions[0]);
});

test('clearing a segmented trail lets every line go', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const trail = createTrail(viewer, { color: '#00d4ff' });
  trail.setSegments([points(CHUNK_POINTS * 3)]);
  const set = draw.find('trail:');
  trail.clear();
  assert.equal(set.items.size, 0);
  trail.setSegments([points(4)]);
  assert.equal(historyLines(set).length, 1, 'drawn again after a clear');
});
