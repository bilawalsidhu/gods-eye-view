import assert from 'node:assert/strict';
import test from 'node:test';
import { gridBounds, gridToLatLon, isValidGrid, latLonToGrid } from './maidenhead.js';

test('validation accepts 2/4/6/8 characters and rejects placeholders', () => {
  for (const ok of ['JO', 'JO32', 'JO32me', 'jo32ME', 'JO32me12', 'RR99xx99', 'AA00aa00']) assert.equal(isValidGrid(ok), true, ok);
  for (const bad of ['', 'J', 'JO3', 'JO32m', 'ZZ00', 'JO32yy', 'JJ00AA', 'jj00aa', 'JO32me1', '-', 'JO32ME123']) assert.equal(isValidGrid(bad), false, bad);
});

test('grid centres match the published cell geometry', () => {
  const jo = gridToLatLon('JO');
  assert.deepEqual(jo, { lat: 55, lon: 10 });
  const jo32 = gridToLatLon('JO32');
  assert.deepEqual(jo32, { lat: 52.5, lon: 7 });
  const jo32me = gridToLatLon('JO32me');
  assert.ok(Math.abs(jo32me.lat - (52 + 4 / 24 + 1 / 48)) < 1e-9);
  assert.ok(Math.abs(jo32me.lon - (6 + 12 * (2 / 24) + 1 / 24)) < 1e-9);
  const fn31pr = gridToLatLon('FN31pr');
  assert.ok(Math.abs(fn31pr.lat - 41.729) < 0.01, `W1AW lat ${fn31pr.lat}`);
  assert.ok(Math.abs(fn31pr.lon - (-72.708)) < 0.01, `W1AW lon ${fn31pr.lon}`);
  assert.equal(gridToLatLon('JJ00AA'), null);
  assert.equal(gridToLatLon('nope'), null);
});

test('latLonToGrid round-trips and formats conventionally', () => {
  assert.equal(latLonToGrid(52.1867, 7.04, 6), 'JO32me');
  assert.equal(latLonToGrid(52.1867, 7.04, 4), 'JO32');
  assert.equal(latLonToGrid(52.1867, 7.04, 2), 'JO');
  assert.equal(latLonToGrid(41.714, -72.727, 6), 'FN31pr');
  assert.equal(latLonToGrid(-41.05, 175.6, 6), 'RE78tw');
  assert.equal(latLonToGrid(89.9999, 179.9999, 6), 'RR99xx');
  assert.equal(latLonToGrid(90, 180, 4), 'AR09', 'lon 180 wraps to -180, lat clamps below 90');
  assert.equal(latLonToGrid(NaN, 0), null);
  for (const [lat, lon] of [[52.1867, 7.04], [-33.86, 151.2], [0.01, -0.01], [64.13, -21.9]]) {
    const back = gridToLatLon(latLonToGrid(lat, lon, 8));
    assert.ok(Math.abs(back.lat - lat) < 0.005 && Math.abs(back.lon - lon) < 0.01, `${lat},${lon}`);
  }
});

test('gridBounds spans the cell', () => {
  assert.deepEqual(gridBounds('JO32'), { south: 52, west: 6, north: 53, east: 8 });
  const field = gridBounds('JO');
  assert.deepEqual(field, { south: 50, west: 0, north: 60, east: 20 });
  assert.equal(gridBounds('JJ00AA'), null);
});
