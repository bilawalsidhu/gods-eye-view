import test from 'node:test';
import assert from 'node:assert/strict';
import { cpcbProxy } from './server/providers/cpcb.js';
import { openAqProxy } from './server/providers/openAq.js';
import { createSaAcquisition } from './server/providers/southAfricaAirQuality.js';
import { normalizeCpcbRecords } from './src/layers/airQuality/cpcb.js';

const NOW = Date.parse('2026-10-18T06:30:00Z');
const ogdRow = (patch = {}) => ({
  country: 'India',
  state: 'Delhi',
  city: 'Delhi',
  station: 'Test station',
  latitude: '28.6',
  longitude: '77.2',
  pollutant_id: 'PM2.5',
  avg_value: '42',
  last_update: '18-10-2026 12:00:00',
  ...patch,
});

function harness(options = {}) {
  let handler;
  cpcbProxy({ now: () => NOW, ...options }).configureServer({
    middlewares: {
      use(_p, fn) {
        handler = fn;
      },
    },
  });
  return async ({
    method = 'GET',
    url = '/',
    headers = {},
    destroyed = false,
  } = {}) => {
    let status,
      body,
      stringified = 0;
    await handler(
      { method, url, headers },
      {
        destroyed,
        setHeader() {},
        writeHead(s) {
          status = s;
        },
        end(s) {
          stringified++;
          body = s ? JSON.parse(s) : s;
        },
      },
      () => {},
    );
    return { status, body, stringified };
  };
}

test('renamed station fields do not replace the cache with a fresh empty snapshot', async () => {
  let now = NOW;
  let renamed = false;
  const request = harness({
    now: () => now,
    apiKey: () => 'k',
    fetchImpl: async () =>
      Response.json({
        total: 1,
        records: [
          renamed
            ? { ...ogdRow(), station: undefined, station_name: 'Test station' }
            : ogdRow(),
        ],
      }),
  });
  assert.equal((await request()).body.readings.length, 1);
  now += 21 * 60_000;
  renamed = true;
  const r = await request();
  assert.equal(
    r.body.readings.length,
    1,
    `stale=${r.body.stale} stations=${r.body.readings.length}`,
  );
});
