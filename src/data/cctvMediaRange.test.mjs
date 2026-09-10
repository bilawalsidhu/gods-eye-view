// Client `Range` validation for the CCTV media proxy (issue #27). The route
// used to relay req.headers.range verbatim to a third-party upstream; these
// pin what is now allowed through. Pure string policy, no network.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCctvRangeHeader } from '../../vite.config.js';

const CAP = 64 * 1024 * 1024;

test('single well-formed byte ranges pass through canonicalized', () => {
  assert.equal(sanitizeCctvRangeHeader('bytes=0-1023'), 'bytes=0-1023');
  // Open-ended: the seek form every video player sends.
  assert.equal(sanitizeCctvRangeHeader('bytes=500-'), 'bytes=500-');
  // Suffix: the final N bytes.
  assert.equal(sanitizeCctvRangeHeader('bytes=-500'), 'bytes=-500');
  // A single range that names the same byte twice is legal.
  assert.equal(sanitizeCctvRangeHeader('bytes=7-7'), 'bytes=7-7');
  // The unit is case-insensitive (RFC 7233 §2.1); surrounding space is legal.
  assert.equal(sanitizeCctvRangeHeader('  BYTES=0-99  '), 'bytes=0-99');
});

test('multi-range is dropped so the upstream never answers multipart/byteranges', () => {
  // The relay forwards Content-Length/Content-Range blindly and caps on a
  // single declared body; a multipart response defeats that accounting.
  assert.equal(sanitizeCctvRangeHeader('bytes=0-1,2-3'), '');
  assert.equal(sanitizeCctvRangeHeader('bytes=0-1, 100-200, 300-'), '');
});

test('malformed, non-byte and injected values are dropped, not forwarded', () => {
  for (const bad of [
    'bytes=abc-def',
    'bytes=',
    'bytes=-',
    'bytes=1-2-3',
    '0-100',                       // no unit
    'items=0-100',                 // unit the proxy does not understand
    'bytes=1.5-2',
    'bytes=-0',                    // zero-length suffix is unsatisfiable
    'bytes=0x10-0x20',
    'bytes=+5-10',
    'bytes=-5-10',
    // Header-injection shapes: these must never reach an outbound request.
    'bytes=0-10\r\nX-Injected: 1',
    'bytes=0-10\nHost: evil.example',
  ]) {
    assert.equal(sanitizeCctvRangeHeader(bad), '', `expected drop: ${JSON.stringify(bad)}`);
  }
});

test('non-string and empty inputs yield no Range header', () => {
  // req.headers.range is undefined on a normal GET, and Node hands back an
  // array when a client sends the header twice.
  assert.equal(sanitizeCctvRangeHeader(undefined), '');
  assert.equal(sanitizeCctvRangeHeader(null), '');
  assert.equal(sanitizeCctvRangeHeader(''), '');
  assert.equal(sanitizeCctvRangeHeader('   '), '');
  assert.equal(sanitizeCctvRangeHeader(['bytes=0-1', 'bytes=2-3']), '');
  assert.equal(sanitizeCctvRangeHeader(42), '');
});

test('an explicit span is clamped to the body cap the relay already enforces', () => {
  // A span wider than MEDIA_DECLARED_CAP_BYTES could only end in that cap's
  // 502, so clamping turns a guaranteed failure into partial content.
  assert.equal(sanitizeCctvRangeHeader('bytes=0-999999999999'), `bytes=0-${CAP - 1}`);
  assert.equal(sanitizeCctvRangeHeader('bytes=1000-999999999999'), `bytes=1000-${1000 + CAP - 1}`);
  // Exactly at the cap is untouched.
  assert.equal(sanitizeCctvRangeHeader(`bytes=0-${CAP - 1}`), `bytes=0-${CAP - 1}`);
  // Comfortably under the cap is untouched.
  assert.equal(sanitizeCctvRangeHeader('bytes=0-1048575'), 'bytes=0-1048575');
});

test('inverted and unsafe-integer positions are dropped', () => {
  assert.equal(sanitizeCctvRangeHeader('bytes=500-100'), '');
  // Beyond Number.MAX_SAFE_INTEGER the arithmetic silently loses precision.
  assert.equal(sanitizeCctvRangeHeader('bytes=99999999999999999-'), '');
  // Absurd digit counts are refused before any Number() conversion.
  assert.equal(sanitizeCctvRangeHeader(`bytes=0-${'9'.repeat(64)}`), '');
});
