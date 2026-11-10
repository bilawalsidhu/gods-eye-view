import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wildlifeViewportBoxes,
  snapWildlifeBox,
  boxIntersects,
  retryDelayMs,
} from './viewport.js';
import { ACARTIA_GUARD_BOX } from './policy.js';
import { getWildlifeHeightBand } from './model.js';

const viewer = ({ south, west, north, east }) => ({
  camera: {
    computeViewRectangle: () =>
      Object.fromEntries(
        Object.entries({ south, west, north, east }).map(([key, value]) => [
          key,
          (value * Math.PI) / 180,
        ]),
      ),
  },
  scene: { globe: { ellipsoid: {} } },
});

test('local boxes snap outward to 0.1 degrees; wider views to whole degrees', () => {
  assert.deepEqual(
    snapWildlifeBox({
      south: 47.61,
      west: -122.35,
      north: 47.79,
      east: -122.21,
    }),
    { south: 47.6, west: -122.4, north: 47.8, east: -122.2 },
  );
  assert.deepEqual(
    snapWildlifeBox({ south: 40.1, west: -126.2, north: 46.1, east: -121.1 }),
    { south: 40, west: -127, north: 47, east: -121 },
  );
  assert.deepEqual(
    snapWildlifeBox({ south: 47.6, west: -122.4, north: 47.8, east: -122.2 }),
    { south: 47.6, west: -122.4, north: 47.8, east: -122.2 },
  );
  assert.equal(
    snapWildlifeBox({ south: -20, west: -30, north: 21, east: 10 }),
    null,
  );
});

test('the final snapped span stays within 40 degrees and snapping is idempotent', () => {
  for (const box of [
    { south: 10.2, west: 0, north: 50.1, east: 1 },
    { south: 0, west: 10.2, north: 1, east: 50.1 },
  ])
    assert.equal(snapWildlifeBox(box), null, JSON.stringify(box));
  for (const box of [
    { south: 47.4, west: -122.3, north: 47.6, east: -122.1 },
    { south: 10.01, west: -122.3, north: 14.99, east: -117.31 },
    { south: 10.01, west: 0, north: 15, east: 5 },
    { south: 10.01, west: 0, north: 15.01, east: 5 },
    { south: 10, west: 0, north: 50, east: 1 },
  ]) {
    const snapped = snapWildlifeBox(box);
    assert.ok(snapped, JSON.stringify(box));
    assert.deepEqual(snapWildlifeBox(snapped), snapped);
  }
});

test('intersections handle guard coverage, point boxes and antimeridian', () => {
  const seattle = { south: 47.5, west: -122.5, north: 47.7, east: -122.2 };
  assert.equal(boxIntersects(seattle, ACARTIA_GUARD_BOX), true);
  assert.equal(
    boxIntersects({ ...seattle, west: 20, east: 21 }, ACARTIA_GUARD_BOX),
    false,
  );
  const dateline = { south: 10, west: 175, north: 20, east: -175 };
  assert.equal(
    boxIntersects(dateline, { south: 11, west: 178, north: 12, east: 179 }),
    true,
  );
  assert.equal(
    boxIntersects(dateline, { south: 11, west: -1, north: 12, east: 1 }),
    false,
  );
  assert.equal(boxIntersects(null, seattle), false);
});

test('viewport rectangles split at 180 degrees and reject overly large or missing views', () => {
  assert.deepEqual(
    wildlifeViewportBoxes(
      viewer({ south: 10, west: 179, north: 12, east: -178 }),
    ),
    [
      { south: 10, west: 179, north: 12, east: 180 },
      { south: 10, west: -180, north: 12, east: -178 },
    ],
  );
  assert.deepEqual(
    wildlifeViewportBoxes(
      viewer({ south: 47, west: -123, north: 48, east: -122 }),
    ),
    [{ south: 47, west: -123, north: 48, east: -122 }],
  );
  assert.equal(
    wildlifeViewportBoxes(
      viewer({ south: -21, west: -10, north: 20, east: 10 }),
    ),
    null,
  );
  assert.equal(
    wildlifeViewportBoxes(
      viewer({ south: 0, west: 170, north: 10, east: -140 }),
    ),
    null,
  );
  assert.equal(wildlifeViewportBoxes({}), null);
});

test('height bands retain representations across +/-5% and switch beyond +/-10%', () => {
  assert.equal(getWildlifeHeightBand(3_000_001), 'global');
  assert.equal(getWildlifeHeightBand(3_000_000), 'regional');
  assert.equal(getWildlifeHeightBand(3_150_000, 'regional'), 'regional');
  assert.equal(getWildlifeHeightBand(2_850_000, 'global'), 'global');
  assert.equal(getWildlifeHeightBand(3_310_000, 'regional'), 'global');
  assert.equal(getWildlifeHeightBand(2_690_000, 'global'), 'regional');
  assert.equal(getWildlifeHeightBand(1_600_000), 'regional');
  assert.equal(getWildlifeHeightBand(1_000_000), 'cells');
  assert.equal(getWildlifeHeightBand(30_000), 'cards');
  assert.equal(getWildlifeHeightBand(30_000, 'global'), 'cards');
});

test('retry guidance doubles from 30 seconds to a four-minute ceiling', () => {
  assert.deepEqual(
    [undefined, 30_000, 60_000, 120_000, 240_000].map(retryDelayMs),
    [30_000, 60_000, 120_000, 240_000, 240_000],
  );
});
