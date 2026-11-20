import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentImageryRenderer } from './rendering.js';
import { nonCrossingBoxes } from './model.js';
import { FIJI_BOX } from './testDoubles.mjs';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';

const A = { key: 'S30:2026-09-18', product: 'S30', day: '2026-09-18' };
const B = { key: 'L30:2026-09-16', product: 'L30', day: '2026-09-16' };

test('slot order survives widening', () => {
  const renderer = createRecentImageryRenderer();
  const globe = fakeGlobePort();
  renderer.rebind({ collection: {}, kind: 'globe', globe });
  const [west, east] = nonCrossingBoxes(FIJI_BOX);
  const k = (b) => [b.west, b.south, b.east, b.north].join(',');
  const look = { alpha: 1, splitDirection: 'none' };
  renderer.showSlot('a', A, FIJI_BOX, { ...look, availableBoxes: [west] });
  renderer.showSlot('b', B, FIJI_BOX, {
    ...look,
    availableBoxes: [west, east],
  });
  renderer.showSlot('a', A, FIJI_BOX, {
    ...look,
    availableBoxes: [west, east],
  });
  const topOn = (box) => {
    const on = globe.layers.filter((l) => k(l.spec.rectangle) === k(box));
    return on.at(-1).spec.url.includes('S30') ? 'A' : 'B';
  };
  assert.equal(
    topOn(west),
    topOn(east),
    `west top ${topOn(west)}, east top ${topOn(east)}`,
  );
  renderer.destroy();
});
