// The Vélib' feed is served through the GENERIC GBFS path: the operator's
// own station_information and station_status documents, read through the
// same /api/gbfs proxy and the same parser every other city uses.
//
// These cases hold that decision to the documents' ACTUAL shape, so a
// publisher change that breaks the shared parser fails here rather than
// rendering an empty Bike Share row over Paris.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStationInformation,
  parseStationStatus,
} from '../../sources/gbfsStations.js';
import { CITY_BY_ID } from './registry.js';

const STATION_INFORMATION = {
  lastUpdatedOther: 1793129533,
  ttl: 3600,
  data: {
    stations: [
      {
        station_id: 213688169,
        stationCode: '16107',
        name: 'Benjamin Godard - Victor Hugo',
        lat: 48.865983,
        lon: 2.275725,
        capacity: 35,
        station_opening_hours: null,
      },
      {
        station_id: 19179944124,
        stationCode: '40001',
        name: 'Hôpital Mondor',
        lat: 48.798922410229,
        lon: 2.4537451531298,
        capacity: 28,
        station_opening_hours: null,
      },
    ],
  },
};

const STATION_STATUS = {
  lastUpdatedOther: 1793129533,
  ttl: 3600,
  data: {
    stations: [
      {
        station_id: 213688169,
        num_bikes_available: 5,
        numBikesAvailable: 5,
        num_bikes_available_types: [{ mechanical: 3 }, { ebike: 2 }],
        num_docks_available: 29,
        numDocksAvailable: 29,
        is_installed: 1,
        is_returning: 1,
        is_renting: 1,
        last_reported: 1793128830,
        stationCode: '16107',
      },
      {
        station_id: 19179944124,
        num_bikes_available: 25,
        num_bikes_available_types: [{ mechanical: 20 }, { ebike: 5 }],
        num_docks_available: 2,
        is_installed: 1,
        is_returning: 1,
        is_renting: 1,
        last_reported: 1793128779,
      },
    ],
  },
};

test('the Vélib documents parse with the shared GBFS parser', () => {
  const info = parseStationInformation(STATION_INFORMATION);
  const status = parseStationStatus(STATION_STATUS);
  assert.equal(info.size, 2);
  assert.equal(status.size, 2);

  const first = info.get('213688169');
  assert.equal(first.name, 'Benjamin Godard - Victor Hugo');
  assert.equal(first.lat, 48.865983);
  assert.equal(first.lon, 2.275725);
  assert.equal(first.capacity, 35);
  assert.equal(first.isRenting, true);
  assert.equal(first.isReturning, true);

  const live = status.get('213688169');
  assert.equal(live.bikesAvailable, 5);
  assert.equal(live.docksAvailable, 29);
  assert.equal(live.isInstalled, true);
  assert.equal(live.lastReported, 1793128830);
});

test('every Vélib station id in the network document has a live status row', () => {
  // The operator publishes one row per station in both documents, so the two
  // join without a fallback. A publisher change that broke this would leave
  // stations drawn with no availability at all.
  const info = parseStationInformation(STATION_INFORMATION);
  const status = parseStationStatus(STATION_STATUS);
  for (const stationId of info.keys()) {
    assert.ok(status.has(stationId), `no live status for ${stationId}`);
  }
});

test('the Paris entry names the operator feed the parser was checked against', () => {
  const paris = CITY_BY_ID.get('paris-velib');
  assert.ok(paris);
  assert.equal(
    new URL(paris.stationInformationUrl).hostname,
    'velib-metropole-opendata.smovengo.cloud',
  );
  assert.match(paris.stationInformationUrl, /station_information\.json$/);
  assert.match(paris.stationStatusUrl, /station_status\.json$/);
});

