import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { createTrail } from './trailRenderer.js';
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
  assert.deepEqual(line.depthFailColor, [0, 212 / 255, 1, 0.4]);

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
  assert.equal(head.depthFailColor[3], 0.45);
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
