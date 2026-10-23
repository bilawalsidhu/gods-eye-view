import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeCoverageTile,
  decodeCoverageTileSliced,
  decodePictures,
  simplifyLine,
} from './decode.js';
import { encodePanoramaxTile } from '../../../../testSupport/panoramaxFixtures.mjs';
import { tileCentre } from '../../../../testSupport/streetLevelFakes.mjs';

const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

test('sequence lines keep their parts apart, with their day and camera type', () => {
  const { tile, lon, lat } = tileCentre(2.35, 48.85);
  const bytes = encodePanoramaxTile(tile, {
    sequences: [
      {
        id: 'pano-seq',
        type: 'equirectangular',
        date: '2024-03-05',
        parts: [
          [
            [lon - 0.001, lat],
            [lon, lat],
          ],
          [
            [lon + 0.0005, lat],
            [lon + 0.001, lat],
          ],
        ],
      },
      {
        id: 'flat-seq',
        parts: [
          [
            [lon, lat - 0.001],
            [lon, lat],
          ],
        ],
      },
    ],
  });
  const { sequences } = decodeCoverageTile(bytes, tile);
  assert.equal(sequences.length, 2);
  const pano = sequences.find((s) => s.id === 'pano-seq');
  const flat = sequences.find((s) => s.id === 'flat-seq');
  assert.equal(pano.isPano, true);
  assert.equal(pano.capturedAt, Date.UTC(2024, 2, 5));
  assert.equal(pano.parts.length, 2, 'the gap is not bridged');
  assert.ok(near(pano.parts[1][1][0], lon + 0.001));
  assert.equal(flat.isPano, false);
  const untyped = decodeCoverageTile(
    encodePanoramaxTile(tile, {
      sequences: [
        {
          id: 'u',
          type: '',
          parts: [
            [
              [lon, lat],
              [lon + 0.001, lat],
            ],
          ],
        },
      ],
    }),
    tile,
  ).sequences[0];
  assert.equal(untyped.isPano, null, 'no camera type: neither');
});

test('the density grid is not read: nothing is drawn from orbit', () => {
  const tile = { x: 0, y: 0, z: 0 };
  const grid = [{ lon: 2.35, lat: 48.85, pano: 3, flat: 5 }];
  assert.deepEqual(
    decodeCoverageTile(encodePanoramaxTile(tile, { grid }), tile),
    { sequences: [] },
  );
});

test('lines come longest first, so a cap on lines drawn drops the shortest', () => {
  const { tile, lon, lat } = tileCentre(2.35, 48.85);
  const span = (id, metres) => ({
    id,
    parts: [
      [
        [lon, lat],
        [lon + metres / 73_000, lat],
      ],
    ],
  });
  const { sequences } = decodeCoverageTile(
    encodePanoramaxTile(tile, {
      sequences: [span('short', 20), span('long', 900), span('mid', 300)],
    }),
    tile,
  );
  assert.deepEqual(
    sequences.map((s) => s.id),
    ['long', 'mid', 'short'],
  );
});

/** A tile with many lines and a dense grid, for the sliced decode. */
function busyTile() {
  const { tile, lon, lat } = tileCentre(2.35, 48.85);
  const sequences = Array.from({ length: 200 }, (_, i) => ({
    id: `s${i}`,
    parts: [
      [
        [lon, lat + i / 1e6],
        [lon + (i + 1) / 73_000, lat + i / 1e6],
      ],
    ],
  }));
  const grid = Array.from({ length: 500 }, (_, i) => ({
    lon: lon + (i % 25) / 1e4,
    lat: lat + Math.floor(i / 25) / 1e4,
  }));
  return { tile, bytes: encodePanoramaxTile(tile, { sequences, grid }) };
}

test('a sliced decode gives the page turns and decodes the same as one in one go', async () => {
  const { tile, bytes } = busyTile();
  let clock = 0;
  let pauses = 0;
  const sliced = await decodeCoverageTileSliced(bytes, tile, {
    sliceMs: 8,
    // Each step "takes" a millisecond: a turn every eight features.
    now: () => clock++,
    pause: async () => {
      pauses++;
    },
  });
  assert.ok(pauses > 20, `${pauses} turns`);
  assert.deepEqual(sliced, decodeCoverageTile(bytes, tile));
});

test('a sliced decode stops at the next turn once aborted', async () => {
  const { tile, bytes } = busyTile();
  const controller = new AbortController();
  let clock = 0;
  let pauses = 0;
  await assert.rejects(
    decodeCoverageTileSliced(bytes, tile, {
      signal: controller.signal,
      now: () => (clock += 10),
      pause: async () => {
        if (++pauses === 2) controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(pauses, 2, 'no work after the abort');
});

test('a fast sliced decode takes no turns', async () => {
  const { tile, bytes } = busyTile();
  let pauses = 0;
  await decodeCoverageTileSliced(bytes, tile, {
    now: () => 0,
    pause: async () => {
      pauses++;
    },
  });
  assert.equal(pauses, 0);
});

test('an empty tile decodes to nothing', () => {
  for (const bytes of [new Uint8Array(0), null, undefined])
    assert.deepEqual(decodeCoverageTile(bytes, { x: 0, y: 0, z: 0 }), {
      sequences: [],
    });
  assert.deepEqual(
    decodePictures(new Uint8Array(0), { x: 0, y: 0, z: 15 }, 's'),
    [],
  );
});

test('a z15 tile’s pictures of one sequence become cones; other sequences’ are skipped', () => {
  const { tile, lon, lat } = tileCentre(2.35, 48.85, 15);
  const bytes = encodePanoramaxTile(tile, {
    pictures: [
      {
        id: 'a',
        lon,
        lat,
        sequenceId: 's1',
        heading: 45,
        type: 'equirectangular',
        ts: '2023-12-12 07:56:37+00',
      },
      { id: 'b', lon: lon + 0.0001, lat, sequenceId: 's2' },
      { id: 'c', lon: lon + 0.0002, lat, sequenceId: 's1' },
    ],
  });
  const images = decodePictures(bytes, tile, 's1');
  assert.deepEqual(
    images.map((i) => i.id),
    ['a', 'c'],
  );
  assert.equal(images[0].compassAngle, 45);
  assert.equal(images[0].isPano, true);
  assert.equal(images[0].capturedAt, Date.UTC(2023, 11, 12, 7, 56, 37));
  assert.ok(near(images[1].lon, lon + 0.0002));
  assert.deepEqual(decodePictures(bytes, tile, 'nope'), []);
  // A tile without pictures (below z15) has none to give.
  const lines = encodePanoramaxTile(tile, {
    sequences: [
      {
        id: 's1',
        parts: [
          [
            [lon, lat],
            [lon + 0.001, lat],
          ],
        ],
      },
    ],
  });
  assert.deepEqual(decodePictures(lines, tile, 's1'), []);
});

test('lines are simplified within a few tile units, ends and corners kept', () => {
  const zigzag = Array.from({ length: 1000 }, (_, i) => ({
    x: i,
    y: i % 2 ? 1 : 0,
  }));
  assert.deepEqual(
    simplifyLine(zigzag, 4),
    [zigzag[0], zigzag.at(-1)],
    'a 1-unit wobble goes',
  );
  const corner = [
    { x: 0, y: 0 },
    { x: 50, y: 1 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  assert.deepEqual(simplifyLine(corner, 4), [corner[0], corner[2], corner[3]]);
  assert.equal(simplifyLine(corner.slice(0, 2), 4).length, 2);
  // A loop back to its start (no chord) keeps its far point.
  const loop = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 0, y: 0 },
  ];
  assert.equal(simplifyLine(loop, 4).length, 3);
  assert.equal(simplifyLine(zigzag, 0).length, 1000, 'no tolerance, no change');
  // A dead end: out to 100 and back to 50 keeps its far end.
  const deadEnd = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 0 },
  ];
  assert.deepEqual(simplifyLine(deadEnd, 4), deadEnd);
});

test('a decoded GPS track keeps a fraction of its points', () => {
  const { tile, lon, lat } = tileCentre(2.35, 48.85);
  const track = Array.from({ length: 500 }, (_, i) => [
    lon - 0.004 + i * 0.000016,
    lat + Math.sin(i / 40) * 0.0004,
  ]);
  const [sequence] = decodeCoverageTile(
    encodePanoramaxTile(tile, { sequences: [{ id: 'gps', parts: [track] }] }),
    tile,
  ).sequences;
  assert.ok(
    sequence.parts[0].length < 100,
    `${sequence.parts[0].length} points`,
  );
  assert.ok(sequence.parts[0].length > 5);
});
