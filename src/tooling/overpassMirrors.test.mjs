/**
 * Street Traffic road network — configurable Overpass mirrors (closeout
 * 2026-09-19): `OVERPASS_ENDPOINTS` parsing and defaults, the per-request
 * headers every mirror receives, rotation on 406 → 429 → 5xx → timeout →
 * success, and the structured `DEGRADED · Overpass · <reason>` outcome when
 * every mirror fails (transport, proxy and the DATA LAYERS presentation).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  OVERPASS_DEFAULT_UPSTREAMS,
  OVERPASS_ENDPOINTS_ENV,
  OVERPASS_USER_AGENT,
  overpassMirrorLabel,
  parseOverpassEndpoints,
  parseOverpassUpstreams,
  resolveOverpassEndpoints,
  roadNetworkConfig,
} from '../../server/providers/overpass/constants.js';
import {
  describeRotationFailure,
  fetchOverpassPayload,
  isMirrorFailureStatus,
  overpassPayloadIsData,
} from '../../server/providers/overpass/transport.js';
import { PROVIDER_USER_AGENT } from '../../server/providers/common/upstream.js';
import createViteConfig from '../../vite.config.js';
import { describeRoadError } from '../layers/traffic/ingestion.js';
import { providerStatusFromResponse } from '../sources/live/contract.js';

const DATA_BODY = '{"version":0.6,"elements":[]}';

/** A mirror list that names real hosts so the reason strings read like production. */
const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

/** Build a fetch double from a script of per-URL answers; records every call. */
function scripted(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[url];
    if (typeof answer === 'function') return answer(init);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body ?? '', {
      status: answer.status,
      headers: { 'content-type': answer.contentType || 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

/** A mirror that never answers until the helper's timeout aborts it. */
const hangs = (init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

// ---------------------------------------------------------------------------
// (1) default endpoint list when the env is unset
// ---------------------------------------------------------------------------
test('OVERPASS_ENDPOINTS unset: the default mirror list, in the verified priority order', () => {
  assert.deepEqual(resolveOverpassEndpoints({}), {
    endpoints: [...OVERPASS_DEFAULT_UPSTREAMS],
    source: 'default',
  });
  assert.deepEqual(
    [...OVERPASS_DEFAULT_UPSTREAMS],
    [
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://lz4.overpass-api.de/api/interpreter',
      'https://z.overpass-api.de/api/interpreter',
    ],
    'reachable mirrors first (probe 2026-09-19), refusing ones kept LAST rather than dropped',
  );
  assert.equal(OVERPASS_DEFAULT_UPSTREAMS.length, 5);
  assert.equal(OVERPASS_ENDPOINTS_ENV.canonical, 'OVERPASS_ENDPOINTS');
  assert.equal(OVERPASS_ENDPOINTS_ENV.alias, 'OVERPASS_UPSTREAMS');
  // The env var is read at call time — an unrelated variable changes nothing.
  assert.deepEqual(
    resolveOverpassEndpoints({ OVERPASS_MIRROR_TIMEOUT_MS: '9000' }).endpoints,
    [...OVERPASS_DEFAULT_UPSTREAMS],
  );
  assert.equal(roadNetworkConfig({}).endpointsSource, 'default');
});

// ---------------------------------------------------------------------------
// (2) parsing OVERPASS_ENDPOINTS — whitespace, empties, duplicates, alias
// ---------------------------------------------------------------------------
test('OVERPASS_ENDPOINTS parsing: comma-separated, trimmed, empty entries ignored, order kept', () => {
  assert.deepEqual(
    parseOverpassEndpoints(
      '  https://overpass.internal.example/api/interpreter , ,https://overpass.kumi.systems/api/interpreter,, \n https://overpass.internal.example/api/interpreter ,',
    ),
    [
      'https://overpass.internal.example/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ],
  );
  assert.equal(parseOverpassEndpoints(''), null);
  assert.equal(parseOverpassEndpoints('   , ,  '), null);
  assert.equal(parseOverpassEndpoints('ftp://nope.example/x, not a url'), null);
  assert.equal(parseOverpassEndpoints(undefined), null);
  assert.equal(parseOverpassUpstreams, parseOverpassEndpoints, 'the 2026-09-18 name is the same parser');

  const canonical = resolveOverpassEndpoints({
    OVERPASS_ENDPOINTS: ' https://a.example/api/interpreter ,, https://b.example/api/interpreter ',
    OVERPASS_UPSTREAMS: 'https://ignored.example/api/interpreter',
  });
  assert.deepEqual(canonical, {
    endpoints: ['https://a.example/api/interpreter', 'https://b.example/api/interpreter'],
    source: 'OVERPASS_ENDPOINTS',
  });
  const alias = resolveOverpassEndpoints({
    OVERPASS_UPSTREAMS: 'https://alias.example/api/interpreter',
  });
  assert.deepEqual(alias, {
    endpoints: ['https://alias.example/api/interpreter'],
    source: 'OVERPASS_UPSTREAMS',
  });
  // an unusable canonical value falls through to the alias, then the default
  assert.equal(
    resolveOverpassEndpoints({ OVERPASS_ENDPOINTS: 'garbage', OVERPASS_UPSTREAMS: 'https://alias.example/x' }).source,
    'OVERPASS_UPSTREAMS',
  );
  assert.equal(resolveOverpassEndpoints({ OVERPASS_ENDPOINTS: ' , ' }).source, 'default');
  const config = roadNetworkConfig({ OVERPASS_ENDPOINTS: 'https://a.example/api/interpreter' });
  assert.deepEqual(config.upstreams, ['https://a.example/api/interpreter']);
  assert.equal(config.endpointsSource, 'OVERPASS_ENDPOINTS');
  assert.deepEqual(config.fromEnv, {
    ROAD_NETWORK_SOURCE: false,
    OVERPASS_ENDPOINTS: true,
    OVERPASS_UPSTREAMS: false,
  });
  assert.equal(overpassMirrorLabel('https://overpass.kumi.systems/api/interpreter'), 'kumi.systems');
  assert.equal(overpassMirrorLabel('https://lz4.overpass-api.de/api/interpreter'), 'lz4.overpass-api.de');
});

// ---------------------------------------------------------------------------
// (3) rotation: 406 → 429 → 503 → timeout → success on the 5th mirror
// ---------------------------------------------------------------------------
test('rotation: 406 → 429 → 503 → timeout → the fifth mirror answers and its data is returned', async () => {
  const { fetchImpl, calls } = scripted({
    [MIRRORS[0]]: { status: 406, contentType: 'text/html', body: '<title>406 Not Acceptable</title>' },
    [MIRRORS[1]]: { status: 429, body: 'rate_limited' },
    [MIRRORS[2]]: { status: 503, body: 'busy' },
    [MIRRORS[3]]: hangs,
    [MIRRORS[4]]: { status: 200, body: DATA_BODY },
  });
  const payload = await fetchOverpassPayload('data=%5Bout%3Ajson%5D', 1e6, {
    endpoints: MIRRORS,
    fetchImpl,
    simplify: (body) => body,
    timeoutMs: 150,
    totalTimeoutMs: 10_000,
    sleep: async () => {},
  });
  assert.deepEqual(
    calls.map((c) => c.url),
    MIRRORS,
    'every failing mirror is passed over exactly once, in order',
  );
  assert.equal(payload.status, 200);
  assert.equal(payload.endpoint, MIRRORS[4]);
  assert.equal(payload.body, DATA_BODY);
  assert.equal(overpassPayloadIsData(payload), true);
  assert.equal(payload.provider, undefined, 'a successful rotation carries no degraded status');
  for (const status of [406, 429, 500, 502, 503, 504, 403, 408])
    assert.equal(isMirrorFailureStatus(status), true, `${status} rotates`);
  for (const status of [400, 404, 413, 414]) assert.equal(isMirrorFailureStatus(status), false, `${status} is a query refusal`);
});

// ---------------------------------------------------------------------------
// (4) every mirror fails → `degraded` with the summarising reason
// ---------------------------------------------------------------------------
test('all mirrors fail → status degraded with a reason that names the count and the last failure', async () => {
  const three = MIRRORS.slice(0, 3);
  const { fetchImpl } = scripted({
    [three[0]]: { status: 503, body: 'busy' },
    [three[1]]: hangs,
    [three[2]]: { status: 406, contentType: 'text/html', body: '<title>406</title>' },
  });
  const payload = await fetchOverpassPayload('data=x', 1e6, {
    endpoints: three,
    fetchImpl,
    simplify: (body) => body,
    timeoutMs: 150,
    totalTimeoutMs: 10_000,
    sleep: async () => {},
  });
  assert.equal(overpassPayloadIsData(payload), false, 'never cached, never served as data');
  assert.equal(payload.provider.status, 'degraded');
  assert.equal(payload.provider.source, 'Overpass');
  assert.equal(payload.provider.error, 'all 3 mirrors failed · last: overpass-api.de HTTP 406');
  assert.deepEqual(
    payload.failures.map((f) => [f.label, f.detail]),
    [
      ['kumi.systems', 'HTTP 503'],
      ['private.coffee', 'timed out after 0 s'],
      ['overpass-api.de', 'HTTP 406'],
    ],
  );

  // The reason grammar, including the time-budget cut.
  assert.equal(
    describeRotationFailure(
      [
        { label: 'kumi.systems', status: 406, code: 'upstream_4xx' },
        { label: 'private.coffee', status: 0, code: 'timeout', timeoutMs: 12_000 },
      ],
      5,
    ),
    '2 of 5 mirrors failed, 3 skipped (time budget) · last: private.coffee timed out after 12 s',
  );
  assert.equal(
    describeRotationFailure([{ label: 'kumi.systems', status: 429, code: 'rate_limited' }], 1),
    'all 1 mirror failed · last: kumi.systems HTTP 429',
  );

  // A rotation in which EVERY mirror threw at the network level throws too —
  // with the same structured status attached for the proxy's catch.
  const { fetchImpl: allDown } = scripted({
    [three[0]]: new Error('ECONNRESET'),
    [three[1]]: new Error('ENOTFOUND'),
    [three[2]]: new Error('ECONNREFUSED'),
  });
  await assert.rejects(
    fetchOverpassPayload('data=x', 1e6, { endpoints: three, fetchImpl: allDown, simplify: (b) => b, sleep: async () => {} }),
    (error) => {
      assert.equal(error.provider.status, 'degraded');
      assert.equal(error.message, 'all 3 mirrors failed · last: overpass-api.de ECONNREFUSED');
      return true;
    },
  );

  // The road query itself being refused everywhere (400) is NOT an outage:
  // upstream's verdict is passed through and no degraded status is attached.
  const { fetchImpl: badQuery } = scripted({
    [three[0]]: { status: 400, body: 'line 1: parse error' },
    [three[1]]: { status: 400, body: 'line 1: parse error' },
    [three[2]]: { status: 400, body: 'line 1: parse error' },
  });
  const refused = await fetchOverpassPayload('data=x', 1e6, { endpoints: three, fetchImpl: badQuery, simplify: (b) => b, sleep: async () => {} });
  assert.equal(refused.status, 400);
  assert.equal(refused.provider, undefined);
  assert.match(refused.body, /parse error/);
});

test('proxy: every mirror failing answers HTTP 503 with X-Provider-Status degraded and the reason (never a 502 or a 406 page)', async (t) => {
  const plugin = createViteConfig({ mode: 'test' }).plugins.find((p) => p.name === 'overpass-proxy');
  const routes = new Map();
  plugin.configureServer({ middlewares: { use: (route, handler) => routes.set(route, handler) } });
  const handler = routes.get('/api/overpass');
  const query = `[out:json][timeout:20];node(around:10,30.25,-97.75)["name"="${randomUUID()}"];out;`;
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('<title>406 Not Acceptable</title>', { status: 406, headers: { 'content-type': 'text/html' } }));
  try {
    const req = Readable.from([Buffer.from(`data=${encodeURIComponent(query)}`)]);
    Object.assign(req, { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    const answer = await new Promise((resolve, reject) => {
      const res = {
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          resolve({ status: this.status, headers: this.headers, body });
        },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
    assert.equal(answer.status, 503, 'structured 503, not the mirror\'s 406 and not a 502');
    assert.equal(answer.headers['X-Provider-Status'], 'degraded');
    assert.equal(answer.headers['X-Provider-Source'], 'Overpass');
    assert.equal(answer.headers['Cache-Control'], 'no-store');
    const body = JSON.parse(answer.body);
    assert.equal(body.provider.status, 'degraded');
    assert.equal(
      body.provider.error,
      `all ${OVERPASS_DEFAULT_UPSTREAMS.length} mirrors failed · last: z.overpass-api.de HTTP 406`,
    );
    assert.equal(body.error, body.provider.error);
    assert.equal(body.failures.length, OVERPASS_DEFAULT_UPSTREAMS.length);
    assert.equal(mock.mock.callCount(), OVERPASS_DEFAULT_UPSTREAMS.length, 'each default mirror asked once');

    // …and the client turns that answer into the row's reason, verbatim.
    const response = new Response(answer.body, { status: answer.status, headers: answer.headers });
    const provider = providerStatusFromResponse(response, body);
    const error = Object.assign(new Error(`Overpass API returned ${answer.status}`), { provider });
    provider.error = body.provider.error;
    assert.equal(describeRoadError(error), body.provider.error);
    assert.equal(
      describeRoadError(new Error('Overpass API returned 406')),
      'OpenStreetMap roads unavailable — public Overpass mirrors refuse this deployment (HTTP 406); simulated traffic needs OSM roads',
      'a proxy that reports no status keeps the legacy mapping',
    );
  } finally {
    mock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// (5) User-Agent and Accept on EVERY request
// ---------------------------------------------------------------------------
test('every mirror request carries the shared User-Agent, Accept: application/json and a form-encoded POST body', async () => {
  const { fetchImpl, calls } = scripted({
    [MIRRORS[0]]: { status: 406, contentType: 'text/html', body: 'no' },
    [MIRRORS[1]]: { status: 500, body: 'no' },
    [MIRRORS[2]]: new Error('ECONNRESET'),
    [MIRRORS[3]]: { status: 429, body: 'no' },
    [MIRRORS[4]]: { status: 200, body: DATA_BODY },
  });
  const body = 'data=' + encodeURIComponent('[out:json][timeout:20];node(1);out;');
  await fetchOverpassPayload(body, 1e6, { endpoints: MIRRORS, fetchImpl, simplify: (b) => b, sleep: async () => {} });
  assert.equal(calls.length, MIRRORS.length);
  assert.equal(OVERPASS_USER_AGENT, PROVIDER_USER_AGENT, 'the ONE shared provider UA');
  for (const { url, init } of calls) {
    assert.equal(init.method, 'POST', url);
    assert.equal(init.body, body, url);
    assert.equal(init.headers['User-Agent'], PROVIDER_USER_AGENT, `${url} names the application`);
    assert.match(init.headers['User-Agent'], /^ondemand-spatial\/\d+\.\d+ \(\+https:\/\//, url);
    assert.equal(init.headers.Accept, 'application/json', url);
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded', url);
    assert.ok(init.signal instanceof AbortSignal, `${url} is bounded by the helper's timeout`);
  }
});
