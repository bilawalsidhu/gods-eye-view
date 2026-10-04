import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tidesProxy,
  parseTideQuery,
  normalizeNoaaPredictions,
} from '../../server/providers/tides.js';

const NOW = Date.parse('2026-10-01T14:00:00Z');
const noaa = {
  predictions: [
    { t: '2026-10-01 10:21', v: '1.073', type: 'H' },
    { t: '2026-10-01 14:08', v: '0.893', type: 'L' },
    { t: '2026-10-01 20:39', v: '1.727', type: 'H' },
  ],
};

function mount(fetchImpl) {
  let handler;
  tidesProxy({ fetchImpl, now: () => NOW }).configureServer({
    middlewares: { use: (_path, h) => (handler = h) },
  });
  return async (url, method = 'GET') => {
    let status;
    let body = '';
    const res = {
      writableEnded: false,
      writeHead(code) {
        status = code;
      },
      end(text) {
        body = text;
        this.writableEnded = true;
      },
    };
    await handler({ method, url }, res);
    return { status, json: JSON.parse(body) };
  };
}

const query =
  '/?station=9413745&begin=2026-10-01T02:00:00.000Z&end=2026-10-03T14:00:00.000Z';

test('queries are bounded and padded by a day each side', () => {
  assert.deepEqual(parseTideQuery(query.slice(2), NOW), {
    station: '9413745',
    beginDate: '20260930',
    endDate: '20261004',
  });
  assert.equal(parseTideQuery('station=abc&begin=x&end=y', NOW), null);
  assert.equal(
    parseTideQuery(
      'station=9413745&begin=2026-10-01T00:00:00Z&end=2026-10-20T00:00:00Z',
      NOW,
    ),
    null,
  );
});

test('NOAA GMT rows become ISO turning points; NOAA errors are named', () => {
  const rows = normalizeNoaaPredictions(noaa);
  assert.equal(rows[0].time, '2026-10-01T10:21:00.000Z');
  assert.equal(rows[2].height, 1.727);
  assert.throws(
    () => normalizeNoaaPredictions({ error: { message: 'No data was found.' } }),
    (error) => error.code === 'NOAA_ERROR',
  );
  assert.throws(() =>
    normalizeNoaaPredictions({ predictions: [{ t: 'bad', v: '1', type: 'H' }] }),
  );
});

test('the proxy serves, caches, and refuses bad input', async () => {
  const urls = [];
  const request = mount(async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(noaa), { status: 200 });
  });
  const first = await request(query);
  assert.equal(first.status, 200);
  assert.equal(first.json.station, '9413745');
  assert.equal(first.json.predictions.length, 3);
  assert.match(urls[0], /interval=hilo/);
  assert.match(urls[0], /datum=MLLW/);
  assert.match(urls[0], /time_zone=gmt/);
  await request(query);
  assert.equal(urls.length, 1, 'second request is served from cache');
  assert.equal((await request('/?station=1')).status, 400);
  assert.equal((await request(query, 'POST')).status, 405);
});

test('upstream failures answer without leaking details', async () => {
  const down = mount(async () => new Response('nope', { status: 503 }));
  const res = await down(query);
  assert.equal(res.status, 502);
  assert.equal(res.json.error, 'tides_unavailable');
  const missing = mount(
    async () =>
      new Response(JSON.stringify({ error: { message: 'No data was found.' } })),
  );
  assert.equal((await missing(query)).status, 404);
});
