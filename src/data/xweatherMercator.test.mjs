import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MERCATOR_MAX_LAT,
  chooseMercatorZoom,
  mercatorTileRange,
  mercatorX,
  mercatorY,
  reprojectToGeographic,
} from '../../server/providers/xweather/mercator.js';

const WORLD = [-180, -MERCATOR_MAX_LAT, 180, MERCATOR_MAX_LAT];

test('the whole Mercator world at z3 is 8x8 tiles', () => {
  assert.deepEqual(mercatorTileRange(WORLD, 3), {
    z: 3,
    x0: 0,
    x1: 7,
    y0: 0,
    y1: 7,
    count: 64,
  });
});

test('zoom choice stops at the tile cap before the wanted sharpness', () => {
  // A 6 degree window at 4096 px wants ~z10; 192 tiles caps it lower.
  const range = chooseMercatorZoom([-108.5, 17, -102.5, 20], 4096, {
    maxZoom: 9,
    maxTiles: 192,
  });
  assert.ok(range.z <= 9);
  assert.ok(range.count <= 192);
  // Never sharper than needed: a whole-world 4096 px image needs only z4.
  assert.equal(
    chooseMercatorZoom(WORLD, 4096, { maxZoom: 9, maxTiles: 512 }).z,
    4,
  );
});

test('rows beyond Mercator coverage stay transparent and the dateline edge maps in range', () => {
  const opaque = new Uint8Array(256 * 256 * 4).fill(200);
  const range = mercatorTileRange([170, 80, 180, 90], 2);
  const seen = [];
  const image = reprojectToGeographic({
    bbox: [170, 80, 180, 90],
    width: 16,
    height: 8,
    range,
    tile: (x, y) => {
      seen.push([x, y]);
      return opaque;
    },
  });
  assert.ok(seen.every(([x]) => x >= range.x0 && x <= range.x1));
  // Top row is at ~89.4 N: outside coverage, alpha 0.
  assert.equal(image[3], 0);
  // Bottom row is at ~80.6 N: inside coverage, drawn.
  assert.equal(image[7 * 16 * 4 + 3], 200);
});

test('a missing source tile leaves its pixels transparent', () => {
  const range = mercatorTileRange([-10, -10, 10, 10], 1);
  const image = reprojectToGeographic({
    bbox: [-10, -10, 10, 10],
    width: 4,
    height: 2,
    range,
    tile: () => null,
  });
  assert.ok(image.every((value) => value === 0));
});

test('a full-width bbox at the dateline never requests an out-of-range tile column', () => {
  for (const z of [0, 1, 2]) {
    const range = mercatorTileRange(
      [-180, -MERCATOR_MAX_LAT, 180, MERCATOR_MAX_LAT],
      z,
    );
    assert.equal(range.x1, 2 ** z - 1);
    assert.ok(range.x0 >= 0 && range.x1 <= 2 ** z - 1);
  }
});

// The per-pixel reprojection as first written, kept to prove the faster
// one (per-column terms computed once) is byte-identical.
function perPixelReference({ bbox, width, height, range, tile }) {
  const [west, south, east, north] = bbox;
  const { z, x0, x1, y0, y1 } = range;
  const mw = (x1 - x0 + 1) * 256;
  const mh = (y1 - y0 + 1) * 256;
  const mosaic = new Uint8Array(mw * mh * 4);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const pixels = tile(tx, ty);
      if (!pixels) continue;
      for (let r = 0; r < 256; r++)
        mosaic.set(
          pixels.subarray(r * 1024, (r + 1) * 1024),
          (((ty - y0) * 256 + r) * mw + (tx - x0) * 256) * 4,
        );
    }
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const lat = north - ((row + 0.5) / height) * (north - south);
    if (Math.abs(lat) > MERCATOR_MAX_LAT) continue;
    const py = Math.min(
      mh - 1,
      Math.max(0, mercatorY(lat, z) - y0 * 256 - 0.5),
    );
    const yi = Math.min(mh - 2, Math.floor(py));
    const fy = py - yi;
    for (let col = 0; col < width; col++) {
      const lon = west + ((col + 0.5) / width) * (east - west);
      const px = Math.min(
        mw - 1,
        Math.max(0, mercatorX(lon, z) - x0 * 256 - 0.5),
      );
      const xi = Math.min(mw - 2, Math.floor(px));
      const fx = px - xi;
      const a = (yi * mw + xi) * 4;
      const c = a + mw * 4;
      const o = (row * width + col) * 4;
      for (let k = 0; k < 4; k++)
        out[o + k] =
          (mosaic[a + k] * (1 - fx) + mosaic[a + 4 + k] * fx) * (1 - fy) +
          (mosaic[c + k] * (1 - fx) + mosaic[c + 4 + k] * fx) * fy;
    }
  }
  return out;
}

test('reprojection matches the per-pixel result byte for byte on a random mosaic', () => {
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) & 255;
  };
  for (const [bbox, width, height] of [
    [[-120, 10, -84, 28], 1024, 512],
    [[-180, -90, 180, 90], 512, 256],
    [[-108.25, 16.5, -102.75, 19.25], 333, 167],
  ]) {
    const range = chooseMercatorZoom(bbox, width, { maxZoom: 9, maxTiles: 9 });
    const tiles = new Map();
    for (let y = range.y0; y <= range.y1; y++)
      for (let x = range.x0; x <= range.x1; x++) {
        // One tile missing, to cover the transparent path.
        if (x === range.x1 && y === range.y0) continue;
        tiles.set(
          `${x}/${y}`,
          Uint8Array.from({ length: 256 * 256 * 4 }, random),
        );
      }
    const input = {
      bbox,
      width,
      height,
      range,
      tile: (x, y) => tiles.get(`${x}/${y}`) ?? null,
    };
    assert.deepEqual(
      Buffer.from(reprojectToGeographic(input)),
      Buffer.from(perPixelReference(input)),
      bbox.join(','),
    );
  }
});
