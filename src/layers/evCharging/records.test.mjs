import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { layerWriter } from '../streetLevel/providers/mapillary/coverageFixture.mjs';
import { encodePoiTile } from './poiTileFixture.mjs';
import { lonLatToTile, tileToBBox } from '../../data/tomtomTiles.js';
import {
  CHARGING_TILE_ZOOM,
  decodeChargingTile,
  normalizeChargingFeature,
  planetBuildTime,
} from './records.js';

const AMSTERDAM = lonLatToTile(4.8922, 52.3731, CHARGING_TILE_ZOOM);
const TILE = { z: CHARGING_TILE_ZOOM, ...AMSTERDAM };
const BOX = tileToBBox(TILE.z, TILE.x, TILE.y);

const inside = (u, v) => ({
  lon: BOX.west + (BOX.east - BOX.west) * u,
  lat: BOX.south + (BOX.north - BOX.south) * v,
});

test('a z14 poi tile yields its charging stations and nothing else', () => {
  const bytes = encodePoiTile(TILE, [
    {
      ...inside(0.25, 0.25),
      id: 119416184121,
      class: 'fuel',
      subclass: 'charging_station',
      name: 'TotalEnergies TNLP011391',
      name_en: 'TotalEnergies TNLP011391',
      rank: 22,
    },
    // A petrol station shares the fuel class and must not pass.
    {
      ...inside(0.5, 0.5),
      id: 2,
      class: 'fuel',
      subclass: 'fuel',
      name: 'Shell',
    },
    { ...inside(0.6, 0.6), id: 3, class: 'shop', subclass: 'bakery' },
    // Unnamed in OpenStreetMap: kept, with no name invented for it.
    {
      ...inside(0.75, 0.75),
      class: 'fuel',
      subclass: 'charging_station',
      rank: 216,
    },
  ]);
  const records = decodeChargingTile(bytes, TILE.z, TILE.x, TILE.y);
  assert.equal(records.length, 2);
  const [named, unnamed] = records;
  assert.equal(named.id, 'ev-charging:119416184121');
  assert.equal(named.name, 'TotalEnergies TNLP011391');
  assert.ok(Math.abs(named.longitude - inside(0.25, 0.25).lon) < 1e-4);
  assert.ok(Math.abs(named.latitude - inside(0.25, 0.25).lat) < 1e-4);
  assert.equal(unnamed.name, null);
  // No feature id: the id is scoped to its tile and feature index.
  assert.equal(unnamed.id, `ev-charging:14/${TILE.x}/${TILE.y}:3`);
  assert.deepEqual(Object.keys(named).sort(), [
    'id',
    'latitude',
    'longitude',
    'name',
  ]);
});

test('a station in the tile buffer is left to the tile that contains it', () => {
  const west = BOX.west - (BOX.east - BOX.west) * 0.01;
  const bytes = encodePoiTile(TILE, [
    {
      lon: west,
      lat: inside(0, 0.5).lat,
      id: 7,
      class: 'fuel',
      subclass: 'charging_station',
      name: 'Neighbour',
    },
  ]);
  assert.deepEqual(decodeChargingTile(bytes, TILE.z, TILE.x, TILE.y), []);
});

test('a tile without a poi layer decodes to no stations', () => {
  const layer = layerWriter('water', 4096);
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_, out) => layer.write(out), null);
  assert.deepEqual(
    decodeChargingTile(new Uint8Array(pbf.finish()), TILE.z, TILE.x, TILE.y),
    [],
  );
});

test('a feature becomes a record only as a charging-station point with a position', () => {
  const feature = (properties, geometry) => ({
    id: 5,
    type: 'Feature',
    properties,
    geometry: geometry ?? { type: 'Point', coordinates: [10.75, 59.91] },
  });
  const charging = { class: 'fuel', subclass: 'charging_station' };
  assert.equal(normalizeChargingFeature(feature({ class: 'fuel' }), 'x'), null);
  assert.equal(
    normalizeChargingFeature(
      feature(charging, {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
      'x',
    ),
    null,
  );
  assert.equal(
    normalizeChargingFeature(
      feature(charging, { type: 'Point', coordinates: [NaN, 1] }),
      'x',
    ),
    null,
  );
  // A blank name is no name; the English or international name stands in.
  assert.equal(
    normalizeChargingFeature(feature({ ...charging, name: '  ' }), 'x').name,
    null,
  );
  assert.equal(
    normalizeChargingFeature(
      feature({ ...charging, name: '', name_en: 'Tesla Supercharger' }),
      'x',
    ).name,
    'Tesla Supercharger',
  );
  assert.deepEqual(normalizeChargingFeature(feature(charging), 'x'), {
    id: 'ev-charging:5',
    name: null,
    latitude: 59.91,
    longitude: 10.75,
  });
});

test('the planet build time comes from the versioned tile path', () => {
  assert.equal(
    planetBuildTime(
      'https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf',
    ),
    Date.UTC(2026, 9, 18, 8, 0, 1),
  );
  assert.equal(
    planetBuildTime('https://tiles.example.test/{z}/{x}/{y}.pbf'),
    null,
  );
  assert.equal(planetBuildTime(undefined), null);
});
