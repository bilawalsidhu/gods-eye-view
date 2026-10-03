// Tile fallbacks still run after a busy or failed Nominatim answer, and
// grounds asks phrased "around" still reach their outline rungs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOutlineRungs, nominatimKindFor } from './outlineRungs.js';
import { decodeOpenFreeMapOutlineTile } from '../sources/openFreeMapOutlines.js';

const TILES = [6745, 6746].map((y) =>
  decodeOpenFreeMapOutlineTile(
    readFileSync(
      new URL(
        `../data/fixtures/ofm-outlines-austin-14-3743-${y}.pbf`,
        import.meta.url,
      ),
    ),
    14,
    3743,
    y,
  ),
);
const UNAVAILABLE = { unavailable: true, retryable: false };
const CAPITOL = { lat: 30.27472, lon: -97.74035 };

function setup(answer) {
  const tileCalls = [];
  const asks = [];
  const rungs = createOutlineRungs({
    tiles: {
      fetchBounds: async (box) => {
        tileCalls.push(box);
        return { tiles: TILES };
      },
    },
    nominatim: {
      lookup: async (ask) => {
        asks.push(ask);
        return answer;
      },
    },
  });
  return { rungs, tileCalls, asks };
}
const ladder = {
  base: async () => UNAVAILABLE,
  finish: (fp) => ({ ring: fp.ring, footprintKind: fp.kind }),
};
const ctx = (overrides) => ({
  scope: 'building',
  target: 'Texas State Capitol',
  matchName: 'Texas State Capitol',
  fromName: true,
  ...CAPITOL,
  view: CAPITOL,
  ...overrides,
});

for (const [label, answer] of [
  ['busy', { rateLimited: true, retryAfterMs: 5000 }],
  ['transient', undefined],
]) {
  test(`a ${label} Nominatim answer does not skip the tile fallbacks`, async () => {
    const building = setup(answer);
    const found = await building.rungs.resolve(ctx(), ladder);
    assert.equal(building.asks.length, 1);
    assert.ok(building.tileCalls.length > 0, 'tiles were consulted');
    assert.equal(found.footprintKind, 'building');

    const grounds = setup(answer);
    const lawn = await grounds.rungs.resolve(
      ctx({ target: 'the Texas Capitol grounds', groundsLike: true }),
      ladder,
    );
    assert.equal(lawn.footprintKind, 'area');
    assert.equal(lawn.outlineSource, 'openfreemap');
  });
}

test('with no tile answer either, the busy result keeps the mark retryable', async () => {
  const busy = { rateLimited: true, retryAfterMs: 5000 };
  const rungs = createOutlineRungs({
    tiles: { fetchBounds: async () => ({ tiles: [] }) },
    nominatim: { lookup: async () => busy },
  });
  assert.equal(await rungs.resolve(ctx(), ladder), busy);
});

test('"around the Capitol grounds" is still a grounds ask', async () => {
  assert.equal(
    nominatimKindFor({ scope: 'building', groundsLike: true, around: true }),
    'landmark',
  );
  assert.equal(nominatimKindFor({ scope: 'compound', around: true }), null);
  const { rungs, asks } = setup(null);
  const lawn = await rungs.resolve(
    ctx({
      target: 'the Texas Capitol grounds',
      groundsLike: true,
      around: true,
    }),
    ladder,
  );
  assert.equal(asks.length, 1);
  assert.equal(lawn.outlineSource, 'openfreemap');
});

test('Nominatim administrative identity survives the outline rung', async () => {
  const boundary = {
    polygons: [
      [
        [
          [84.4, 26.9],
          [86.6, 26.9],
          [86.6, 28.4],
          [84.4, 28.4],
          [84.4, 26.9],
        ],
      ],
    ],
    class: 'boundary',
    type: 'administrative',
    adminArea: 'Bagmati Province',
    adminLevel: 'admin1',
  };
  const { rungs } = setup(boundary);
  const result = await rungs.resolve(
    ctx({
      scope: 'state',
      target: 'Bagmati Province',
      matchName: 'Bagmati Province',
      lat: 27.7,
      lon: 85.3,
      view: { lat: 27.7, lon: 85.3 },
    }),
    {
      base: async () => UNAVAILABLE,
      finish: (fp) => ({
        ring: fp.ring,
        footprintKind: fp.kind,
        adminArea: fp.adminArea,
        adminLevel: fp.adminLevel,
      }),
    },
  );
  assert.equal(result.adminArea, 'Bagmati Province');
  assert.equal(result.adminLevel, 'admin1');
});

test('grounds are found around the named building when the anchor is off the lawn', async () => {
  // A place-search anchor ~250 m from the dome, outside the Capitol lawn.
  const offLawn = { lat: 30.27265, lon: -97.73925 };
  const d = 0.0003;
  const dome = {
    polygons: [
      [
        [
          [CAPITOL.lon - d, CAPITOL.lat - d],
          [CAPITOL.lon + d, CAPITOL.lat - d],
          [CAPITOL.lon + d, CAPITOL.lat + d],
          [CAPITOL.lon - d, CAPITOL.lat + d],
          [CAPITOL.lon - d, CAPITOL.lat - d],
        ],
      ],
    ],
    class: 'office',
  };
  const withoutSeed = setup(null);
  assert.equal(
    await withoutSeed.rungs.resolve(
      ctx({
        ...offLawn,
        target: 'the Texas Capitol grounds',
        groundsLike: true,
      }),
      ladder,
    ),
    UNAVAILABLE,
    'the anchor alone is not inside the grounds',
  );
  const { rungs } = setup(dome);
  const lawn = await rungs.resolve(
    ctx({ ...offLawn, target: 'the Texas Capitol grounds', groundsLike: true }),
    ladder,
  );
  assert.equal(lawn?.outlineSource, 'openfreemap');
  assert.equal(lawn.footprintKind, 'area');
});
