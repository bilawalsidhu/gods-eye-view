import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAtcChannel } from '../sdr/atcChannels.js';
import { atcAirportsForAircraft } from './airportAtcChannels.js';

test('a position-checked route resolves IATA and ICAO names across the catalog', () => {
  const route = { from: 'JFK', to: ' ksfo ', verified: true };
  const airports = atcAirportsForAircraft({ route });
  assert.deepEqual(
    airports.map(({ code }) => code),
    ['KJFK', 'KSFO'],
  );
  assert.ok(
    airports
      .flatMap(({ channels }) => channels)
      .every(([, label]) => parseAtcChannel(label)),
  );

  const [las] = atcAirportsForAircraft({
    route: { from: 'LAS', to: 'KLAS', verified: true },
  });
  assert.deepEqual(las.channels, [
    ['APP', '125.025'],
    ['TWR', '119.900'],
  ]);
});

test('missing and unverified routes fall back to the nearby airport', () => {
  const [nearby] = atcAirportsForAircraft({
    route: { from: 'LAS', verified: false },
    lat: 40.6394,
    lon: -73.7793,
  });
  assert.equal(nearby.code, 'KJFK');
  assert.equal(nearby.nearby, true);
  assert.deepEqual(atcAirportsForAircraft({ lat: 0, lon: -125 }), []);
  assert.deepEqual(atcAirportsForAircraft({}), []);
});

test('known outdated Budapest presets are replaced by the official reference', () => {
  const [budapest] = atcAirportsForAircraft({
    route: { from: 'BUD', verified: true },
  });
  assert.equal(budapest.code, 'LHBP');
  assert.deepEqual(budapest.channels, []);
  assert.match(budapest.source, /hungarocontrol\.hu/);
});
