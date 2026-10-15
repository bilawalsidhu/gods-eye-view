import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUkFeed,
  rssRows,
  readingAge,
  safeLink,
  inUkBounds,
} from './ukDataModel.js';
import { createUkDataService } from '../../server/providers/uk-data.js';

test('UK-AIR real latitude-first coordinates are corrected; stale measurements remain visibly old', () => {
  const rows = normalizeUkFeed('air', [
    {
      properties: { id: 1, label: 'Aberdeen', timeseries: { 4886: {} } },
      geometry: { coordinates: [57.1574, -2.09477, 'NaN'] },
    },
  ]);
  assert.equal(rows[0].lat, 57.1574);
  assert.equal(rows[0].lon, -2.09477);
  assert.deepEqual(rows[0].series, ['4886']);
  assert.equal(
    readingAge('2020-01-01T00:00:00Z', Date.parse('2026-01-01')),
    'Old observation / update',
  );
  assert.equal(readingAge(null), 'Time not supplied');
  assert.equal(
    readingAge('2026-10-16', Date.parse('2026-10-15')),
    'Source time is in the future',
  );
});
test('river readings join the exact measure and retain source time, unit and missing-value gaps', () => {
  const data = {
    items: [
      {
        stationReference: 'A',
        label: 'River A',
        lat: 54.9,
        long: -1.6,
        measures: [
          { '@id': 'measure:A', parameter: 'level', unitName: 'mASD' },
        ],
      },
      {
        stationReference: 'B',
        label: 'River B',
        lat: 55,
        long: -1.6,
        measures: [{ '@id': 'measure:B', parameter: 'level', unitName: 'm' }],
      },
    ],
  };
  const rows = normalizeUkFeed('ea-rivers', data, {
    items: [
      { measure: 'measure:A', value: 1.42, dateTime: '2026-10-15T09:00:00' },
    ],
  });
  assert.match(rows[0].details, /1.42 mASD/);
  assert.equal(rows[0].time, '2026-10-15T09:00:00.000Z');
  assert.match(rows[1].details, /No current reading/);
  assert.equal(rows[1].time, null);
});
test('RSS preserves original source links and old item dates rather than borrowing channel freshness', () => {
  const xml =
    '<rss><channel><pubDate>Thu, 15 Oct 2026 10:00:00 +0100</pubDate><item><guid>old</guid><title>Road &amp; bridge</title><description><![CDATA[<b>Cleared incident</b>]]></description><pubDate>Sun, 4 Oct 2026 16:04:29 +0100</pubDate><link>https://traffic.wales/road-traffic-alerts/123</link><georss:point>53.2 -4.1</georss:point></item></channel></rss>';
  const [row] = rssRows(xml, 'https://traffic.wales/');
  assert.equal(row.name, 'Road & bridge');
  assert.equal(row.details, 'Cleared incident');
  assert.equal(row.time, '2026-10-04T15:04:29.000Z');
  assert.equal(row.lon, -4.1);
  assert.equal(row.url, 'https://traffic.wales/road-traffic-alerts/123');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('https://secret@example.com/'), null);
  assert.equal(inUkBounds(0, 0), false);
});
test('weather filters nearby Irish and French reports instead of calling the bounding box the UK', () => {
  const rows = normalizeUkFeed('weather', [
    {
      icaoId: 'EGNT',
      lat: 55,
      lon: -1.6,
      name: 'Newcastle',
      obsTime: 1792054800,
      temp: 9,
    },
    { icaoId: 'EIDW', lat: 53.4, lon: -6.3 },
    { icaoId: 'LFAC', lat: 50.9, lon: 1.9 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'EGNT');
  assert.match(rows[0].time, /2026-10-15/);
});
test('requests coalesce and caches expire; outage responses retain original retrieval time and are never all-clear', async () => {
  let time = 0,
    calls = 0,
    offline = false;
  const service = createUkDataService({
    now: () => time,
    fetchImpl: async () => {
      calls++;
      if (offline) throw new Error('offline');
      return new Response(JSON.stringify({ items: [] }));
    },
  });
  const [a, b] = await Promise.all([
    service.feed('ea-floods'),
    service.feed('ea-floods'),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.status, 'available');
  time = 300001;
  offline = true;
  const stale = await service.feed('ea-floods');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.retrievedAt, a.retrievedAt);
  time = 7 * 3600000;
  const unavailable = await service.feed('ea-floods');
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.message, /not an empty or all-clear/);
  assert.equal(unavailable.retrievedAt, null);
  service.close();
});
test('source errors and arbitrary URLs do not turn into proxy targets; air series require catalogue admission', async () => {
  let calls = 0;
  const service = createUkDataService({
    fetchImpl: async () => {
      calls++;
      return new Response('[]');
    },
  });
  await assert.rejects(service.feed('https://localhost/private'));
  assert.equal(await service.airSeries('../../private'), null);
  assert.equal(calls, 0);
  assert.equal(await service.airSeries('999999'), null);
  assert.equal(calls, 1);
  service.close();
});
