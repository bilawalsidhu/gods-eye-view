// externalUrlPolicy.test.mjs — pins the shared SSRF validator
// (src/data/externalUrlPolicy.js) used by the radio directory AND the CCTV
// source packs, plus the Range-header validator both CCTV media proxies run
// before forwarding to an upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNonGlobalIpv4, isSafeExternalHttpUrl, safeRangeHeader } from './externalUrlPolicy.js';
import { readSource } from '../testSupport/readSource.js';

test('isSafeExternalHttpUrl: public http(s) URLs pass', () => {
  assert.equal(isSafeExternalHttpUrl('https://cctv.austinmobility.io/image/loc1.jpg'), true);
  assert.equal(isSafeExternalHttpUrl('http://cwwp2.dot.ca.gov/img.jpg'), true, 'plaintext http is a legitimate snapshot shape');
  assert.equal(isSafeExternalHttpUrl('https://93.184.216.34/frame.jpg'), true, 'globally routable IPv4 literal');
  assert.equal(isSafeExternalHttpUrl('https://203.0.113.10/frame.jpg'), false, 'TEST-NET-3 documentation range is non-global');
});

test('isSafeExternalHttpUrl: loopback, private, link-local, and credential URLs fail', () => {
  const hostile = [
    'http://localhost/frame.jpg',
    'http://api.localhost/frame.jpg',
    'http://cam.local/stream',
    'http://127.0.0.1/frame.jpg',
    'http://10.1.2.3/frame.jpg',
    'http://172.16.0.9/frame.jpg',
    'http://172.31.255.1/frame.jpg',
    'http://192.168.1.10/frame.jpg',
    'http://169.254.169.254/latest/meta-data', // cloud metadata service
    'http://100.100.100.100/frame.jpg', // CGNAT
    'http://0.0.0.0/',
    'https://[::1]/frame.jpg', // IPv6 literal
    'https://user:pass@example.com/frame.jpg', // embedded credentials
    'ftp://example.com/file',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    undefined,
  ];
  for (const value of hostile) {
    assert.equal(isSafeExternalHttpUrl(value), false, JSON.stringify(value));
  }
});

test('isSafeExternalHttpUrl: httpsOnly option enforces TLS (radio flavor)', () => {
  assert.equal(isSafeExternalHttpUrl('http://stream.example.com/live', { httpsOnly: true }), false);
  assert.equal(isSafeExternalHttpUrl('https://stream.example.com/live', { httpsOnly: true }), true);
});

test('isNonGlobalIpv4: the reserved ranges, piece by piece', () => {
  assert.equal(isNonGlobalIpv4('8.8.8.8'), false);
  assert.equal(isNonGlobalIpv4('127.0.0.1'), true);
  assert.equal(isNonGlobalIpv4('10.0.0.1'), true);
  assert.equal(isNonGlobalIpv4('172.15.255.255'), false, 'just below the private range');
  assert.equal(isNonGlobalIpv4('172.32.0.1'), false, 'just above the private range');
  assert.equal(isNonGlobalIpv4('224.0.0.1'), true, 'multicast');
  assert.equal(isNonGlobalIpv4('999.1.1.1'), true, 'malformed octet');
  assert.equal(isNonGlobalIpv4('example.com'), false, 'not an IPv4 literal at all');
});

test('safeRangeHeader: single byte ranges pass, everything else is dropped', () => {
  assert.equal(safeRangeHeader('bytes=0-'), 'bytes=0-');
  assert.equal(safeRangeHeader('bytes=100-499'), 'bytes=100-499');
  assert.equal(safeRangeHeader('  bytes=0-1023  '), 'bytes=0-1023', 'trimmed');
  assert.equal(safeRangeHeader('bytes=500-400'), null, 'reversed range');
  assert.equal(safeRangeHeader('bytes=0-99, 200-299'), null, 'multi-range');
  assert.equal(safeRangeHeader('bytes=-500'), null, 'suffix form');
  assert.equal(safeRangeHeader('items=0-99'), null, 'wrong unit');
  assert.equal(safeRangeHeader('bytes=12345678901234567890-'), null, '20-digit number rejected');
  assert.equal(safeRangeHeader('bytes=0000000000000000001-'), 'bytes=0000000000000000001-', 'leading zeros stay valid HTTP (19 digits)');
  assert.equal(safeRangeHeader(''), null);
  assert.equal(safeRangeHeader(undefined), null);
  assert.equal(safeRangeHeader(null), null);
});

test('both CCTV media proxies validate Range before forwarding (parity anchor)', () => {
  const dev = readSource('../../vite/proxies/cctv.js', import.meta.url);
  const pages = readSource('../../functions/api/cctv/[[path]].js', import.meta.url);
  for (const [name, source] of [['dev', dev], ['pages', pages]]) {
    assert.match(source, /safeRangeHeader\(/, `${name} must validate the client Range header`);
    assert.match(source, /fetchMediaHeadersBounded\(/, `${name} must bound the upstream header wait`);
    assert.match(source, /media\.disarm\(\)/, `${name} must disarm the header timer once it takes the body`);
    assert.doesNotMatch(source, /await fetch\(mediaUrl, \{/, `${name} must not use an unbounded raw fetch for media`);
  }
});
