import test from 'node:test';
import assert from 'node:assert/strict';
import {
  airlineEntry,
  airlineForCallsign,
  allAirlines,
  buildLookup,
  catalog,
} from './index.js';
import { callsignPrefix, normalizeIcao } from './naming.js';

const fixture = [
  {
    icao: 'SWR',
    iata: 'LX',
    name: 'Swiss International Air Lines',
    callsign: 'SWISS',
    country: 'CH',
    active: true,
    tailColor: '#E30613',
  },
  {
    icao: 'BAW',
    iata: 'BA',
    name: 'British Airways',
    callsign: 'SPEEDBIRD',
    country: 'GB',
    active: true,
    tailColor: null,
  },
];

test('normalizers fold a designator and a callsign prefix', () => {
  assert.equal(normalizeIcao(' swr '), 'SWR');
  assert.equal(normalizeIcao('SW'), '');
  assert.equal(normalizeIcao('SWRX'), '');
  assert.equal(normalizeIcao('S1R'), '');
  assert.equal(normalizeIcao(null), '');
  assert.equal(callsignPrefix('SWR100'), 'SWR');
  assert.equal(callsignPrefix(' baw23g '), 'BAW');
  assert.equal(callsignPrefix('N123AB'), 'N');
  assert.equal(callsignPrefix('ABCD12'), 'ABCD');
  assert.equal(callsignPrefix('123ABC'), '');
  assert.equal(callsignPrefix(undefined), '');
});

test('a designator resolves in any case; anything else is null', () => {
  const lookup = buildLookup(fixture);
  assert.equal(lookup('swr').name, 'Swiss International Air Lines');
  assert.equal(lookup('BAW').iata, 'BA');
  assert.equal(lookup('XXQ'), null);
  assert.equal(lookup('SW'), null);
  assert.equal(lookup('SWRX'), null);
  assert.equal(lookup(''), null);
  assert.equal(lookup(null), null);
});

test('the bundled catalog resolves a callsign to its operator', () => {
  assert.equal(airlineForCallsign('SWR100').icao, 'SWR');
  assert.equal(airlineForCallsign('SWR100').country, 'CH');
  assert.equal(airlineForCallsign('BAW23G').icao, 'BAW');
  assert.equal(airlineForCallsign('baw23g').icao, 'BAW');
  assert.equal(airlineForCallsign('SWR').icao, 'SWR');
  assert.equal(airlineForCallsign('AAL1').name, 'American Airlines');
});

test('a registration, a four-letter prefix, a number or an unknown prefix is null', () => {
  for (const callsign of [
    'N123AB',
    'DEABC',
    'SWRX12',
    '12SWR',
    '',
    '  ',
    null,
    undefined,
    'XXQ999',
  ])
    assert.equal(airlineForCallsign(callsign), null, String(callsign));
});

test('the bundled catalog resolves a designator and carries the curated colour', () => {
  assert.equal(airlineEntry('swr').iata, 'LX');
  assert.equal(airlineEntry('SWR').tailColor, '#E30613');
  assert.equal(airlineEntry('SWR').callsign, 'SWISS');
  assert.equal(airlineEntry('XXQ'), null);
});

test('the catalog is every OpenFlights airline with a designator, sorted by icao', () => {
  assert.equal(allAirlines(), catalog);
  assert.ok(catalog.length >= 5500, `${catalog.length} airlines`);
  const keys = catalog.map((e) => e.icao);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, keys.length);
});

test('every airline country joins a code the country library knows', async () => {
  const { countryEntry } = await import('../countries/index.js');
  for (const entry of catalog)
    if (entry.country !== null)
      assert.ok(countryEntry(entry.country), `${entry.icao} ${entry.country}`);
});
