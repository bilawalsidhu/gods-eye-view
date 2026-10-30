import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTSOE_KEY_ID,
  ENTSOE_TOKEN_ENV_VAR,
  buildEntsoeUrl,
  createEntsoeHandler,
  entsoeDayWindow,
  entsoeToken,
  normalizeEntsoeDocument,
  parseEntsoeAcknowledgement,
  parseEntsoeTimeSeries,
} from './entsoe.js';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writableEnded: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
    on() {},
  };
}

function fakeReq(url, headers = {}) {
  return {
    url,
    method: 'GET',
    headers: { host: 'localhost', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
  };
}

const DOCUMENT = [
  '<TimeSeries xmlns="urn:iec62325.351:tc57wg16:451-3:timeseriesdocument:7:0">',
  '<TimeSeriesData>',
  '<TimeSeriesObservation>',
  '<Measurement_Unit><unit>MW</unit></Measurement_Unit>',
  '<TimeArray>',
  '<Point><qty>42000.5</qty><position>1</position></Point>',
  '<Point><qty>43000.0</qty><position>2</position></Point>',
  '</TimeArray>',
  '</TimeSeriesObservation>',
  '</TimeSeriesData>',
  '</TimeSeries>',
].join('');

test('the token is read from the environment, never hardcoded', () => {
  assert.equal(ENTSOE_TOKEN_ENV_VAR, 'ENTSOE_TOKEN');
  assert.equal(entsoeToken({ ENTSOE_TOKEN: ' abc ' }), 'abc');
  assert.equal(entsoeToken({}), '');
  assert.equal(entsoeToken({}), '');
});

test('the upstream URL carries the token, the domain and the day window', () => {
  const window = entsoeDayWindow('2026-10-25');
  const url = buildEntsoeUrl('A', window, 'SECRET');
  assert.ok(url.startsWith('https://web-api.tp.entsoe.eu/api?'));
  assert.match(url, /securityToken=SECRET/);
  assert.match(url, /domainCode=A/);
  assert.match(url, /periodStart=2026-10-25T00%3A00%3A00Z/);
});

test('a malformed date is refused', () => {
  assert.equal(entsoeDayWindow('nope'), null);
  assert.equal(entsoeDayWindow('2026-02-31'), null);
  assert.equal(entsoeDayWindow(null), null);
});

test('the time series is parsed out of the upstream document', () => {
  const series = parseEntsoeTimeSeries(DOCUMENT);
  assert.equal(series.unit, 'MW');
  assert.equal(series.points.length, 2);
  assert.equal(series.points[0].value, 42000.5);
  assert.equal(series.points[1].position, 2);
});

test('a document with no series is refused', () => {
  assert.equal(parseEntsoeTimeSeries('<html/>'), null);
  assert.equal(parseEntsoeTimeSeries(''), null);
});

test('an acknowledgement names the reason the operator refused', () => {
  const xml =
    '<Acknowledgement_MarketDocument><Reason>Token has expired</Reason></Acknowledgement_MarketDocument>';
  assert.equal(parseEntsoeAcknowledgement(xml), 'Token has expired');
  assert.equal(parseEntsoeAcknowledgement('<x/>'), null);
});

test('a document is normalized into the JSON the layer renders', () => {
  const payload = normalizeEntsoeDocument(
    DOCUMENT,
    { id: 'A', route: 'load', label: 'Total Load', unit: 'MW' },
    '2026-10-25',
  );
  assert.equal(payload.count, 2);
  assert.equal(payload.unit, 'MW');
  assert.equal(payload.day, '2026-10-25');
});

test('without a token the proxy answers needs-key, never 401', async () => {
  let called = 0;
  const handler = createEntsoeHandler({
    env: {},
    fetchImpl: async () => {
      called += 1;
      return new Response('<x/>', { status: 200 });
    },
  });
  const res = fakeRes();
  await handler(fakeReq('/load?date=2026-10-25'), res);
  assert.equal(res.statusCode, 503);
  const payload = JSON.parse(res.body);
  assert.equal(payload.error, 'no_key');
  assert.equal(payload.keyRequired, true);
  assert.equal(called, 0, 'the upstream must not be contacted without a token');
});

test('the status route reports the key presence but never its value', async () => {
  const handler = createEntsoeHandler({
    env: { ENTSOE_TOKEN: 'SUPER-SECRET' },
    fetchImpl: async () => new Response('<x/>', { status: 200 }),
  });
  const res = fakeRes();
  await handler(fakeReq('/status'), res);
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('SUPER-SECRET'));
  const payload = JSON.parse(res.body);
  assert.equal(payload.configured, true);
  assert.equal(payload.keyId, ENTSOE_KEY_ID);
});

test('a rejected token is reported as key-rejected', async () => {
  const handler = createEntsoeHandler({
    env: { ENTSOE_TOKEN: 'BAD' },
    fetchImpl: async () =>
      new Response('<Acknowledgement_MarketDocument><Reason>bad</Reason></Acknowledgement_MarketDocument>', {
        status: 401,
      }),
  });
  const res = fakeRes();
  await handler(fakeReq('/load?date=2026-10-25'), res);
  assert.equal(res.statusCode, 502);
  const payload = JSON.parse(res.body);
  assert.equal(payload.keyRejected, true);
});

test('a successful request answers the normalized series', async () => {
  const handler = createEntsoeHandler({
    env: { ENTSOE_TOKEN: 'GOOD' },
    fetchImpl: async () => new Response(DOCUMENT, { status: 200 }),
  });
  const res = fakeRes();
  await handler(fakeReq('/load?date=2026-10-25'), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.count, 2);
  assert.equal(payload.unit, 'MW');
});

test('a missing date is refused', async () => {
  const handler = createEntsoeHandler({
    env: { ENTSOE_TOKEN: 'GOOD' },
    fetchImpl: async () => new Response(DOCUMENT, { status: 200 }),
  });
  const res = fakeRes();
  await handler(fakeReq('/load'), res);
  assert.equal(res.statusCode, 400);
});
