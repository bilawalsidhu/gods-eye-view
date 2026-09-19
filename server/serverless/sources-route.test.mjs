import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceHandler } from './sources-route.js';
import { makeReq, makeRes } from '../ondemand/test-helpers.mjs';

const okResult = (data = { count: 1, items: [1] }) => ({
  ok: true,
  status: 200,
  data,
  provenance: { provider: 'P', completeness: { status: 'partial' } },
});

describe('server/serverless/sources-route.js — createSourceHandler', () => {
  test('GET: forwards raw query + pathParams, spreads data, appends provenance and query, caches', async () => {
    let seen;
    const handler = createSourceHandler(
      async (query, ctx) => {
        seen = {
          query,
          pathParams: ctx.pathParams,
          hasSignal: ctx.signal instanceof AbortSignal,
        };
        return okResult();
      },
      { cacheSeconds: 30 },
    );
    const req = makeReq({ method: 'GET', url: '/austin/catalog?limit=5&x=y' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, {
      query: { limit: '5', x: 'y' },
      pathParams: ['austin', 'catalog'],
      hasSignal: true,
    });
    const body = res.json();
    assert.equal(body.count, 1);
    assert.deepEqual(body.provenance.provider, 'P');
    assert.deepEqual(body.query, { limit: '5', x: 'y' });
    assert.equal(res.getHeader('cache-control'), 'public, max-age=30');
  });

  test('HEAD: same status, no body', async () => {
    const handler = createSourceHandler(async () => okResult());
    const req = makeReq({ method: 'HEAD', url: '/' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.text(), '');
  });

  test('POST → 405 with Allow header and structured error', async () => {
    const handler = createSourceHandler(async () => okResult());
    const req = makeReq({ method: 'POST', url: '/' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.getHeader('allow'), 'GET, HEAD');
    assert.equal(res.json().error.code, 'method_not_allowed');
  });

  test('adapter failure → its status, {error:{code,message,param}}, no-store, Retry-After on 429', async () => {
    const handler = createSourceHandler(async () => ({
      ok: false,
      status: 429,
      error: { code: 'rate_limited', message: 'slow down', retry_after: 12 },
    }));
    const req = makeReq({ method: 'GET', url: '/?a=1' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.getHeader('retry-after'), '12');
    assert.equal(res.getHeader('cache-control'), 'no-store');
    assert.deepEqual(res.json(), {
      error: { code: 'rate_limited', message: 'slow down', retry_after: 12 },
    });
  });

  test('400 from the adapter whitelist is passed through verbatim', async () => {
    const handler = createSourceHandler(async () => ({
      ok: false,
      status: 400,
      error: {
        code: 'unknown_param',
        message: 'unknown parameter "zzz"',
        param: 'zzz',
      },
    }));
    const res = makeRes();
    await handler(makeReq({ method: 'GET', url: '/?zzz=1' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.param, 'zzz');
  });

  test('throwing adapter → 502 sources_error, never throws out', async () => {
    const handler = createSourceHandler(async () => {
      throw new Error('boom');
    });
    const res = makeRes();
    await handler(makeReq({ method: 'GET', url: '/' }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, 'sources_error');
  });

  test('client disconnect aborts the adapter signal', async () => {
    let aborted = false;
    const handler = createSourceHandler(
      (query, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({
              ok: false,
              status: 499,
              error: { code: 'cancelled', message: 'x' },
            });
          });
        }),
    );
    const req = makeReq({ method: 'GET', url: '/' });
    const res = makeRes();
    const p = handler(req, res);
    req.emit('close');
    await p;
    assert.equal(aborted, true);
    assert.equal(res.statusCode, 499);
  });

  test('requires a function adapter', () => {
    assert.throws(() => createSourceHandler(null), TypeError);
  });
});
