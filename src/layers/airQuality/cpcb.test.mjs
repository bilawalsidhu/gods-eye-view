import test from 'node:test';
import assert from 'node:assert/strict';
import { cpcbObservationTime, normalizeCpcbRecords } from './cpcb.js';
import { createAirQualitySource } from './source.js';
import { createAirQualityLayer } from './index.js';

const now = Date.parse('2026-10-18T06:30:00Z');
const row = (patch = {}) => ({
  country: 'India',
  state: 'Delhi',
  city: 'Delhi',
  station: 'Test station',
  latitude: '28.6',
  longitude: '77.2',
  pollutant_id: 'PM2.5',
  pollutant_avg: '123',
  last_update: '18-10-2026 12:00:00',
  ...patch,
});
const normalize = (records) => normalizeCpcbRecords({ records }, { now });

test('OGD dates are IST, independent of host timezone, and invalid dates are rejected', () => {
  assert.equal(cpcbObservationTime('18-10-2026 12:00:00'), now);
  for (const date of [
    '31-02-2026 12:00:00',
    '18-10-2026 24:00:00',
    '',
    null,
    '2026-10-18',
  ])
    assert.equal(cpcbObservationTime(date), null);
});

test('missing values never become zero; stale, future and invalid locations are omitted', () => {
  for (const pollutant_avg of [
    '',
    'NA',
    null,
    undefined,
    ' ',
    -1,
    Infinity,
    true,
  ])
    assert.deepEqual(normalize([row({ pollutant_avg })]), []);
  assert.equal(normalize([row({ pollutant_avg: '0' })])[0].value, 0);
  for (const patch of [
    { latitude: null },
    { longitude: 190 },
    { latitude: '' },
    { last_update: '17-10-2026 12:00:00' },
    { last_update: '19-10-2026 12:00:00' },
  ])
    assert.deepEqual(normalize([row(patch)]), []);
});

test('one pollutant per station, newest wins; reported averages are not labeled AQI', () => {
  const rows = normalize([
    row({ last_update: '18-10-2026 11:00:00' }),
    row({ pollutant_avg: 150 }),
    row({ pollutant_id: 'CO' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 150);
  assert.equal(rows[0].scale, 'PM2.5');
  assert.equal(rows[0].risk, null);
  assert.equal(rows[0].band, null);
  assert.equal(normalize([row(), row({ state: 'Other' })]).length, 2);
  assert.equal(normalizeCpcbRecords({ error: 'denied' }), null);
});

test('source requests the local proxy, forwards stale status and handles missing keys', async () => {
  let status = 200;
  const source = createAirQualitySource({
    now: () => now,
    fetchImpl: async (url) => {
      assert.equal(url, '/api/air-quality/india');
      return Response.json(
        status === 200
          ? { records: [row()], stale: true }
          : { error: 'key_required' },
        { status },
      );
    },
  });
  assert.equal((await source.getSnapshot({ provider: 'cpcb' }))[0].value, 123);
  assert.equal(source.getStatus().stale, true);
  status = 503;
  await assert.rejects(source.getSnapshot({ provider: 'cpcb' }), /API key/);
});

test('an already aborted India request does not fetch', async () => {
  const source = createAirQualitySource({
    fetchImpl: () => assert.fail('unexpected fetch'),
  });
  await assert.rejects(
    source.getSnapshot({ provider: 'cpcb', signal: AbortSignal.abort() }),
  );
});

test('switching provider clears old markers and a late Canadian response cannot replace India', async () => {
  let release;
  const source = {
    providers: ['eccc', 'cpcb'],
    getSnapshot: async ({ provider }) =>
      provider === 'cpcb'
        ? normalize([row()])
        : new Promise((resolve) => {
            release = resolve;
          }),
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.enable();
  const pending = layer.update();
  layer.setParams({ provider: 'cpcb' });
  await layer.update();
  release([]);
  await pending;
  assert.equal(layer.getAnalystRecords()[0].provider, 'cpcb');
  assert.equal(layer.getStats().count, 1);
  assert.deepEqual(layer.getRowControls().legend, []);
  assert.equal(layer.getParams().provider, 'cpcb');
  assert.match(layer.getRowControls().summary.detail, /not an overall AQI/);
  layer.destroy();
});

test('missing India credentials keep provider controls accessible and error visible', async () => {
  const source = {
    providers: ['eccc', 'cpcb'],
    getSnapshot: async () => {
      throw new Error('India air quality requires a data.gov.in API key');
    },
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.setParams({ provider: 'cpcb' });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.match(layer.getStats().error, /API key/);
  assert.ok(
    layer
      .getRowControls()
      .summary.actions.some(
        (action) => action.id === 'eccc' && !action.disabled,
      ),
  );
  layer.destroy();
});

test('current OGD avg_value schema is accepted alongside legacy pollutant_avg', () => {
  const liveShape = row({ avg_value: '42', min_value: '7', max_value: '80' });
  delete liveShape.pollutant_avg;
  assert.equal(normalize([liveShape])[0].value, 42);
  assert.equal(
    normalize([row({ avg_value: '42', pollutant_avg: '99' })])[0].value,
    42,
  );
  assert.deepEqual(
    normalize([row({ avg_value: 'NA', pollutant_avg: '99' })]),
    [],
  );
});
