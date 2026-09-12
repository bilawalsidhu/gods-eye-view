import test from 'node:test';
import assert from 'node:assert/strict';
import { cctvUpstreamHeaders } from '../vite.config.js';

test('a host that demands a Referer gets one, and every other host does not', () => {
  // Measured 2026-09-11: stream.inmoves.nl answers a frame request with HTTP
  // 401 and a 1093-byte placeholder PNG unless a Referer is present, and with
  // the real JPEG when it is. Without this the Rijkswaterstaat pack renders as
  // silently blank cameras rather than as an error.
  const rws = cctvUpstreamHeaders('https://stream.inmoves.nl/40');
  assert.equal(rws.Referer, 'https://www.rwsverkeersinfo.nl/');

  const tfl = cctvUpstreamHeaders('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/x.jpg');
  assert.equal('Referer' in tfl, false, 'no unrelated host may be given a Referer');
});

test('the User-Agent is always present, Referer or not', () => {
  assert.equal(cctvUpstreamHeaders('https://stream.inmoves.nl/40')['User-Agent'],
    'gods-eye-view-cctv-proxy/1.0');
  assert.equal(cctvUpstreamHeaders('https://cctv.austinmobility.io/image/1.jpg')['User-Agent'],
    'gods-eye-view-cctv-proxy/1.0');
});

test('the Referer is keyed on host, not on a substring of the URL', () => {
  // A look-alike host must not inherit the header, and a path that merely
  // mentions the host must not either.
  assert.equal('Referer' in cctvUpstreamHeaders('https://stream.inmoves.nl.evil.test/40'), false);
  assert.equal('Referer' in cctvUpstreamHeaders('https://example.test/stream.inmoves.nl/40'), false);
});

test('a value that is not an absolute URL yields headers rather than throwing', () => {
  assert.deepEqual(cctvUpstreamHeaders('not a url'), { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' });
  assert.deepEqual(cctvUpstreamHeaders(''), { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' });
  assert.deepEqual(cctvUpstreamHeaders(undefined), { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' });
});
