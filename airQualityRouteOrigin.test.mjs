import test from 'node:test';
import assert from 'node:assert/strict';
import { cpcbProxy } from './server/providers/cpcb.js';
import { openAqProxy } from './server/providers/openAq.js';
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
          status ??= this.statusCode;
          stringified++;
          body = s ? JSON.parse(s) : s;
        },
      },
      () => {},
    );
    return { status, body, stringified };
  };
}

test('cross-site request to CPCB is refused before key lookup and fetch', async () => {
  let keyReads = 0,
    fetches = 0;
  const request = harness({
    apiKey: () => {
      keyReads++;
      return 'k';
    },
    fetchImpl: async () => {
      fetches++;
      return Response.json({ total: 1, records: [ogdRow()] });
    },
  });
  const r = await request({
    headers: {
      host: 'localhost:5173',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    },
  });
  assert.equal(
    r.status,
    403,
    `got ${r.status}, keyReads=${keyReads}, fetches=${fetches}`,
  );
  assert.equal(fetches, 0);
});

test('cross-site request to OpenAQ is refused before key lookup', async () => {
  let keyReads = 0,
    fetches = 0;
  let handler;
  openAqProxy({
    getKey: () => {
      keyReads++;
      return 'k';
    },
    fetchImpl: async () => {
      fetches++;
      return new Response('{}', { status: 503 });
    },
  }).configureServer({
    middlewares: {
      use(_p, fn) {
        handler = fn;
      },
    },
  });
  let status;
  await handler(
    {
      method: 'GET',
      url: '/',
      headers: {
        host: 'localhost:5173',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    },
    {
      destroyed: false,
      once() {},
      removeListener() {},
      setHeader() {},
      writeHead(s) {
        status = s;
      },
      end() {
        status ??= this.statusCode;
      },
    },
  );
  assert.equal(
    status,
    403,
    `got ${status}, keyReads=${keyReads}, fetches=${fetches}`,
  );
  assert.equal(keyReads, 0);
});
