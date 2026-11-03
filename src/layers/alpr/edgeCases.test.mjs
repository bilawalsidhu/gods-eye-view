import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import * as geo from '../../geo/index.js';
import { tilesForBounds, tileToBBox } from '../../data/tomtomTiles.js';
import { alprDetailZoom, createAlprTileSource } from './source.js';
import { validateAlprSnapshot } from './model.js';
import { directionWedgePositions } from './visuals.js';
import { decodeAlprTile } from './tileRecords.js';
import { DIRECTION_CONE_HALF_ANGLE_DEG } from './policy.js';

const EXTENT = 4096;
const box = { south: 30.25, north: 30.3, west: -97.8, east: -97.7 };

/** Encode one `cameras` layer holding point features (MVT 2.1). */
function encodeCameraTile(points) {
  const keys = [];
  const values = [];
  const index = (list, value) => {
    const at = list.indexOf(value);
    return at === -1 ? list.push(value) - 1 : at;
  };
  const zigzag = (n) => (n << 1) ^ (n >> 31);
  const features = points.map(({ x, y, properties }) => {
    const tags = [];
    for (const [key, value] of Object.entries(properties))
      tags.push(index(keys, key), index(values, String(value)));
    return { tags, geometry: [9, zigzag(x), zigzag(y)] };
  });
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_layer, out) => {
    out.writeVarintField(15, 2);
    out.writeStringField(1, 'cameras');
    for (const feature of features)
      out.writeMessage(2, (_f, w) => {
        w.writePackedVarint(2, feature.tags);
        w.writeVarintField(3, 1);
        w.writePackedVarint(4, feature.geometry);
      });
    for (const key of keys) out.writeStringField(3, key);
    for (const value of values)
      out.writeMessage(4, (_v, w) => w.writeStringField(1, value));
    out.writeVarintField(5, EXTENT);
  });
  return pbf.finish();
}

const metadata = (country) => ({
  tiles: [
    `https://tiles.dontgetflocked.com/cameras-${country}-hourly/{z}/{x}/{y}.mvt`,
  ],
  bounds: country === 'ca' ? [-124, 42, -63, 54] : [-160, 17, -64, 59],
});

/** Initial great-circle bearing from one Cartesian to another, in degrees. */
function bearingDeg(from, to) {
  const a = geo.cartographic.fromCartesian(from);
  const b = geo.cartographic.fromCartesian(to);
  const dLon = b.longitude - a.longitude;
  const y = Math.sin(dLon) * Math.cos(b.latitude);
  const x =
    Math.cos(a.latitude) * Math.sin(b.latitude) -
    Math.sin(a.latitude) * Math.cos(b.latitude) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

test('edge:alpr-cameras: a camera on a tile edge is one record with its own azimuth', async () => {
  const zoom = alprDetailZoom(box);
  const tiles = tilesForBounds(box, zoom, { maxTiles: 17 });
  // Two horizontally adjacent tiles of one row share the camera's meridian.
  const west = tiles.find((tile) =>
    tiles.some((other) => other.x === tile.x + 1 && other.y === tile.y),
  );
  const east = { x: west.x + 1, y: west.y };
  const edgeLon = tileToBBox(zoom, west.x, west.y).east;
  assert.equal(edgeLon, tileToBBox(zoom, east.x, east.y).west);
  const camera = {
    osmType: 'node',
    osmId: 424242,
    direction: 135,
    brand: 'Fixture',
  };
  const bytes = new Map([
    [
      `${west.x}/${west.y}`,
      encodeCameraTile([{ x: EXTENT, y: 2048, properties: camera }]),
    ],
    [
      `${east.x}/${east.y}`,
      encodeCameraTile([{ x: 0, y: 2048, properties: camera }]),
    ],
  ]);
  // Both tiles really carry the camera, at the same longitude.
  const decoded = [west, east].map(
    ({ x, y }) => decodeAlprTile(bytes.get(`${x}/${y}`), zoom, x, y)[0],
  );
  assert.deepEqual(
    decoded.map((r) => r.id),
    ['alpr:424242', 'alpr:424242'],
  );
  assert.equal(decoded[0].longitude, decoded[1].longitude);
  const source = createAlprTileSource({
    tileFetchImpl: async (url) => {
      if (url.endsWith('.json'))
        return Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'));
      const [, x, y] = url.match(/\/\d+\/(\d+)\/(\d+)\.mvt$/);
      return new Response(bytes.get(`${x}/${y}`) ?? encodeCameraTile([]));
    },
  });
  const snapshot = validateAlprSnapshot(await source.fetch(box));
  const matches = snapshot.records.filter((r) => r.id === 'alpr:424242');
  assert.equal(matches.length, 1);
  assert.equal(snapshot.records.length, 1);
  const [record] = matches;
  assert.ok(Math.abs(record.longitude - edgeLon) < 1e-9);
  assert.equal(record.directionDeg, 135);

  // The bearing wedge is centred on the tagged azimuth.
  const [apex, left, right] = directionWedgePositions(record);
  const leftDeg = bearingDeg(apex, left);
  const rightDeg = bearingDeg(apex, right);
  assert.ok(Math.abs(leftDeg - (135 - DIRECTION_CONE_HALF_ANGLE_DEG)) < 0.01);
  assert.ok(Math.abs(rightDeg - (135 + DIRECTION_CONE_HALF_ANGLE_DEG)) < 0.01);

  // A repeat read (the other engine's scene) keeps the same identity.
  const again = await source.fetch(box);
  assert.deepEqual(
    again.records.map((r) => [r.id, r.latitude, r.longitude, r.directionDeg]),
    [[record.id, record.latitude, record.longitude, record.directionDeg]],
  );
});
