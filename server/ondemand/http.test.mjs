import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readJsonBody,
  readRawBody,
  BodyError,
  sendJson,
  assertMethod,
  getRequestUrl,
  isSameOrigin,
  rejectCrossOrigin,
} from './http.js';
import { makeReq, makeRes } from './test-helpers.mjs';

describe('server/ondemand/http.js', () => {
  describe('readJsonBody', () => {
    test('returns req.body as-is when already an object', async () => {
      const req = makeReq({ body: { a: 1 } });
      assert.deepEqual(await readJsonBody(req), { a: 1 });
    });

    test('parses req.body when it is a JSON string', async () => {
      const req = makeReq({ body: '{"a":2}' });
      assert.deepEqual(await readJsonBody(req), { a: 2 });
    });

    test('parses req.body when it is a Buffer', async () => {
      const req = makeReq({ body: Buffer.from('{"a":3}') });
      assert.deepEqual(await readJsonBody(req), { a: 3 });
    });

    test('reads the stream via async iteration when req.body is absent', async () => {
      const req = makeReq({});
      req[Symbol.asyncIterator] = async function* () {
        yield Buffer.from('{"a":');
        yield Buffer.from('4}');
      };
      assert.deepEqual(await readJsonBody(req), { a: 4 });
    });

    test('empty body parses to {}', async () => {
      const req = makeReq({ body: '' });
      assert.deepEqual(await readJsonBody(req), {});
    });

    test('throws BodyError(400) on invalid JSON', async () => {
      const req = makeReq({ body: '{not json' });
      await assert.rejects(() => readJsonBody(req), (err) => {
        assert.ok(err instanceof BodyError);
        assert.equal(err.status, 400);
        assert.equal(err.payload.error, 'invalid_json');
        return true;
      });
    });

    test('throws BodyError(413) over the byte cap', async () => {
      const req = makeReq({ body: Buffer.from('x'.repeat(100)) });
      await assert.rejects(() => readJsonBody(req, { maxBytes: 10 }), (err) => {
        assert.ok(err instanceof BodyError);
        assert.equal(err.status, 413);
        return true;
      });
    });
  });

  describe('readRawBody', () => {
    test('returns a Buffer body verbatim', async () => {
      const buf = Buffer.from([1, 2, 3, 4]);
      const req = makeReq({ body: buf });
      const out = await readRawBody(req);
      assert.ok(out.equals(buf));
    });

    test('throws BodyError(415) when the body was pre-parsed into a non-Buffer object', async () => {
      const req = makeReq({ body: { already: 'parsed' } });
      await assert.rejects(() => readRawBody(req), (err) => {
        assert.ok(err instanceof BodyError);
        assert.equal(err.status, 415);
        return true;
      });
    });

    test('throws BodyError(413) over the byte cap', async () => {
      const req = makeReq({ body: Buffer.alloc(20) });
      await assert.rejects(() => readRawBody(req, { maxBytes: 10 }), (err) => {
        assert.equal(err.status, 413);
        return true;
      });
    });

    test('reads the stream when req.body is absent', async () => {
      const req = makeReq({});
      req[Symbol.asyncIterator] = async function* () {
        yield Buffer.from([9, 9]);
      };
      const out = await readRawBody(req);
      assert.ok(out.equals(Buffer.from([9, 9])));
    });
  });

  describe('sendJson / assertMethod', () => {
    test('sendJson sets the mandated headers and serialises the body', () => {
      const res = makeRes();
      sendJson(res, 201, { ok: true });
      assert.equal(res.statusCode, 201);
      assert.equal(res.getHeader('content-type'), 'application/json; charset=utf-8');
      assert.equal(res.getHeader('cache-control'), 'no-store');
      assert.deepEqual(res.json(), { ok: true });
    });

    test('assertMethod sends 405 + Allow for an unsupported method', () => {
      const req = makeReq({ method: 'PUT' });
      const res = makeRes();
      const ok = assertMethod(req, res, ['GET', 'POST']);
      assert.equal(ok, false);
      assert.equal(res.statusCode, 405);
      assert.equal(res.getHeader('allow'), 'GET, POST');
      assert.equal(res.json().error, 'method_not_allowed');
    });

    test('assertMethod allows a supported method through', () => {
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      assert.equal(assertMethod(req, res, ['GET']), true);
      assert.equal(res.ended, false);
    });
  });

  describe('getRequestUrl', () => {
    test('builds a URL from req.url + Host header', () => {
      const req = makeReq({ url: '/api/ondemand/sessions?userId=abc', headers: { host: 'example.com' } });
      const url = getRequestUrl(req);
      assert.equal(url.pathname, '/api/ondemand/sessions');
      assert.equal(url.searchParams.get('userId'), 'abc');
    });
  });

  describe('same-origin guard', () => {
    test('allows a request with no Origin/Referer header', () => {
      const req = makeReq({ headers: { host: 'example.com' } });
      assert.equal(isSameOrigin(req), true);
    });

    test('allows a request whose Origin host matches Host', () => {
      const req = makeReq({ headers: { host: 'example.com', origin: 'https://example.com' } });
      assert.equal(isSameOrigin(req), true);
    });

    test('rejects a request whose Origin host differs from Host', () => {
      const req = makeReq({ headers: { host: 'example.com', origin: 'https://evil.example' } });
      assert.equal(isSameOrigin(req), false);
    });

    test('falls back to Referer when Origin is absent', () => {
      const okReq = makeReq({ headers: { host: 'example.com', referer: 'https://example.com/page' } });
      assert.equal(isSameOrigin(okReq), true);
      const badReq = makeReq({ headers: { host: 'example.com', referer: 'https://evil.example/page' } });
      assert.equal(isSameOrigin(badReq), false);
    });

    test('fails closed on a malformed Origin header', () => {
      const req = makeReq({ headers: { host: 'example.com', origin: 'not-a-url' } });
      assert.equal(isSameOrigin(req), false);
    });

    test('rejectCrossOrigin writes 403 and returns true when rejecting', () => {
      const req = makeReq({ headers: { host: 'example.com', origin: 'https://evil.example' } });
      const res = makeRes();
      const rejected = rejectCrossOrigin(req, res);
      assert.equal(rejected, true);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error, 'cross_origin_rejected');
    });

    test('rejectCrossOrigin returns false and writes nothing for a same-origin request', () => {
      const req = makeReq({ headers: { host: 'example.com', origin: 'https://example.com' } });
      const res = makeRes();
      assert.equal(rejectCrossOrigin(req, res), false);
      assert.equal(res.ended, false);
    });
  });
});
