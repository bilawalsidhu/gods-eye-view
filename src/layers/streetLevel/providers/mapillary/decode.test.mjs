import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import { decodeCoverageTile } from './decode.js';

const zigzag = (value) => (value << 1) ^ (value >> 31);

/** One line part: MoveTo the first point, LineTo the rest (relative). */
function linePart(points) {
  const out = [9, zigzag(points[0][0]), zigzag(points[0][1])];
  out.push(((points.length - 1) << 3) | 2);
  for (let i = 1; i < points.length; i++)
    out.push(
      zigzag(points[i][0] - points[i - 1][0]),
      zigzag(points[i][1] - points[i - 1][1]),
    );
  return out;
}

/**
 * A minimal mly1_public-shaped tile: one sequence line, plus one point in the
 * low-zoom `overview` layer the layer never draws.
 */
function sampleTile({ geometry = null } = {}) {
  const writer = new PbfWriter();
  writer.writeMessage(
    3,
    (_, layer) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, 'sequence');
      layer.writeVarintField(5, 4096);
      for (const key of ['id', 'captured_at', 'is_pano'])
        layer.writeStringField(3, key);
      layer.writeMessage(
        4,
        (__, value) => value.writeStringField(1, 'seq-42'),
        null,
      );
      layer.writeMessage(
        4,
        (__, value) => value.writeVarintField(5, 1_700_000_000),
        null,
      );
      layer.writeMessage(
        4,
        (__, value) => value.writeBooleanField(7, true),
        null,
      );
      layer.writeMessage(
        2,
        (__, feature) => {
          feature.writeVarintField(1, 7);
          feature.writePackedVarint(2, [0, 0, 1, 1, 2, 2]);
          feature.writeVarintField(3, 2); // LineString
          feature.writePackedVarint(
            4,
            geometry || [
              9,
              zigzag(100),
              zigzag(100), // MoveTo
              10,
              zigzag(200),
              zigzag(200), // LineTo ×1
            ],
          );
        },
        null,
      );
    },
    null,
  );
  writer.writeMessage(
    3,
    (_, layer) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, 'overview');
      layer.writeVarintField(5, 4096);
      layer.writeStringField(3, 'is_pano');
      layer.writeMessage(
        4,
        (__, value) => value.writeBooleanField(7, false),
        null,
      );
      layer.writeMessage(
        2,
        (__, feature) => {
          feature.writeVarintField(1, 3);
          feature.writePackedVarint(2, [0, 0]);
          feature.writeVarintField(3, 1); // Point
          feature.writePackedVarint(4, [9, zigzag(2048), zigzag(2048)]);
        },
        null,
      );
    },
    null,
  );
  return new Uint8Array(writer.finish());
}

test('sequences decode into lon/lat records; overview points are ignored', () => {
  const decoded = decodeCoverageTile(sampleTile(), { x: 0, y: 0, z: 1 });
  assert.equal(decoded.sequences.length, 1);
  const [sequence] = decoded.sequences;
  assert.equal(sequence.id, 'seq-42');
  assert.equal(sequence.capturedAt, 1_700_000_000);
  assert.equal(sequence.isPano, true);
  assert.equal(sequence.parts.length, 1);
  assert.equal(sequence.parts[0].length, 2);
  const [[lon0, lat0], [lon1, lat1]] = sequence.parts[0];
  assert.ok(
    lon0 > -180 && lon0 < 0 && lon1 > lon0,
    'west half of tile 0/0 at z1',
  );
  assert.ok(lat0 > 0 && lat1 < lat0, 'northern hemisphere, moving south');
  assert.deepEqual(Object.keys(decoded), ['sequences']);
});

test('an empty tile decodes to empty lists', () => {
  assert.deepEqual(
    decodeCoverageTile(new Uint8Array(0), { x: 0, y: 0, z: 0 }),
    { sequences: [] },
  );
});

test('a sequence with a capture gap keeps its parts as separate lines', () => {
  // Two parts with a gap between (300,300) and (1000,1000); the second part's
  // MoveTo is relative to the end of the first, as in the MVT encoding.
  const first = [
    [100, 100],
    [300, 300],
  ];
  const second = [
    [700, 700],
    [900, 700],
  ];
  const geometry = [
    ...linePart(first),
    9,
    zigzag(second[0][0] - first[1][0]),
    zigzag(second[0][1] - first[1][1]),
    ((second.length - 1) << 3) | 2,
    zigzag(second[1][0] - second[0][0]),
    zigzag(second[1][1] - second[0][1]),
  ];
  const [sequence] = decodeCoverageTile(sampleTile({ geometry }), {
    x: 0,
    y: 0,
    z: 1,
  }).sequences;
  assert.equal(sequence.parts.length, 2);
  assert.equal(sequence.parts[0].length, 2);
  assert.equal(sequence.parts[1].length, 2);
  // No part ends where the next begins: the gap is not bridged.
  assert.notDeepEqual(sequence.parts[0].at(-1), sequence.parts[1][0]);
});
