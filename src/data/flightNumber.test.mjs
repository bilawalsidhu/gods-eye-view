import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callsignMatchesFlight,
  flightCallsignCandidates,
  parseFlightNumberQuery,
} from './flightNumber.js';

// Synthetic airline: IATA ZX, ICAO ZXY.
const ZX = { name: 'Example Airline', iata: 'ZX', icao: 'ZXY' };

test('IATA and ICAO spellings of one flight parse to the same callsign', () => {
  for (const text of ['ZX123', 'zx 123', 'ZX-123', ' ZX0123 ', 'ZXY123', 'zxy 123']) {
    const flight = parseFlightNumberQuery(text);
    assert.ok(flight, text);
    assert.deepEqual(flightCallsignCandidates(flight, [ZX]), ['ZXY123'], text);
  }
});

test('the parsed flight keeps its kind, designator and display label', () => {
  assert.deepEqual(parseFlightNumberQuery('a3 602'), {
    kind: 'iata',
    designator: 'A3',
    number: '602',
    suffix: '',
    label: 'A3 602',
  });
  assert.deepEqual(parseFlightNumberQuery('BAW12A'), {
    kind: 'icao',
    designator: 'BAW',
    number: '12',
    suffix: 'A',
    label: 'BAW12A',
  });
});

test('text that is not a flight number does not parse', () => {
  for (const text of [
    '',
    'London',
    'Heathrow',
    '12 345',
    '40.7, -74.0',
    'ZX',
    'ZX 12345',
    'ZX 0',
    'ABCD123',
    'ZX 123 London',
  ]) {
    assert.equal(parseFlightNumberQuery(text), null, text);
  }
});

test('a reassigned IATA code yields one callsign per airline holding it', () => {
  const flight = parseFlightNumberQuery('ZX 7');
  const candidates = flightCallsignCandidates(flight, [
    ZX,
    { name: 'Former Example', iata: 'ZX', icao: 'ZXO' },
    { name: 'Other code', iata: 'QY', icao: 'QYQ' },
    { name: 'No ICAO', iata: 'ZX', icao: '' },
  ]);
  assert.deepEqual(candidates, ['ZXY7', 'ZXO7']);
});

test('an IATA flight without a known airline yields no callsign', () => {
  assert.deepEqual(flightCallsignCandidates(parseFlightNumberQuery('ZX 7')), []);
});

test('callsigns match exactly, ignoring case and feed padding, never by prefix', () => {
  assert.equal(callsignMatchesFlight('ZXY123  ', ['ZXY123']), true);
  assert.equal(callsignMatchesFlight('zxy123', ['ZXY123']), true);
  assert.equal(callsignMatchesFlight('ZXY1234', ['ZXY123']), false);
  assert.equal(callsignMatchesFlight('ZXY12', ['ZXY123']), false);
  assert.equal(callsignMatchesFlight(null, ['ZXY123']), false);
});
