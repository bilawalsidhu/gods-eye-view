import assert from 'node:assert/strict';
import test from 'node:test';
import * as portable from './source.js';
import * as layerModule from './index.js';

test('the portable source composes the station providers; Canada has no AQHI source of its own', () => {
  assert.equal(typeof portable.createAirQualitySource, 'function');
  assert.equal(typeof portable.createAirQualitySnapshotSource, 'function');
  assert.deepEqual(
    portable.createDefaultAirQualityProviders().map((entry) => entry.id),
    ['openaq'],
  );
  // Canada's stations come from OpenAQ like every other country's.
  assert.equal('createEcccAirQualitySource' in portable, false);
  assert.equal('createEcccAirQualitySource' in layerModule, false);
});

test("the layer's model has no AQHI scale left", () => {
  for (const name of [
    'AIR_QUALITY_BANDS',
    'AIR_QUALITY_PROVIDERS',
    'airQualityBandById',
    'airQualityColor',
    'aqhiDisplayValue',
    'bandForValue',
    'bandRiskText',
    'normalizeAqhiObservations',
    'normalizeAqhiStations',
    'valueLabel',
  ])
    assert.equal(name in layerModule, false, name);
});

/** One recent hourly PM2.5 and NO2 reading at a station, as a route answers. */
const snapshotRows = (now) =>
  ['PM2.5', 'NO2'].map((parameter) => ({
    id: `national:1:${parameter}`,
    provider: 'national',
    stationId: '1',
    name: 'Station',
    lat: 28.6,
    lon: 77.2,
    parameter,
    units: 'µg/m³',
    value: 40,
    kind: 'observation',
    averagingMinutes: 60,
    observedMs: now - 10 * 60_000,
  }));

test('a national snapshot keeps its stale status; a stale one is asked again, a fresh one reused', async () => {
  let clock = Date.now(),
    stale = true;
  const urls = [];
  const source = portable.createAirQualitySnapshotSource({
    endpoint: '/api/air-quality/national',
    hourly: true,
    reuseMs: 1_200_000,
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({
        schemaVersion: 1,
        stations: [],
        readings: snapshotRows(clock),
        stale,
      });
    },
  });
  const ask = (parameter = 'PM2.5') => source.getSnapshot({ parameter });
  const readings = await ask('NO2');
  assert.deepEqual(urls, ['/api/air-quality/national']);
  assert.deepEqual(
    readings.map((reading) => [reading.parameter, reading.value]),
    [['NO2', 40]],
  );
  assert.equal(source.getCoverage().stale, true);
  // The route has recovered by the next layer refresh.
  stale = false;
  clock += 60_000;
  await ask();
  assert.equal(urls.length, 2);
  assert.equal(source.getCoverage().stale, false);
  clock += 60_000;
  await ask();
  assert.equal(urls.length, 2, 'a fresh national snapshot is reused');
});

test('an already aborted request does not fetch', async () => {
  const source = portable.createAirQualitySource({
    fetchImpl: () => assert.fail('unexpected fetch'),
  });
  await assert.rejects(
    source.getSnapshot({ provider: 'openaq', signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
});

test('the portable source exports the rating rules a server answering the OpenAQ route uses', async () => {
  const usAqi = await import('./usAqi.js');
  const interpretation = await import('./interpretation.js');
  assert.equal(portable.aqiStations, usAqi.aqiStations);
  assert.equal(portable.interpretHourly, interpretation.interpretHourly);
});
