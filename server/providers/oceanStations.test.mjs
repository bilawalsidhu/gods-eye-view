import test from 'node:test';
import assert from 'node:assert/strict';
import { oceanStationsProxy } from './oceanStations.js';

const MOCK_NDBC_TEXT = `#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE
#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft
41002    31.759  -74.836 2026 10 14 01 50  90   8.0  10.0  2.1   8  6.5  95 1018.5  +1.2  22.4  24.1  18.0  10.0     MM
`;

function createMockServer() {
  let middleware = null;
  const plugin = oceanStationsProxy({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(MOCK_NDBC_TEXT.length) }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(MOCK_NDBC_TEXT));
          controller.close();
        },
      }),
    }),
    now: () => 1760400000000,
  });

  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        middleware = handler;
      },
    },
  });

  return async (path = '/') => {
    let statusCode = null;
    let headers = {};
    let body = '';

    const req = {
      method: 'GET',
      url: path,
      headers: { 'x-forwarded-for': '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = {
      writeHead(code, h) {
        statusCode = code;
        headers = h;
      },
      end(payload) {
        body = payload;
      },
    };

    await middleware(req, res);
    return {
      status: statusCode,
      headers,
      body: body ? JSON.parse(body) : null,
    };
  };
}

test('oceanStationsProxy serves parsed station observations', async () => {
  const request = createMockServer();
  const res = await request('/latest');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.stations[0].id, '41002');
  assert.equal(res.body.stations[0].waveHeightM, 2.1);
  assert.equal(res.body.stations[0].waterTempC, 24.1);
});

test('oceanStationsProxy rejects non-GET and unknown subpaths', async () => {
  const plugin = oceanStationsProxy();
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use(route, h) {
        handler = h;
      },
    },
  });

  let status = null;
  const res = {
    writeHead(code) {
      status = code;
    },
    end() {},
  };

  await handler({ method: 'POST', url: '/' }, res);
  assert.equal(status, 405);

  await handler({ method: 'GET', url: '/unknown' }, res);
  assert.equal(status, 404);
});
