import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  convexFootprint,
  footprintTiles,
  createReticleFootprint,
} from './footprint.js';
import { tileToBBox, tilesForBounds } from '../../data/tomtomTiles.js';
import { outsideDetailTiles } from './source.js';

test('footprint selection excludes bbox corners and orders tiles nearest first', () => {
  const polygon = convexFootprint([
    [0, 0],
    [0.15, 0],
    [0, 0.15],
    [0.01, 0.01],
  ]);
  const tiles = footprintTiles(polygon, 12, { lat: 0, lon: 0 });
  const bbox = tilesForBounds(
    { west: 0, east: 0.15, south: 0, north: 0.15 },
    12,
  );
  assert.ok(tiles.length < bbox.length);
  const b = tileToBBox(tiles[0].z, tiles[0].x, tiles[0].y);
  assert.ok(b.west <= 0 && b.east >= 0 && b.south <= 0 && b.north >= 0);
});

test('oblique horizon bearings are bounded and tile caps hold at city latitudes', () => {
  for (const [lat, lon] of [
    [24.964, 55.037],
    [30.2672, -97.7431],
    [51.507, -0.128],
    [70, 10],
  ]) {
    const camera = {
      positionCartographic: Cesium.Cartographic.fromDegrees(lon, lat, 300),
      heading: 0,
      pitch: -Math.PI / 12,
      pickEllipsoid(p, e, result) {
        if (p.y < 300) return undefined;
        return Cesium.Cartesian3.fromDegrees(
          lon + (p.x - 640) / 100000,
          lat + (800 - p.y) / 50000,
          0,
          e,
          result,
        );
      },
      getPickRay(p, ray) {
        ray.direction.x =
          -Math.sin((lat * Math.PI) / 180) * Math.cos((lon * Math.PI) / 180);
        ray.direction.y =
          -Math.sin((lat * Math.PI) / 180) * Math.sin((lon * Math.PI) / 180);
        ray.direction.z = Math.cos((lat * Math.PI) / 180);
        return ray;
      },
    };
    const result = createReticleFootprint()(
      { camera, scene: { canvas: { width: 1280, height: 800 } } },
      300,
    );
    assert.ok(result.coverage.coarse.length <= 16);
    assert.ok(result.coverage.detail.length <= 16);
    assert.ok(
      result.north > lat + 0.04,
      'upper footprint extends past old fixed box',
    );
    assert.ok(result.coverage.rangeKm <= 10);
  }
});

test('coarse roads retain far segments but never duplicate a detailed tile core', () => {
  const tile = { z: 14, x: 8192, y: 8192 },
    b = tileToBBox(tile.z, tile.x, tile.y);
  const y = (b.south + b.north) / 2;
  const roads = outsideDetailTiles(
    [
      {
        coordinates: [
          [b.west - 0.01, y],
          [b.east + 0.01, y],
        ],
        type: 'primary',
      },
    ],
    [tile],
  );
  assert.equal(roads.length, 2);
  assert.equal(roads[0].coordinates.at(-1)[0], b.west);
  assert.equal(roads[1].coordinates[0][0], b.east);
});
