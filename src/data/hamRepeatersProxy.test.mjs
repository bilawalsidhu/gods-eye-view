import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createHamRepeatersMiddleware,
  createHamrigRepeaterProvider,
  fetchHamrigJson,
  normalizeHamrigBaseUrl,
  parseHamRepeatersEnv,
  parseRepeaterSearch,
  repeaterSearchKey,
} from '../../server/providers/ham-repeaters.js';

const FM = JSON.parse(
  readFileSync(
    new URL('./fixtures/hamrig-fm-repeaters-nearby.json', import.meta.url),
    'utf8',
  ),
);
const DSTAR = JSON.parse(
  readFileSync(
    new URL('./fixtures/hamrig-dstar-repeaters-nearby.json', import.meta.url),
    'utf8',
  ),
);

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A HamRig double keyed by upstream path; an Error entry throws, a function answers. */
function hamrigFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      init,
    });
    const entry = routes[parsed.pathname];
    if (entry === undefined)
      return jsonResponse({ error: 'no such route' }, 404);
    if (entry instanceof Error) throw entry;
    return typeof entry === 'function' ? entry() : jsonResponse(entry);
  };
  return { calls, fetchImpl };
}

function harness({
  routes = {
    '/api/fm/repeaters/nearby': FM,
    '/api/dstar/repeaters/nearby': DSTAR,
  },
  fmEnabled = true,
  enabled = true,
  now,
} = {}) {
  const { calls, fetchImpl } = hamrigFetch(routes);
  let clock = now ?? Date.parse('2026-09-12T16:00:00Z');
  const provider = createHamrigRepeaterProvider({
    baseUrl: 'https://hamrig.com',
    fetchImpl,
    fmEnabled,
    log: null,
  });
  const middleware = createHamRepeatersMiddleware({
    providers: [provider],
    enabled,
    now: () => clock,
    log: null,
  });
  async function call(path, method = 'GET') {
    const result = { status: 0, headers: {}, body: '' };
    await new Promise((resolve, reject) => {
      const res = {
        writeHead(status, headers = {}) {
          result.status = status;
          result.headers = headers;
        },
        end(body = '') {
          result.body = String(body);
          resolve();
        },
      };
      Promise.resolve(middleware({ url: path, method }, res)).catch(reject);
    });
    result.json = result.body ? JSON.parse(result.body) : null;
    return result;
  }
  return {
    calls,
    call,
    advance(ms) {
      clock += ms;
    },
  };
}

function envelope(response, status = 200) {
  assert.equal(response.status, status);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.match(response.headers['Content-Type'], /application\/json/);
  assert.match(response.json.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(response.json.sources));
  assert.doesNotMatch(
    response.body,
    /information_email|repeaterbook|"county"|sponsor|gateway_key/,
    'raw directory fields never reach the browser',
  );
  return response.json;
}

test('the nearby route validates the search, queries FM + D-STAR and caches per 0.1° cell', async () => {
  const h = harness();
  const body = envelope(await h.call('/nearby?lat=52.19&lon=7.04&radiusKm=80'));
  assert.equal(body.repeaters.length, 14, '6 FM rows + 8 D-STAR modules');
  assert.ok(
    body.repeaters.some((r) => r.kind === 'FM' && r.callsign === 'PI2NON'),
  );
  assert.ok(body.repeaters.some((r) => r.kind === 'D-STAR'));
  assert.deepEqual(body.sources, ['hamrig-fm', 'hamrig-dstar']);
  assert.deepEqual(body.search, {
    lat: 52.19,
    lon: 7.04,
    radiusKm: 80,
    limit: 200,
    band: 'all',
    kind: 'all',
  });
  assert.equal(body.partial, false);
  assert.deepEqual(body.errors, {});
  assert.equal(body.stale, false);
  const distances = body.repeaters.map((r) => r.distanceKm);
  assert.deepEqual(
    distances,
    [...distances].sort((a, b) => a - b),
  );
  const fm = h.calls.find((c) => c.path === '/api/fm/repeaters/nearby');
  assert.deepEqual(fm.query, {
    lat: '52.1900',
    lng: '7.0400',
    radius: '80',
    limit: '200',
  });
  assert.equal(fm.init.redirect, 'manual');
  assert.match(fm.init.headers['User-Agent'], /^GodsEyeView\/1\.0/);
  const dstar = h.calls.find((c) => c.path === '/api/dstar/repeaters/nearby');
  assert.equal(dstar.query.limit, '100', 'D-STAR upstream caps limit at 100');
  assert.equal(h.calls.length, 2);
  await h.call('/nearby?lat=52.21&lon=7.01&radiusKm=80');
  assert.equal(h.calls.length, 2, 'the same 0.1° cell is a cache hit');
  await h.call('/api/ham-repeaters/nearby/?lat=52.21&lon=7.01&radiusKm=80');
  assert.equal(
    h.calls.length,
    2,
    'the mount prefix and a trailing slash are tolerated',
  );
  h.advance(11 * 60 * 1000);
  await h.call('/nearby?lat=52.19&lon=7.04&radiusKm=80');
  assert.equal(h.calls.length, 4, 'refreshed after the TTL');
});

test('band and kind narrow the search; bands the upstream cannot filter are filtered here', async () => {
  const h = harness();
  const fmOnly = envelope(
    await h.call('/nearby?lat=52.19&lon=7.04&kind=fm&band=70cm&limit=3'),
  );
  assert.ok(
    fmOnly.repeaters.every(
      (r) => r.kind === 'FM' && r.outputHz >= 420e6 && r.outputHz <= 450e6,
    ),
  );
  assert.ok(fmOnly.repeaters.length <= 3);
  assert.equal(h.calls.at(-1).query.band, '70cm');
  assert.deepEqual(fmOnly.sources, ['hamrig-fm']);
  const cm23 = envelope(await h.call('/nearby?lat=52.19&lon=7.04&band=23cm'));
  assert.deepEqual(
    cm23.repeaters.map((r) => r.callsign).sort(),
    ['DB0EG', 'PI1MEP'],
    '23 cm rows are filtered locally',
  );
  const fmCall = h.calls
    .filter((c) => c.path === '/api/fm/repeaters/nearby')
    .at(-1);
  assert.equal(fmCall.query.band, undefined, 'no upstream band for 23 cm');
  const dstarOnly = envelope(
    await h.call('/nearby?lat=52.19&lon=7.04&kind=dstar'),
  );
  assert.ok(dstarOnly.repeaters.every((r) => r.kind === 'D-STAR'));
  assert.deepEqual(dstarOnly.sources, ['hamrig-dstar']);
});

test('every search field is bounded and unknown routes or methods are refused', async () => {
  const h = harness();
  for (const [path, message] of [
    ['/nearby', 'lat is required'],
    ['/nearby?lat=52', 'lon is required'],
    ['/nearby?lat=52&lon=7&radiusKm=600', 'radiusKm must be <= 500'],
    [
      '/nearby?lat=52&lon=7&band=11m',
      'band must be one of all, 6m, 2m, 1.25m, 70cm, 23cm',
    ],
    ['/nearby?lat=52&lon=7&kind=dmr', 'kind must be one of all, fm, dstar'],
    ['/nearby?lat=52&lon=7&limit=201', 'limit must be <= 200'],
    ['/nearby?lat=52&lon=7&limit=1.5', 'limit must be an integer'],
    ['/nearby?lat=95&lon=7', 'lat must be <= 90'],
    ['/nearby?lat=abc&lon=7', 'lat must be a number'],
  ]) {
    const response = await h.call(path);
    assert.equal(response.status, 400, path);
    assert.equal(response.json.error, message);
  }
  assert.equal(h.calls.length, 0, 'nothing leaves before validation passes');
  assert.equal((await h.call('/nope')).status, 404);
  const wrongMethod = await h.call('/nearby?lat=52&lon=7', 'POST');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.Allow, 'GET');
});

test('a failed feed is reported as partial; every feed down is 502, then stale from cache', async () => {
  const half = harness({
    routes: {
      '/api/fm/repeaters/nearby': FM,
      '/api/dstar/repeaters/nearby': new Error('dstar down'),
    },
  });
  const partial = envelope(await half.call('/nearby?lat=52.19&lon=7.04'));
  assert.ok(partial.repeaters.every((r) => r.kind === 'FM'));
  assert.equal(partial.partial, true);
  assert.deepEqual(Object.keys(partial.errors), ['D-STAR']);
  assert.match(partial.errors['D-STAR'], /dstar down/);
  assert.deepEqual(partial.sources, ['hamrig-fm']);

  const routes = {
    '/api/fm/repeaters/nearby': FM,
    '/api/dstar/repeaters/nearby': DSTAR,
  };
  const h = harness({ routes });
  envelope(await h.call('/nearby?lat=52.19&lon=7.04'));
  routes['/api/fm/repeaters/nearby'] = () =>
    jsonResponse({ error: 'busy' }, 503);
  routes['/api/dstar/repeaters/nearby'] = () =>
    new Response('', {
      status: 302,
      headers: { Location: 'https://evil.example/' },
    });
  h.advance(11 * 60 * 1000);
  const stale = envelope(await h.call('/nearby?lat=52.19&lon=7.04'));
  assert.equal(stale.stale, true);
  assert.equal(stale.repeaters.length, 14);

  const dead = harness({ routes: {} });
  const failed = await dead.call('/nearby?lat=52.19&lon=7.04');
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /Repeater feeds unavailable/);
  assert.match(failed.json.error, /HTTP 404/);
});

test('the FM table can be switched off and the whole integration disabled', async () => {
  const noFm = harness({ fmEnabled: false });
  const body = envelope(await noFm.call('/nearby?lat=52.19&lon=7.04'));
  assert.ok(body.repeaters.every((r) => r.kind === 'D-STAR'));
  assert.deepEqual(body.sources, ['hamrig-dstar']);
  assert.ok(!noFm.calls.some((c) => c.path === '/api/fm/repeaters/nearby'));
  const off = harness({ enabled: false });
  const disabled = await off.call('/nearby?lat=52.19&lon=7.04');
  assert.equal(disabled.status, 503);
  assert.equal(disabled.json.enabled, false);
  assert.equal(off.calls.length, 0);
});

test('the search key and the environment parser behave', () => {
  const search = parseRepeaterSearch(
    new URLSearchParams(
      'lat=52.19&lon=7.04&radius=80.4&limit=50&band=2m&kind=FM',
    ),
  );
  assert.deepEqual(search, {
    lat: 52.19,
    lon: 7.04,
    radiusKm: 80.4,
    limit: 50,
    band: '2m',
    kind: 'fm',
  });
  assert.equal(repeaterSearchKey(search), 'repeaters:52.2|7.0|80|50|2m|fm');
  assert.deepEqual(parseHamRepeatersEnv({}), {
    enabled: true,
    baseUrl: 'https://hamrig.com',
    fmEnabled: true,
  });
  assert.deepEqual(
    parseHamRepeatersEnv({
      HAMRIG_ENABLED: 'off',
      HAMRIG_BASE_URL: ' https://test.hamrig.com/ ',
      HAM_REPEATERS_HAMRIG_FM: '0',
    }),
    { enabled: false, baseUrl: 'https://test.hamrig.com/', fmEnabled: false },
  );
});

test('the HamRig base URL is the SSRF boundary', () => {
  assert.equal(
    normalizeHamrigBaseUrl('https://test.hamrig.com/'),
    'https://test.hamrig.com',
  );
  assert.equal(
    normalizeHamrigBaseUrl('https://example.org/hamrig/'),
    'https://example.org/hamrig',
  );
  assert.equal(
    normalizeHamrigBaseUrl('http://localhost:8080'),
    'http://localhost:8080',
  );
  assert.equal(normalizeHamrigBaseUrl('http://hamrig.com'), null);
  assert.equal(
    normalizeHamrigBaseUrl('http://hamrig.localhost.evil.com'),
    null,
  );
  assert.equal(normalizeHamrigBaseUrl('https://user:pw@hamrig.com'), null);
  assert.equal(normalizeHamrigBaseUrl('https://hamrig.com/?x=1'), null);
  assert.equal(normalizeHamrigBaseUrl('not a url'), null);
  const unconfigured = createHamrigRepeaterProvider({
    baseUrl: 'http://hamrig.com',
    log: null,
  });
  assert.equal(unconfigured.configured, false);
});

test('fetchHamrigJson bounds the request and classifies transport faults', async () => {
  const ok = await fetchHamrigJson('https://hamrig.com/api/x', {
    fetchImpl: async () => jsonResponse({ success: true }),
  });
  assert.deepEqual(ok, { status: 200, json: { success: true } });
  const html = await fetchHamrigJson('https://hamrig.com/api/x', {
    fetchImpl: async () =>
      new Response('<html>Gateway Timeout</html>', { status: 504 }),
  });
  assert.deepEqual(html, { status: 504, json: null });
  await assert.rejects(
    fetchHamrigJson('https://hamrig.com/api/x', {
      fetchImpl: async () =>
        new Response('', { status: 302, headers: { Location: 'https://x/' } }),
    }),
    { code: 'HAMRIG_REDIRECT' },
  );
  await assert.rejects(
    fetchHamrigJson('https://hamrig.com/api/x', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    }),
    { code: 'HAMRIG_NETWORK' },
  );
  await assert.rejects(
    fetchHamrigJson('https://hamrig.com/api/x', {
      timeoutMs: 5,
      fetchImpl: (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    }),
    { code: 'HAMRIG_TIMEOUT' },
  );
});
