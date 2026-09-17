import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactKey, shapeUpstreamError, notDocumented } from './errors.js';

describe('server/ondemand/errors.js', () => {
  describe('redactKey', () => {
    test('returns (unset) for undefined/null/empty', () => {
      assert.equal(redactKey(undefined), '(unset)');
      assert.equal(redactKey(null), '(unset)');
      assert.equal(redactKey(''), '(unset)');
    });

    test('fully masks a short secret (<=4 chars)', () => {
      assert.equal(redactKey('abcd'), '***');
      assert.equal(redactKey('a'), '***');
    });

    test('keeps only the last 4 characters of a longer secret', () => {
      assert.equal(redactKey('sk-abcdefgh1234'), '***1234');
    });

    test('never returns the full secret verbatim', () => {
      const secret = 'super-secret-ondemand-api-key-value';
      const redacted = redactKey(secret);
      assert.notEqual(redacted, secret);
      assert.ok(!redacted.includes(secret));
    });
  });

  describe('shapeUpstreamError', () => {
    test('parses a documented {errorCode, message} JSON envelope', async () => {
      const upstream = new Response(JSON.stringify({ errorCode: 'unauthenticated', message: 'bad key' }), {
        status: 401,
      });
      const shaped = await shapeUpstreamError(upstream);
      assert.equal(shaped.error, 'upstream_error');
      assert.equal(shaped.status, 401);
      assert.deepEqual(shaped.upstream, { errorCode: 'unauthenticated', message: 'bad key' });
    });

    test('falls back to raw text when the body is not JSON', async () => {
      const upstream = new Response('<html>502 Bad Gateway</html>', { status: 502 });
      const shaped = await shapeUpstreamError(upstream);
      assert.equal(shaped.status, 502);
      assert.equal(shaped.upstream, '<html>502 Bad Gateway</html>');
    });

    test('caps the raw text at 2 KB', async () => {
      const big = 'x'.repeat(5000);
      const upstream = new Response(big, { status: 500 });
      const shaped = await shapeUpstreamError(upstream);
      assert.equal(shaped.upstream.length, 2048);
    });
  });

  describe('notDocumented', () => {
    test('shapes the mandated 501 payload', () => {
      const payload = notDocumented('webhook payload schema', '\u00a73.3');
      assert.deepEqual(payload, {
        error: 'not documented',
        surface: 'webhook payload schema',
        reference: '\u00a73.3',
      });
    });

    test('merges extra fields', () => {
      const payload = notDocumented('stt raw-audio upload', '\u00a76.1', { hint: 'use /api/ondemand/media' });
      assert.equal(payload.hint, 'use /api/ondemand/media');
    });
  });
});
