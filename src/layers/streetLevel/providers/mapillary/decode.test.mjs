import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import { decodeCoverageTile } from './decode.js';

const zigzag = (value) => (value << 1) ^ (value >> 31);

/** A minimal mly1_public-shaped tile: one sequence line and one overview point. */
function sampleTile() {
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
          feature.writePackedVarint(4, [
            9,
            zigzag(100),
            zigzag(100), // MoveTo
            10,
            zigzag(200),
            zigzag(200), // LineTo ×1
          ]);
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

test('sequences and overview points decode into lon/lat records', () => {
  const decoded = decodeCoverageTile(sampleTile(), { x: 0, y: 0, z: 1 });
  assert.equal(decoded.sequences.length, 1);
  const [sequence] = decoded.sequences;
  assert.equal(sequence.id, 'seq-42');
  assert.equal(sequence.capturedAt, 1_700_000_000);
  assert.equal(sequence.isPano, true);
  assert.equal(sequence.coordinates.length, 2);
  const [[lon0, lat0], [lon1, lat1]] = sequence.coordinates;
  assert.ok(
    lon0 > -180 && lon0 < 0 && lon1 > lon0,
    'west half of tile 0/0 at z1',
  );
  assert.ok(lat0 > 0 && lat1 < lat0, 'northern hemisphere, moving south');
  assert.equal(decoded.overview.length, 1);
  assert.equal(decoded.overview[0].id, '3');
  assert.equal(decoded.overview[0].isPano, false);
  assert.ok(Math.abs(decoded.overview[0].lon - -90) < 1e-6, 'tile centre');
  assert.equal(decoded.images.length, 0, 'image layer skipped by default');
});

test('an empty tile decodes to empty lists', () => {
  assert.deepEqual(
    decodeCoverageTile(new Uint8Array(0), { x: 0, y: 0, z: 0 }),
    {
      sequences: [],
      images: [],
      overview: [],
    },
  );
});
