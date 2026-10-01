// src/data/aircraftEmergencyAnalyst.test.mjs
// Source-to-analyst fixture: an OpenSky state vector squawking 7700 and an
// adsb.lol (readsb) aircraft whose ADS-B `emergency` field says `general`
// on an ordinary code must reach the analyst with the same kind but distinct
// provenance, so a summary never flattens one into the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSkySnapshot, readsbSnapshot } from '../sources/live/index.js';
import { FlightRecords } from '../layers/flights/records.js';
import { MilitaryFlightRecords } from '../layers/military/records.js';
import { mapAnalystRecord as mapFlight } from './flights.js';
import { mapAnalystRecord as mapMilitary } from './militaryFlights.js';
import { createAnalystEngine } from './analystEngine.js';

const NOW_MS = 1800000000000;

// OpenSky /states/all: [icao24, callsign, origin_country, time_position,
// last_contact, lon, lat, baro_alt, on_ground, velocity, true_track,
// vertical_rate, sensors, geo_alt, squawk, spi, position_source, category].
const OPENSKY = {
  time: NOW_MS / 1000,
  states: [
    [
      'a1b2c3',
      'SWA696  ',
      'United States',
      NOW_MS / 1000 - 6,
      NOW_MS / 1000 - 3,
      -97.67,
      30.19,
      3000,
      false,
      150,
      180,
      -5,
      null,
      3040,
      '7700',
      false,
      0,
      4,
    ],
  ],
};

// adsb.lol /v2/mil: readsb aircraft with `seen`/`seen_pos` ages in seconds.
const ADSB_LOL = {
  ac: [
    {
      hex: 'ae01ce',
      flight: 'RCH123  ',
      t: 'C17',
      lat: 31.1,
      lon: -97.4,
      alt_baro: 18000,
      gs: 300,
      track: 90,
      squawk: '1200',
      emergency: 'general',
      seen: 1.5,
      seen_pos: 2,
    },
  ],
};

function civilAnalystRecord() {
  const [row] = openSkySnapshot(OPENSKY, { now: NOW_MS }).records;
  const store = new FlightRecords({
    geoidHeight: () => 0,
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
    approxDistanceKm: () => 0,
  });
  const { meta } = store.receive(row, {
    viewerLatDeg: null,
    viewerLonDeg: null,
    trackedId: null,
    floorWarmPoints: [],
  });
  return mapFlight(row.id, meta);
}

function militaryAnalystRecord() {
  const [row] = readsbSnapshot(ADSB_LOL, {
    observedAtMs: NOW_MS,
    now: NOW_MS,
  }).records;
  const store = new MilitaryFlightRecords({
    geoidHeight: () => 0,
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
  });
  const { meta } = store.receive(row, {
    observedAtMs: NOW_MS,
    floorWarmPoints: [],
    modelOwnsVisual: false,
  });
  return mapMilitary(row.id, meta);
}

test('OpenSky 7700 and adsb.lol emergency=general differ only in provenance', () => {
  const civil = civilAnalystRecord();
  const military = militaryAnalystRecord();

  assert.equal(civil.emergency, true);
  assert.equal(civil.emergencyKind, 'general');
  assert.equal(civil.squawk, '7700');
  assert.equal(civil.emergencySource, 'squawk');
  assert.equal(
    civil.emergencyBroadcast,
    'broadcasting squawk 7700 (general emergency)',
  );
  assert.equal(civil.observedAtMs, NOW_MS - 3000, 'OpenSky last_contact');

  assert.equal(military.emergency, true);
  assert.equal(military.emergencyKind, 'general');
  assert.equal(military.squawk, '1200', 'the code is not an emergency code');
  assert.equal(military.emergencySource, 'ads-b');
  assert.equal(military.emergencyBroadcast, 'ADS-B reports general emergency');
  assert.equal(military.observedAtMs, NOW_MS - 1500, 'snapshot time - seen');
});

test('the analyst can filter emergencies by source', async () => {
  const records = {
    flights: [civilAnalystRecord()],
    military: [militaryAnalystRecord()],
  };
  const engine = createAnalystEngine({
    getRecords: (key) => records[key] || [],
    resolveRegionRing: async () => null,
    getViewContext: () => ({ lat: 30.5, lon: -97.5, viewRadiusKm: 500 }),
  });
  const query = (value) =>
    engine.query({
      layers: ['flights', 'military'],
      scope: { kind: 'anywhere' },
      filters: [
        { field: 'emergency', op: 'eq', value: true },
        { field: 'emergencySource', op: 'eq', value },
      ],
    });
  const bySquawk = await query('squawk');
  assert.deepEqual(
    bySquawk.items.map((item) => [item.icao24, item.emergencyBroadcast]),
    [['a1b2c3', 'broadcasting squawk 7700 (general emergency)']],
  );
  const byAdsb = await query('ads-b');
  assert.deepEqual(
    byAdsb.items.map((item) => [item.icao24, item.emergencyBroadcast]),
    [['ae01ce', 'ADS-B reports general emergency']],
  );
});
