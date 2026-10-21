// Third-party keys stay on the server. Pins the ion endpoint route and
// the Mapillary Graph route (server/providers/keyIsolation) and the browser-side
// helpers that replace the injected tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIonEndpointFetcher,
  createIonRouteHandler,
  jwtExpiryMs,
  ION_ALLOWED_ASSETS,
} from './ionEndpoint.js';
import {
  buildGraphUpstream,
  createMapillaryGraphHandler,
} from './mapillaryGraph.js';
import {
  ION_SERVER_MANAGED,
  fetchIonCredential,
  ionRequestOptions,
  ionServerUrl,
  mapillaryGraphEndpoint,
} from '../../../src/sources/serverKeys.js';

const LONG_LIVED_ION = [
  'eyJ',
  'x'.repeat(30),
  '.',
  'y'.repeat(30),
  '.sig',
].join('');
const MLY = `MLY|${'1'.repeat(16)}|${'a'.repeat(32)}`;

function jwt(expSeconds) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds })}.sig`;
}

/** Drive a (req,res) handler like connect would; resolves with the response. */
function call(handler, { method = 'GET', url, remote = '203.0.113.9' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader(name, value) {
        headers[name.toLowerCase()] = String(value);
      },
      on() {},
      end(body) {
        this.writableEnded = true;
        resolve({
          status: this.statusCode,
          headers,
          text: body ?? '',
          json: () => JSON.parse(body),
        });
      },
    };
    Promise.resolve(
      handler(
        { method, url, headers: {}, socket: { remoteAddress: remote } },
        res,
      ),
    ).catch(reject);
  });
}

const response = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/* ---------------------------- Cesium ion route ---------------------------- */

test('ion: status says configured without revealing the token', async () => {
  const handler = createIonRouteHandler({
    env: { CESIUM_ION_TOKEN: LONG_LIVED_ION },
  });
  const res = await call(handler, { url: '/status' });
  assert.deepEqual(res.json(), { configured: true });
  assert.ok(!res.text.includes(LONG_LIVED_ION));
  const none = createIonRouteHandler({ env: {} });
  assert.deepEqual((await call(none, { url: '/status' })).json(), {
    configured: false,
  });
});

test('ion: endpoint is fetched with the server token; client credentials are ignored', async () => {
  const calls = [];
  const short = jwt(Math.floor(Date.now() / 1000) + 3600);
  const env = { CESIUM_ION_TOKEN: LONG_LIVED_ION };
  const fetchEndpoint = createIonEndpointFetcher({
    env,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return response({
        type: 'TERRAIN',
        url: 'https://assets.ion.cesium.com/1',
        accessToken: short,
      });
    },
  });
  const handler = createIonRouteHandler({ fetchEndpoint, env });
  const res = await call(handler, {
    url: '/v1/assets/1/endpoint?access_token=attacker-supplied',
  });
  assert.equal(res.status, 200);
  assert.equal(
    res.json().accessToken,
    short,
    'only the short-lived token is returned',
  );
  assert.ok(!res.text.includes(LONG_LIVED_ION));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cesium.com/v1/assets/1/endpoint');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${LONG_LIVED_ION}`);
  assert.ok(!calls[0].url.includes('attacker'));
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('ion: endpoints are cached until their token nears expiry, then refreshed', async () => {
  let clock = 1_000_000;
  let n = 0;
  const fetchEndpoint = createIonEndpointFetcher({
    env: { CESIUM_ION_TOKEN: LONG_LIVED_ION },
    now: () => clock,
    fetchImpl: async () => {
      n += 1;
      return response({
        type: 'TERRAIN',
        accessToken: jwt(clock / 1000 + 3600),
        n,
      });
    },
  });
  await fetchEndpoint('1');
  await fetchEndpoint('1');
  assert.equal(n, 1, 'second call is served from memory');
  clock += 51 * 60 * 1000; // under 10 minutes of token left
  await fetchEndpoint('1');
  assert.equal(n, 2);
});

test('ion: concurrent requests for one asset share a single upstream call', async () => {
  let n = 0;
  const fetchEndpoint = createIonEndpointFetcher({
    env: { CESIUM_ION_TOKEN: LONG_LIVED_ION },
    fetchImpl: async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 10));
      return response({ type: 'IMAGERY', externalType: 'BING', options: {} });
    },
  });
  await Promise.all([
    fetchEndpoint('2'),
    fetchEndpoint('2'),
    fetchEndpoint('2'),
  ]);
  assert.equal(n, 1);
});

test('ion: only the app’s assets are served; other methods and routes are refused', async () => {
  let n = 0;
  const handler = createIonRouteHandler({
    env: { CESIUM_ION_TOKEN: LONG_LIVED_ION },
    fetchEndpoint: async () => {
      n += 1;
      return '{}';
    },
  });
  for (const id of ['1', '2', '3', '4', '2275207'])
    assert.ok(ION_ALLOWED_ASSETS.has(id));
  assert.equal(
    (await call(handler, { url: '/v1/assets/96188/endpoint' })).status,
    404,
  );
  assert.equal(
    (await call(handler, { url: '/v1/assets/1/endpoint/x' })).status,
    404,
  );
  assert.equal((await call(handler, { url: '/v1/tokens' })).status, 404);
  assert.equal(
    (await call(handler, { method: 'POST', url: '/v1/assets/1/endpoint' }))
      .status,
    405,
  );
  assert.equal(n, 0, 'nothing reached ion');
});

test('ion: no token → 503 keyRequired; rejected token → 403 keyRejected; echo of the token → 502', async () => {
  const noKey = createIonRouteHandler({ env: {} });
  const a = await call(noKey, { url: '/v1/assets/1/endpoint' });
  assert.equal(a.status, 503);
  assert.equal(a.json().keyRequired, true);

  const rejected = createIonRouteHandler({
    env: { CESIUM_ION_TOKEN: LONG_LIVED_ION },
    fetchEndpoint: createIonEndpointFetcher({
      env: { CESIUM_ION_TOKEN: LONG_LIVED_ION },
      fetchImpl: async () => response({ message: 'no' }, 401),
    }),
  });
  const b = await call(rejected, { url: '/v1/assets/1/endpoint' });
  assert.equal(b.status, 403);
  assert.equal(b.json().keyRejected, true);

  const echoing = createIonRouteHandler({
    env: { CESIUM_ION_TOKEN: LONG_LIVED_ION },
    fetchEndpoint: createIonEndpointFetcher({
      env: { CESIUM_ION_TOKEN: LONG_LIVED_ION },
      fetchImpl: async () => response({ accessToken: LONG_LIVED_ION }),
    }),
  });
  const c = await call(echoing, { url: '/v1/assets/1/endpoint' });
  assert.equal(c.status, 502);
  assert.ok(!c.text.includes(LONG_LIVED_ION));
});

test('ion: jwtExpiryMs reads exp and tolerates non-JWTs', () => {
  assert.equal(jwtExpiryMs(jwt(1234)), 1_234_000);
  assert.equal(jwtExpiryMs('not-a-jwt'), null);
  assert.equal(jwtExpiryMs(undefined), null);
});

/* ------------------------- Mapillary Graph route ------------------------- */

test('graph: only the paths MapillaryJS and the app use are forwarded', () => {
  const ok = [
    '/images?image_ids=1,2&fields=id,geometry',
    '/images?s2=1234&fields=id',
    '/images?lat=1&lng=2&radius=5&limit=3&fields=id',
    '/image_ids?sequence_id=abc-123',
    '/123456789012345/tiles?z=14&fields=url,z,x,y',
    '/123456789012345?fields=id',
  ];
  for (const url of ok)
    assert.ok(
      buildGraphUpstream(url)?.startsWith('https://graph.mapillary.com/'),
      url,
    );
  for (const url of [
    '/',
    '/me',
    '/../x',
    '/images/extra',
    '/abc',
    '//evil.example/images',
    '/images?fields=a b',
  ])
    assert.equal(buildGraphUpstream(url), null, url);
});

test('graph: a client-supplied access_token is dropped, not forwarded', () => {
  const upstream = buildGraphUpstream(
    '/images?image_ids=1&access_token=stolen&fields=id',
  );
  assert.ok(!upstream.includes('access_token'));
  assert.ok(!upstream.includes('stolen'));
});

test('graph: the server adds the token as an Authorization header, never in the URL', async () => {
  const calls = [];
  const handler = createMapillaryGraphHandler({
    env: { MAPILLARY_CLIENT_TOKEN: MLY },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return response({
        data: [{ id: '1', thumb_1024_url: 'https://scontent.example/a.jpg' }],
      });
    },
  });
  const res = await call(handler, {
    url: '/images?image_ids=1&fields=id,thumb_1024_url',
  });
  assert.equal(res.status, 200);
  assert.equal(
    res.json().data[0].thumb_1024_url,
    'https://scontent.example/a.jpg',
  );
  assert.equal(calls[0].init.headers.Authorization, `OAuth ${MLY}`);
  assert.ok(!calls[0].url.includes('MLY'));
  assert.ok(!res.text.includes(MLY));
  assert.equal(calls[0].init.redirect, 'error');
});

test('graph: no key → 503 keyRequired; rejected key → 403 keyRejected; 429 keeps Retry-After', async () => {
  const mk = (env, impl) =>
    createMapillaryGraphHandler({
      env,
      fetchImpl: impl ?? (async () => response({})),
    });
  const noKey = await call(mk({}), { url: '/images?fields=id' });
  assert.equal(noKey.status, 503);
  assert.equal(noKey.json().keyRequired, true);

  const rejected = await call(
    mk({ MAPILLARY_CLIENT_TOKEN: MLY }, async () =>
      response({ error: {} }, 401),
    ),
    { url: '/images?fields=id' },
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.json().keyRejected, true);

  const limited = await call(
    mk({ MAPILLARY_CLIENT_TOKEN: MLY }, async () =>
      response({}, 429, { 'retry-after': '12' }),
    ),
    { url: '/images?fields=id' },
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '12');
});

test('graph: an answer that quotes the token is refused; bad paths never reach Mapillary', async () => {
  let n = 0;
  const handler = createMapillaryGraphHandler({
    env: { MAPILLARY_CLIENT_TOKEN: MLY },
    fetchImpl: async () => {
      n += 1;
      return response({ error: { message: `bad token ${MLY}` } }, 400);
    },
  });
  const echoed = await call(handler, { url: '/images?fields=id' });
  assert.equal(echoed.status, 502);
  assert.ok(!echoed.text.includes(MLY));
  const before = n;
  assert.equal((await call(handler, { url: '/me' })).status, 400);
  assert.equal(
    (await call(handler, { method: 'POST', url: '/images' })).status,
    405,
  );
  assert.equal(n, before);
});

test('graph: upstream errors without the token pass through with their status', async () => {
  const handler = createMapillaryGraphHandler({
    env: { MAPILLARY_CLIENT_TOKEN: MLY },
    fetchImpl: async () =>
      response({ error: { message: 'Invalid fields' } }, 400),
  });
  const res = await call(handler, { url: '/images?fields=zzz' });
  assert.equal(res.status, 400);
  assert.match(res.json().error.message, /Invalid fields/);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('graph: requests are rate limited per client', async () => {
  const handler = createMapillaryGraphHandler({
    env: { MAPILLARY_CLIENT_TOKEN: MLY },
    allow: (() => {
      let left = 2;
      return () => left-- > 0;
    })(),
    fetchImpl: async () => response({ data: [] }),
  });
  assert.equal((await call(handler, { url: '/images?fields=id' })).status, 200);
  assert.equal((await call(handler, { url: '/images?fields=id' })).status, 200);
  const third = await call(handler, { url: '/images?fields=id' });
  assert.equal(third.status, 429);
  assert.equal(third.headers['retry-after'], '5');
});

/* ------------------------------ browser side ------------------------------ */

test('browser: the server-managed marker routes ion to this app with no token', () => {
  const options = ionRequestOptions(
    ION_SERVER_MANAGED,
    'https://gev.example/map?x=1',
  );
  assert.deepEqual(options, {
    accessToken: '',
    server: 'https://gev.example/api/ion/',
  });
  assert.equal(
    ionServerUrl('http://localhost:4173/'),
    'http://localhost:4173/api/ion/',
  );
  // An explicit token (embedders) is passed through exactly as before.
  assert.deepEqual(ionRequestOptions('explicit'), { accessToken: 'explicit' });
});

test('browser: ion status resolves to the marker, never a token; failures read as unconfigured', async () => {
  const ok = await fetchIonCredential(async (url) => {
    assert.equal(url, '/api/ion/status');
    return response({ configured: true });
  });
  assert.equal(ok, ION_SERVER_MANAGED);
  assert.equal(
    await fetchIonCredential(async () => response({ configured: false })),
    '',
  );
  assert.equal(await fetchIonCredential(async () => response({}, 503)), '');
  assert.equal(
    await fetchIonCredential(async () => {
      throw new Error('offline');
    }),
    '',
  );
});

test('browser: Mapillary Graph endpoint is absolute, same-origin and ends with a slash', () => {
  const endpoint = mapillaryGraphEndpoint('https://gev.example/a/b');
  assert.equal(endpoint, 'https://gev.example/api/mapillary/graph/');
  assert.equal(
    new URL('images', endpoint).pathname,
    '/api/mapillary/graph/images',
  );
});
