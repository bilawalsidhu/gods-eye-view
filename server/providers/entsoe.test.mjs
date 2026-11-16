import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTSOE_DOMAINS,
  ENTSOE_KEY_ID,
  ENTSOE_ZONES,
  entsoeResolutionMinutes,
  entsoeZone,
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

const period = (start, resolution, points, tag = 'quantity') =>
  `<Period><timeInterval><start>${start}</start><end>2026-10-26T00:00Z</end></timeInterval>` +
  `<resolution>${resolution}</resolution>` +
  points
    .map(
      (value, index) =>
        `<Point><position>${index + 1}</position><${tag}>${value}</${tag}></Point>`,
    )
    .join('') +
  '</Period>';

const series = (inner, extra = '') =>
  `<TimeSeries><mRID>1</mRID>${extra}<quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name>${inner}</TimeSeries>`;

const wrap = (inner) =>
  `<GL_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-6:generationloaddocument:3:0">${inner}</GL_MarketDocument>`;

/** Realised load: hourly, position FIRST then quantity, as the platform sends it. */
const DOCUMENT = wrap(
  series(period('2026-10-25T00:00Z', 'PT60M', [42000.5, 43000, 44000])),
);

test('the token is read from the environment, never hardcoded', () => {
  assert.equal(ENTSOE_TOKEN_ENV_VAR, 'ENTSOE_TOKEN');
  assert.equal(entsoeToken({ ENTSOE_TOKEN: ' abc ' }), 'abc');
  assert.equal(entsoeToken({}), '');
  assert.equal(entsoeToken({}), '');
});

const byRoute = (route) => ENTSOE_DOMAINS.find((d) => d.route === route);

test('the upstream URL asks for the platform document, zone and yyyyMMddHHmm window', () => {
  const window = entsoeDayWindow('2026-10-25');
  const load = new URL(
    buildEntsoeUrl(byRoute('load'), ENTSOE_ZONES.FR, window, 'SECRET'),
  );
  assert.equal(load.origin + load.pathname, 'https://web-api.tp.entsoe.eu/api');
  const q = load.searchParams;
  assert.equal(q.get('securityToken'), 'SECRET');
  assert.equal(q.get('documentType'), 'A65');
  assert.equal(q.get('processType'), 'A16');
  assert.equal(q.get('outBiddingZone_Domain'), '10YFR-RTE------C');
  assert.equal(q.get('periodStart'), '202610250000');
  assert.equal(q.get('periodEnd'), '202610260000');
  assert.equal(q.get('domainCode'), null, 'no invented parameter');
  const gen = new URL(
    buildEntsoeUrl(byRoute('generation'), ENTSOE_ZONES.FR, window, 'T'),
  ).searchParams;
  assert.equal(gen.get('documentType'), 'A75');
  assert.equal(gen.get('in_Domain'), '10YFR-RTE------C');
  const price = new URL(
    buildEntsoeUrl(byRoute('prices'), ENTSOE_ZONES.DE, window, 'T'),
  ).searchParams;
  assert.equal(price.get('documentType'), 'A44');
  assert.equal(price.get('processType'), null);
  assert.equal(price.get('in_Domain'), '10Y1001A1001A82H');
  assert.equal(price.get('out_Domain'), '10Y1001A1001A82H');
});

test('a zone is validated: unknown codes and prices without a market area are refused', () => {
  assert.equal(entsoeZone(null, byRoute('load')).code, 'FR');
  assert.equal(entsoeZone('de', byRoute('load')).code, 'DE');
  assert.equal(entsoeZone('XX', byRoute('load')).error, 'unknown zone');
  assert.equal(entsoeZone('__proto__', byRoute('load')).error, 'unknown zone');
  assert.ok(entsoeZone('IT', byRoute('prices')).error);
});

test('a malformed date is refused', () => {
  assert.equal(entsoeDayWindow('nope'), null);
  assert.equal(entsoeDayWindow('2026-02-31'), null);
  assert.equal(entsoeDayWindow(null), null);
});

test('the hourly series is parsed out of the upstream document', () => {
  const window = entsoeDayWindow('2026-10-25');
  const parsed = parseEntsoeTimeSeries(DOCUMENT, window);
  assert.equal(parsed.points.length, 3);
  assert.deepEqual(parsed.points[0], { position: 1, value: 42000.5 });
  assert.equal(parsed.points[1].position, 2);
});

test('sub-hourly points are averaged into their hour', () => {
  const window = entsoeDayWindow('2026-10-25');
  const xml = wrap(
    series(period('2026-10-25T00:00Z', 'PT15M', [100, 200, 300, 400, 10, 20])),
  );
  assert.deepEqual(parseEntsoeTimeSeries(xml, window).points, [
    { position: 1, value: 250 },
    { position: 2, value: 15 },
  ]);
});

test('a period that starts mid-day lands on its own hours, not on position 1', () => {
  const window = entsoeDayWindow('2026-10-25');
  const xml = wrap(series(period('2026-10-25T06:00Z', 'PT60M', [7, 8])));
  assert.deepEqual(parseEntsoeTimeSeries(xml, window).points, [
    { position: 7, value: 7 },
    { position: 8, value: 8 },
  ]);
  // Points outside the requested day are dropped.
  const spill = wrap(series(period('2026-10-25T23:00Z', 'PT60M', [1, 2, 3])));
  assert.deepEqual(parseEntsoeTimeSeries(spill, window).points, [
    { position: 24, value: 1 },
  ]);
});

test('price points are read from price.amount', () => {
  const window = entsoeDayWindow('2026-10-25');
  const xml =
    '<Publication_MarketDocument><TimeSeries>' +
    period('2026-10-25T00:00Z', 'PT60M', [91.25, 80], 'price.amount') +
    '</TimeSeries></Publication_MarketDocument>';
  assert.deepEqual(parseEntsoeTimeSeries(xml, window).points, [
    { position: 1, value: 91.25 },
    { position: 2, value: 80 },
  ]);
});

test('generation sums the production series and skips consumption series', () => {
  const window = entsoeDayWindow('2026-10-25');
  const xml = wrap(
    series(period('2026-10-25T00:00Z', 'PT60M', [100, 200]), '<inBiddingZone_Domain.mRID>x</inBiddingZone_Domain.mRID>') +
      series(period('2026-10-25T00:00Z', 'PT60M', [50, 25]), '<inBiddingZone_Domain.mRID>x</inBiddingZone_Domain.mRID>') +
      series(period('2026-10-25T00:00Z', 'PT60M', [999, 999]), '<outBiddingZone_Domain.mRID>x</outBiddingZone_Domain.mRID>'),
  );
  assert.deepEqual(
    parseEntsoeTimeSeries(xml, window, 'sum', { skipConsumption: true }).points,
    [
      { position: 1, value: 150 },
      { position: 2, value: 225 },
    ],
  );
});

test('resolutions are read as minutes', () => {
  assert.equal(entsoeResolutionMinutes('PT15M'), 15);
  assert.equal(entsoeResolutionMinutes('PT60M'), 60);
  assert.equal(entsoeResolutionMinutes('PT1H'), 60);
  assert.equal(entsoeResolutionMinutes('P1D'), null);
  assert.equal(entsoeResolutionMinutes('PT120M'), null);
});

test('a document with no series is refused', () => {
  const window = entsoeDayWindow('2026-10-25');
  assert.equal(parseEntsoeTimeSeries('<html/>', window), null);
  assert.equal(parseEntsoeTimeSeries('', window), null);
  assert.equal(
    parseEntsoeTimeSeries('<Acknowledgement_MarketDocument/>', window),
    null,
  );
});

test('an acknowledgement names the reason the operator refused', () => {
  const xml =
    '<Acknowledgement_MarketDocument><Reason>Token has expired</Reason></Acknowledgement_MarketDocument>';
  assert.equal(parseEntsoeAcknowledgement(xml), 'Token has expired');
  const real =
    '<Acknowledgement_MarketDocument><Reason><code>999</code><text>No matching data found</text></Reason></Acknowledgement_MarketDocument>';
  assert.equal(parseEntsoeAcknowledgement(real), 'No matching data found');
  assert.equal(parseEntsoeAcknowledgement('<x/>'), null);
});

test('a document is normalized into the JSON the layer renders', () => {
  const payload = normalizeEntsoeDocument(
    DOCUMENT,
    byRoute('load'),
    entsoeDayWindow('2026-10-25'),
    'FR',
  );
  assert.equal(payload.count, 3);
  assert.equal(payload.unit, 'MW');
  assert.equal(payload.day, '2026-10-25');
  assert.equal(payload.zone, 'FR');
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
  assert.equal(payload.count, 3);
  assert.equal(payload.unit, 'MW');
});

test('a missing date means today, and the upstream is asked for that UTC day', async () => {
  let asked = null;
  const handler = createEntsoeHandler({
    env: { ENTSOE_TOKEN: 'GOOD' },
    now: () => Date.parse('2026-10-25T13:00:00Z'),
    fetchImpl: async (url) => {
      asked = new URL(url);
      return new Response(DOCUMENT, { status: 200 });
    },
  });
  const res = fakeRes();
  await handler(fakeReq('/load'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(asked.searchParams.get('periodStart'), '202610250000');
  assert.equal(JSON.parse(res.body).day, '2026-10-25');
});

test('a malformed date, an unknown zone and an unknown route are refused before the upstream', async () => {
  let called = 0;
  const handler = createEntsoeHandler({
    env: { ENTSOE_TOKEN: 'GOOD' },
    fetchImpl: async () => {
      called += 1;
      return new Response(DOCUMENT, { status: 200 });
    },
  });
  for (const [path, status] of [
    ['/load?date=nope', 400],
    ['/load?zone=XX', 400],
    ['/prices?zone=IT', 400],
    ['/bogus', 404],
  ]) {
    const res = fakeRes();
    await handler(fakeReq(path), res);
    assert.equal(res.statusCode, status, path);
  }
  assert.equal(called, 0);
});

test('an answer is cached per route, zone and day, so a second tab does not spend the token', async () => {
  let called = 0;
  let clock = Date.parse('2026-10-25T13:00:00Z');
  const handler = createEntsoeHandler({
    env: { ENTSOE_TOKEN: 'GOOD' },
    now: () => clock,
    fetchImpl: async () => {
      called += 1;
      return new Response(DOCUMENT, { status: 200 });
    },
  });
  for (const path of ['/load', '/load', '/load?zone=FR']) {
    const res = fakeRes();
    await handler(fakeReq(path), res);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(called, 1);
  await handler(fakeReq('/load?zone=DE'), fakeRes());
  assert.equal(called, 2, 'another zone is its own entry');
  clock += 16 * 60_000;
  await handler(fakeReq('/load'), fakeRes());
  assert.equal(called, 3, 'today expires after 15 minutes');
});
