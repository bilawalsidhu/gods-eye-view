// What the ion endpoint cache does when ion does not answer: it keeps serving
// a document whose token is still good, it stops asking ion for a short time,
// and it does not keep a document ion has rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIonEndpointFetcher,
  createIonRouteHandler,
} from './ionEndpoint.js';

const TOKEN = `eyJ${'x'.repeat(30)}.${'y'.repeat(30)}.sig`;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function jwt(expSeconds) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds })}.sig`;
}

const response = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * A fetcher on a clock the test moves, over a fetch the test scripts: set
 * `world.next` to the next upstream answer (a function returning a Response,
 * or throwing).
 */
function setup() {
  const world = {
    clock: 1_000_000,
    calls: 0,
    next: null,
  };
  const good = () => {
    const n = world.calls;
    return response({
      type: 'TERRAIN',
      url: 'https://assets.ion.cesium.com/1',
      accessToken: jwt(world.clock / 1000 + 3600),
      n,
    });
  };
  world.next = good;
  world.good = good;
  const env = { CESIUM_ION_TOKEN: TOKEN };
  const fetchEndpoint = createIonEndpointFetcher({
    env,
    now: () => world.clock,
    fetchImpl: async () => {
      world.calls += 1;
      return world.next();
    },
  });
  return { world, env, fetchEndpoint };
}

const failures = {
  'HTTP 503': () => response({ message: 'down' }, 503),
  'HTTP 500': () => response({ message: 'down' }, 500),
  'HTTP 429': () => response({}, 429),
  'HTTP 408': () => response({}, 408),
  'a network error': () => {
    throw new TypeError('fetch failed');
  },
  'a timeout': () => {
    throw Object.assign(new Error('The operation timed out'), {
      name: 'TimeoutError',
    });
  },
};

for (const [name, fail] of Object.entries(failures)) {
  test(`ion cache: a refetch that fails with ${name} serves the document whose token is still good`, async () => {
    const { world, fetchEndpoint } = setup();
    const first = await fetchEndpoint('1');
    world.clock += 61 * SECOND; // past the minute: a refetch is due
    world.next = fail;
    assert.equal(await fetchEndpoint('1'), first);
    assert.equal(world.calls, 2);
  });
}

test('ion cache: a 408 from ion is a passing failure: ion is left alone for the back-off', async () => {
  const { world, fetchEndpoint } = setup();
  world.next = failures['HTTP 408'];
  const refused = await fetchEndpoint('1').catch((error) => error);
  assert.equal(refused.status, 502);
  assert.equal(refused.retryAfter, 10, 'the default back-off, as for a 429');
  for (let i = 0; i < 20; i += 1)
    assert.equal((await fetchEndpoint('1').catch((e) => e)).status, 502);
  assert.equal(world.calls, 1);
  world.clock += 10 * SECOND;
  await fetchEndpoint('1').catch(() => {});
  assert.equal(world.calls, 2);
});

test('ion cache: a document with less than ten minutes of token left is not served when ion fails', async () => {
  const { world, fetchEndpoint } = setup();
  await fetchEndpoint('1');
  world.clock += 51 * MINUTE;
  world.next = failures['HTTP 503'];
  await assert.rejects(fetchEndpoint('1'), { status: 502 });
  world.clock += 11 * SECOND;
  await assert.rejects(fetchEndpoint('1'), { status: 502 });
});

for (const [status, answered] of [
  [401, 403],
  [403, 403],
  [404, 404],
]) {
  test(`ion cache: ion answering ${status} drops the document and returns the error`, async () => {
    const { world, fetchEndpoint } = setup();
    await fetchEndpoint('1');
    world.clock += 61 * SECOND;
    world.next = () => response({ message: 'no' }, status);
    await assert.rejects(fetchEndpoint('1'), { status: answered });
    // No back-off after a rejection: the next request asks ion again, and if
    // ion is then down there is no document left to serve.
    world.next = failures['HTTP 503'];
    await assert.rejects(fetchEndpoint('1'), { status: 502 });
    assert.equal(world.calls, 3);
  });
}

test('ion cache: an answer that echoes the account token is a passing failure: the held document is served and ion is left alone', async () => {
  const { world, fetchEndpoint } = setup();
  const first = await fetchEndpoint('1');
  world.clock += 61 * SECOND; // a refetch is due
  world.next = () =>
    response({ type: 'TERRAIN', accessToken: TOKEN, note: 'echo' });
  assert.equal(await fetchEndpoint('1'), first, 'the held document is served');
  assert.equal(world.calls, 2);
  for (let i = 0; i < 20; i += 1) assert.equal(await fetchEndpoint('1'), first);
  assert.equal(world.calls, 2, 'ion is not asked again inside the back-off');
  world.clock += 10 * SECOND;
  world.next = world.good;
  const fresh = await fetchEndpoint('1');
  assert.notEqual(fresh, first);
  assert.equal(world.calls, 3, 'one call once the back-off is over');
  assert.equal(fresh.includes(TOKEN), false);
});

for (const status of [401, 403, 404]) {
  test(`ion cache: ion answering ${status} for one asset drops only that asset's document`, async () => {
    const { world, fetchEndpoint } = setup();
    await fetchEndpoint('1');
    world.clock += 30 * SECOND;
    const other = await fetchEndpoint('3');
    world.clock += 31 * SECOND; // asset 1 is due for a refetch, asset 3 is not
    world.next = () => response({ message: 'no' }, status);
    await assert.rejects(fetchEndpoint('1'));
    assert.equal(world.calls, 3);
    assert.equal(await fetchEndpoint('3'), other, 'served from memory');
    assert.equal(
      world.calls,
      3,
      "no call to ion for the other asset's document",
    );
  });
}

test('ion cache: during an outage ion is called once per back-off window however many requests arrive', async () => {
  const { world, fetchEndpoint } = setup();
  const first = await fetchEndpoint('1');
  world.clock += 61 * SECOND;
  world.next = failures['HTTP 503'];
  for (let i = 0; i < 100; i += 1)
    assert.equal(await fetchEndpoint('1'), first);
  assert.equal(world.calls, 2, 'one failed call, then served from memory');
  world.clock += 9 * SECOND;
  for (let i = 0; i < 100; i += 1)
    assert.equal(await fetchEndpoint('1'), first);
  assert.equal(world.calls, 2, 'still inside the window');
  world.clock += 1 * SECOND;
  assert.equal(await fetchEndpoint('1'), first);
  assert.equal(world.calls, 3, 'the window is over: one more call');
});

test('ion cache: with no document to serve the same error is answered from memory, with Retry-After', async () => {
  const { world, fetchEndpoint } = setup();
  world.next = failures['HTTP 503'];
  const refused = await fetchEndpoint('1').catch((error) => error);
  assert.equal(refused.status, 502);
  assert.equal(refused.retryAfter, 10);
  for (let i = 0; i < 50; i += 1) {
    const again = await fetchEndpoint('1').catch((error) => error);
    assert.equal(again.status, 502);
    assert.equal(again.message, refused.message);
  }
  assert.equal(world.calls, 1);
  world.clock += 4 * SECOND;
  const later = await fetchEndpoint('1').catch((error) => error);
  assert.equal(later.retryAfter, 6, 'Retry-After counts down');
  assert.equal(world.calls, 1);
  world.clock += 6 * SECOND;
  await fetchEndpoint('1').catch(() => {});
  assert.equal(world.calls, 2);
});

test("ion cache: ion's Retry-After sets the back-off, capped at a minute", async () => {
  for (const [header, seconds] of [
    ['25', 25],
    ['3600', 60],
    ['2', 2],
    [undefined, 10],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 10],
  ]) {
    const { world, fetchEndpoint } = setup();
    world.next = () =>
      response({}, 429, header === undefined ? {} : { 'retry-after': header });
    const refused = await fetchEndpoint('1').catch((error) => error);
    assert.equal(refused.status, 429, String(header));
    assert.equal(refused.retryAfter, seconds, String(header));
    world.clock += seconds * SECOND - 1;
    await fetchEndpoint('1').catch(() => {});
    assert.equal(world.calls, 1, `${header}: nothing before the window ends`);
    world.clock += 1;
    await fetchEndpoint('1').catch(() => {});
    assert.equal(world.calls, 2, `${header}: a call once it ends`);
  }
  // A 5xx that names a wait is honoured as well.
  const { world, fetchEndpoint } = setup();
  world.next = () => response({}, 503, { 'retry-after': '30' });
  assert.equal((await fetchEndpoint('1').catch((e) => e)).retryAfter, 30);
});

test('ion cache: the first request after the back-off calls ion once and gets the fresh document', async () => {
  const { world, fetchEndpoint } = setup();
  const first = await fetchEndpoint('1');
  world.clock += 61 * SECOND;
  world.next = failures['HTTP 503'];
  await fetchEndpoint('1');
  world.clock += 10 * SECOND;
  world.next = world.good;
  const fresh = await fetchEndpoint('1');
  assert.notEqual(fresh, first);
  assert.equal(world.calls, 3);
  world.next = failures['HTTP 503'];
  for (let i = 0; i < 20; i += 1) assert.equal(await fetchEndpoint('1'), fresh);
  assert.equal(world.calls, 3, 'the new document is served from memory');
  // The earlier failure left nothing behind: a later outage starts a new window.
  world.clock += 61 * SECOND;
  assert.equal(await fetchEndpoint('1'), fresh);
  assert.equal(world.calls, 4);
});

test('ion cache: an outage of one asset does not hold back another', async () => {
  const { world, fetchEndpoint } = setup();
  world.next = failures['HTTP 503'];
  await fetchEndpoint('1').catch(() => {});
  world.next = world.good;
  assert.ok(await fetchEndpoint('3'));
  assert.equal(world.calls, 2);
});

test('ion route: during an outage the route serves the held document, or the error, without spending the limit', async () => {
  const { world, env, fetchEndpoint } = setup();
  let spent = 0;
  const handler = createIonRouteHandler({
    env,
    fetchEndpoint,
    allow: () => {
      spent += 1;
      return true;
    },
  });
  const ask = (assetId = '1') =>
    new Promise((resolve, reject) => {
      const headers = {};
      const res = {
        statusCode: 200,
        setHeader: (name, value) => {
          headers[name.toLowerCase()] = String(value);
        },
        end: (body) =>
          resolve({ status: res.statusCode, headers, text: body ?? '' }),
      };
      Promise.resolve(
        handler(
          {
            method: 'GET',
            url: `/v1/assets/${assetId}/endpoint`,
            headers: {},
            socket: { remoteAddress: '203.0.113.9' },
          },
          res,
        ),
      ).catch(reject);
    });
  const first = await ask();
  assert.equal(first.status, 200);
  world.clock += 61 * SECOND;
  world.next = failures['HTTP 503'];
  for (let i = 0; i < 20; i += 1) {
    const res = await ask();
    assert.equal(res.status, 200);
    assert.equal(res.text, first.text);
  }
  assert.equal(spent, 2, 'the first request and the one that found ion down');

  const cold = await ask('3');
  assert.equal(cold.status, 502);
  assert.equal(cold.headers['retry-after'], '10');
  const spentBefore = spent;
  for (let i = 0; i < 20; i += 1) assert.equal((await ask('3')).status, 502);
  assert.equal(spent, spentBefore, 'known errors cost no limit');
  assert.equal(world.calls, 3);
});
