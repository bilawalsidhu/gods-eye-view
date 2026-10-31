import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCoordinate,
  parseDepthMeters,
  normalizeVentRecord,
  normalizeVentSnapshot,
  normalizeDiveRecord,
  normalizeDiveSnapshot,
  normalizeDiveTrackRecord,
  normalizeBathymetryConfig,
} from './records.js';
import { FEATURE_KINDS } from './model.js';

test('isValidCoordinate validates standard latitude and longitude boundaries', () => {
  assert.equal(isValidCoordinate(0, 0), true);
  assert.equal(isValidCoordinate(-180, -90), true);
  assert.equal(isValidCoordinate(180, 90), true);
  assert.equal(isValidCoordinate(-156.757, 19.902), true);

  // Invalid coordinates
  assert.equal(isValidCoordinate(-180.1, 0), false);
  assert.equal(isValidCoordinate(180.1, 0), false);
  assert.equal(isValidCoordinate(0, -90.1), false);
  assert.equal(isValidCoordinate(0, 90.1), false);
  assert.equal(isValidCoordinate(NaN, 0), false);
  assert.equal(isValidCoordinate(0, Infinity), false);
  assert.equal(isValidCoordinate(null, undefined), false);
});

test('parseDepthMeters extracts numeric values and ranges correctly', () => {
  assert.equal(parseDepthMeters(2500), 2500);
  assert.equal(parseDepthMeters(-3200), 3200);
  assert.equal(parseDepthMeters('1500'), 1500);
  assert.equal(parseDepthMeters('500-382'), 500);
  assert.equal(parseDepthMeters('60-0'), 60);
  assert.equal(parseDepthMeters('unknown'), null);
  assert.equal(parseDepthMeters(''), null);
  assert.equal(parseDepthMeters(null), null);
});

test('normalizeVentRecord parses valid hydrothermal vent entries', () => {
  const raw = {
    id: 'vent-42',
    name: 'Endeavour Segment Vents',
    lon: -129.098,
    lat: 47.948,
    activity: 'active',
    depthM: 2190,
    tectonicSetting: 'MOR',
    spreadingRate: 'intermediate',
  };

  const norm = normalizeVentRecord(raw);
  assert.ok(norm);
  assert.equal(norm.id, 'vent-42');
  assert.equal(norm.kind, FEATURE_KINDS.VENT);
  assert.equal(norm.name, 'Endeavour Segment Vents');
  assert.equal(norm.lon, -129.098);
  assert.equal(norm.lat, 47.948);
  assert.equal(norm.depthM, 2190);
  assert.equal(norm.activity, 'active');
  assert.equal(norm.tectonicSetting, 'MOR');
  assert.equal(norm.source, 'NOAA PMEL Earth-Ocean Interactions');
});

test('normalizeVentRecord handles missing and malformed fields gracefully', () => {
  // Missing coordinates drops record
  assert.equal(normalizeVentRecord({ name: 'Phantom Vent' }), null);
  assert.equal(normalizeVentRecord({ lon: 'not-a-number', lat: 20 }), null);
  assert.equal(normalizeVentRecord({ lon: 200, lat: 20 }), null);

  // Missing optional metadata falls back to clean defaults
  const minimal = normalizeVentRecord({ lon: 10, lat: 20 });
  assert.ok(minimal);
  assert.equal(minimal.name, 'Unnamed Hydrothermal Vent');
  assert.equal(minimal.activity, 'unconfirmed');
  assert.equal(minimal.depthM, null);
  assert.equal(minimal.tectonicSetting, 'Unknown');
});

test('normalizeVentSnapshot filters invalid rows and de-duplicates IDs', () => {
  const input = [
    { id: 'v1', lon: 10, lat: 20, activity: 'active' },
    { id: 'v1', lon: 11, lat: 21, activity: 'inactive' }, // duplicate id
    { id: 'v2', lon: 999, lat: 0 }, // invalid coord
    null,
    { id: 'v3', lon: -45.5, lat: 23.3, activity: 'unconfirmed' },
  ];

  const snapshot = normalizeVentSnapshot(input);
  assert.ok(Array.isArray(snapshot));
  assert.equal(snapshot.length, 3);
  assert.equal(snapshot[0].id, 'v1');
  assert.equal(snapshot[1].id, 'v1-2'); // de-duplicated
  assert.equal(snapshot[2].id, 'v3');
  assert.equal(normalizeVentSnapshot(null), null);
  assert.equal(normalizeVentSnapshot({}), null);
});

test('normalizeDiveRecord normalizes NOAA Ocean Exploration ROV dive features', () => {
  const raw = {
    attributes: {
      OBJECTID: 101,
      cruise_id: 'EX1605L3',
      dive_id: 'DIVE12',
      cruise_dive_id: 'EX1605L3_DIVE12',
      vessel: 'NOAA Ship Okeanos Explorer',
      platform: 'Deep Discoverer',
      Year: 2016,
      Cruise: 'Deepwater Wonders of Wake',
      MaxDepth: 3140,
      Summary: 'Exploration of deep seamounts in Wake Atoll unit of PRIMNM.',
      OE_Link: 'https://oceanexplorer.noaa.gov/okeanos/explorations/ex1605/',
    },
    geometry: {
      x: 166.5,
      y: 19.3,
    },
  };

  const norm = normalizeDiveRecord(raw);
  assert.ok(norm);
  assert.equal(norm.id, 'dive-EX1605L3_DIVE12');
  assert.equal(norm.kind, FEATURE_KINDS.DIVE);
  assert.equal(norm.cruiseId, 'EX1605L3');
  assert.equal(norm.diveId, 'DIVE12');
  assert.equal(norm.vessel, 'NOAA Ship Okeanos Explorer');
  assert.equal(norm.platform, 'Deep Discoverer');
  assert.equal(norm.year, 2016);
  assert.equal(norm.lon, 166.5);
  assert.equal(norm.lat, 19.3);
  assert.equal(norm.depthM, 3140);
  assert.ok(norm.summary.includes('Wake Atoll'));
  assert.equal(norm.expeditionUrl, 'https://oceanexplorer.noaa.gov/okeanos/explorations/ex1605/');
});

test('normalizeDiveTrackRecord parses polyline paths and drops invalid vertices', () => {
  const raw = {
    attributes: {
      CruiseDiveID: 'EX1605L3_DIVE12',
      Shape__Length: 1250.5,
    },
    geometry: {
      paths: [
        [
          [166.501, 19.301],
          [166.502, 19.303],
          [999, 999], // bad vertex discarded
          [166.504, 19.305],
        ],
      ],
    },
  };

  const track = normalizeDiveTrackRecord(raw);
  assert.ok(track);
  assert.equal(track.cruiseDiveId, 'EX1605L3_DIVE12');
  assert.equal(track.lengthM, 1251);
  assert.equal(track.paths.length, 1);
  assert.equal(track.paths[0].length, 3); // invalid vertex was omitted
  assert.deepEqual(track.paths[0][0], [166.501, 19.301]);

  // Invalid polyline with < 2 valid coordinates returns null
  assert.equal(normalizeDiveTrackRecord({ geometry: { paths: [[[10, 20]]] } }), null);
  assert.equal(normalizeDiveTrackRecord(null), null);

  // Antimeridian crossing splits path into separate segments
  const antimeridianTrack = normalizeDiveTrackRecord({
    attributes: { CruiseDiveID: 'EX_AM_01' },
    geometry: {
      paths: [
        [
          [179.9, 10.0],
          [179.95, 10.05],
          [-179.95, 10.05], // crosses 180
          [-179.9, 10.0],
        ],
      ],
    },
  });
  assert.ok(antimeridianTrack);
  assert.equal(antimeridianTrack.paths.length, 2);
  assert.equal(antimeridianTrack.paths[0].length, 2);
  assert.equal(antimeridianTrack.paths[1].length, 2);
});

test('normalizeBathymetryConfig validates GEBCO parameters', () => {
  const config = normalizeBathymetryConfig();
  assert.equal(config.url, 'https://wms.gebco.net/mapserv?');
  assert.equal(config.layer, 'GEBCO_LATEST_2');
  assert.equal(config.format, 'image/jpeg');
  assert.ok(config.credit.includes('GEBCO'));
});
