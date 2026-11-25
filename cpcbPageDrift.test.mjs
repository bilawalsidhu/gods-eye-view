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

test('page drift with constant total is not accepted as a complete snapshot', async () => {
  // 1001 rows; between page 1 and page 2 the feed reorders so row 999 (last of page 1)
  // is seen again on page 2 and station "1000" is never seen.
  const request = harness({
    apiKey: () => 'k',
    fetchImpl: async (url) => {
      const offset = Number(url.searchParams.get('offset'));
      if (!offset)
        return Response.json({
          total: 1001,
          records: Array.from({ length: 1000 }, (_, i) =>
            ogdRow({ station: String(i) }),
          ),
        });
      return Response.json({
        total: 1001,
        records: [ogdRow({ station: '999' })],
      });
    },
  });
  const r = await request();
  const names = new Set(r.body.stations?.map((s) => s.name) || []);
  assert.ok(
    r.status !== 200 || names.has('1000'),
    `status=${r.status} stations=${names.size} has1000=${names.has('1000')}`,
  );
});
