import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeByIcao, parseOpenFlightsAirlines } from './source.js';

const dat = [
  '-1,"Unknown",\\N,"-","N/A",\\N,\\N,"Y"',
  '1,"Private flight",\\N,"-","N/A","","","Y"',
  '2,"135 Airways",\\N,"","GNL","GENERAL","United States","N"',
  '3,"1Time Airline",\\N,"1T","RNX","NEXTIME","South Africa","Y"',
  '4,"Bad iata",\\N,"X","abc","","","Y"',
  '5,"Four letters",\\N,"","ABCD","","","Y"',
  '6,"Lower",\\N,"","abc","","","Y"',
].join('\n');

test('parseOpenFlightsAirlines keeps rows with a three-letter upper-case designator', () => {
  const rows = parseOpenFlightsAirlines(dat);
  assert.deepEqual(
    rows.map((r) => r.icao),
    ['GNL', 'RNX'],
  );
  assert.deepEqual(rows[1], {
    id: 3,
    name: '1Time Airline',
    iata: '1T',
    icao: 'RNX',
    callsign: 'NEXTIME',
    country: 'South Africa',
    active: true,
  });
  assert.equal(rows[0].iata, null);
  assert.equal(rows[0].active, false);
});

test('parseOpenFlightsAirlines nulls an absent iata, callsign and country', () => {
  const [row] = parseOpenFlightsAirlines(
    '9,"X Air",\\N,"-","XAA","\\N","N/A","Y"',
  );
  assert.deepEqual([row.iata, row.callsign, row.country], [null, null, null]);
});

test('dedupeByIcao prefers an active row, then the lowest id, and counts what it drops', () => {
  const { kept, collapsed } = dedupeByIcao([
    { id: 5, icao: 'AAA', active: false },
    { id: 9, icao: 'AAA', active: true },
    { id: 7, icao: 'AAA', active: true },
    { id: 3, icao: 'BBB', active: false },
    { id: 2, icao: 'BBB', active: false },
    { id: 1, icao: 'ABA', active: false },
  ]);
  assert.deepEqual(
    kept.map((r) => [r.icao, r.id]),
    [
      ['AAA', 7],
      ['ABA', 1],
      ['BBB', 2],
    ],
  );
  assert.equal(collapsed, 3);
});
