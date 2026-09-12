import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStopsTxt } from './gtfsStopsTable.js';

test('columns are located by header, not by position', () => {
  const t = parseStopsTxt('stop_lon,stop_name,stop_id,stop_lat\n4.48,Delft,A,52.01\n');
  assert.deepEqual(t.get('A'), { lat: 52.01, lon: 4.48, name: 'Delft' });
});

test('a quoted comma in a stop name does not shift the coordinates', () => {
  const t = parseStopsTxt('stop_id,stop_name,stop_lat,stop_lon\nA,"Delft, Zuid",52.01,4.48\n');
  assert.equal(t.get('A').name, 'Delft, Zuid');
  assert.equal(t.get('A').lat, 52.01);
});

test('null island is refused, and so is an unparseable coordinate', () => {
  // 0,0 is where every bad export lands and no stop is there.
  assert.equal(parseStopsTxt('stop_id,stop_lat,stop_lon\nA,0,0\n').size, 0);
  assert.equal(parseStopsTxt('stop_id,stop_lat,stop_lon\nA,,4.4\n').size, 0);
  assert.equal(parseStopsTxt('stop_id,stop_lat,stop_lon\nA,91,4.4\n').size, 0);
  assert.equal(parseStopsTxt('stop_id,stop_lat,stop_lon\nA,52,181\n').size, 0);
});

test('a valid neighbour of a rejected row still lands', () => {
  const t = parseStopsTxt('stop_id,stop_lat,stop_lon\nA,0,0\nB,52.01,4.48\n');
  assert.equal(t.size, 1);
  assert.ok(t.has('B'));
});

test('a header without coordinates yields nothing rather than guessing', () => {
  assert.equal(parseStopsTxt('stop_id,stop_name\nA,Delft\n').size, 0);
  assert.equal(parseStopsTxt('').size, 0);
  assert.equal(parseStopsTxt(null).size, 0);
});

test('a missing stop_name is an empty string, never undefined', () => {
  const t = parseStopsTxt('stop_id,stop_lat,stop_lon\nA,52.01,4.48\n');
  assert.equal(t.get('A').name, '');
});
