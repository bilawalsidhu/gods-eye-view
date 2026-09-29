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

test('safeRangeHeader: accepted forms are canonicalized and span-bounded, junk is dropped', () => {
  // Bounding bounds what is ASKED FOR, not what arrives (ported from upstream):
  // an open-ended range cannot request an upstream's whole unknown-size file —
  // it is clamped to one span, and a player wanting more asks for the next.
  const cap = 64 * 1024 * 1024;
  assert.equal(safeRangeHeader('bytes=0-'), `bytes=0-${cap - 1}`, 'open-ended clamped to one span');
  assert.equal(safeRangeHeader('bytes=100-499'), 'bytes=100-499', 'a span under the cap passes through');
  assert.equal(safeRangeHeader('bytes=100-999999999'), `bytes=100-${100 + cap - 1}`, 'an over-wide span is clamped from its first byte');
  assert.equal(safeRangeHeader('  bytes=0-1023  '), 'bytes=0-1023', 'trimmed');
  assert.equal(safeRangeHeader('bytes=500-400'), null, 'reversed range');
  assert.equal(safeRangeHeader('bytes=0-99, 200-299'), null, 'multi-range (its multipart answer would stream uncapped)');
  assert.equal(safeRangeHeader('bytes=-500'), 'bytes=-500', 'suffix form accepted under the cap');
  assert.equal(safeRangeHeader('bytes=-999999999'), `bytes=-${cap}`, 'suffix clamped to the cap');
  assert.equal(safeRangeHeader('bytes=-0'), null, 'a zero suffix is unsatisfiable by definition');
  assert.equal(safeRangeHeader('bytes=-'), null, 'neither position is meaningless');
  assert.equal(safeRangeHeader('BYTES=0-99'), 'bytes=0-99', 'the unit is case-insensitive (RFC 7233 §2.1)');
  assert.equal(safeRangeHeader('items=0-99'), null, 'wrong unit');
  assert.equal(safeRangeHeader('bytes=12345678901234567890-'), null, '20-digit number rejected');
  assert.equal(safeRangeHeader('bytes=9999999999999999999-'), null, 'a 19-digit first byte past 2^53 is not a safe integer');
  assert.equal(safeRangeHeader('bytes=0000000000000000001-'), `bytes=1-${1 + cap - 1}`, 'leading zeros canonicalize to the bounded form');
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

test('isNonGlobalIpv4: every IANA-special range the gate blocks (table)', () => {
  // Wave-6b: one arm per reserved range in the disjunction. Each entry is a
  // real RFC/IANA block; a public address in the same octet-neighborhood
  // guards against an over-broad prefix.
  const blocked = [
    '0.1.2.3', // this-network
    '10.0.0.1', // private
    '127.0.0.1', // loopback
    '100.64.0.1', // CGNAT
    '100.127.255.254', // CGNAT top
    '169.254.1.1', // link-local
    '172.16.0.1', // private
    '172.31.255.254', // private top
    '192.0.0.1', // IETF protocol assignments
    '192.88.99.1', // 6to4 relay
    '192.168.1.1', // private
    '198.18.0.1', // benchmarking
    '198.19.255.254', // benchmarking top
    '198.51.100.7', // documentation
    '203.0.113.9', // documentation
    '224.0.0.1', // multicast
    '255.255.255.255', // broadcast
  ];
  for (const host of blocked) {
    assert.equal(isNonGlobalIpv4(host), true, `${host} must be non-global`);
  }
  const public_ = ['8.8.8.8', '100.63.0.1', '100.128.0.1', '172.32.0.1', '198.20.0.1', '203.0.114.1'];
  for (const host of public_) {
    assert.equal(isNonGlobalIpv4(host), false, `${host} must read as public`);
  }
});

test('isSafeExternalHttpUrl: IPv6 literals, credentials, and truncation dots', () => {
  // Wave-6b: the host-shape arms around the IPv4 table.
  assert.equal(isSafeExternalHttpUrl('http://[2001:db8::1]/stream'), false, 'IPv6 literal');
  assert.equal(isSafeExternalHttpUrl('http://user:pass@example.com/x'), false, 'credentials');
  assert.equal(isSafeExternalHttpUrl('http://camera.example./shot.jpg'), true, 'trailing dot is stripped, host reads public');
  assert.equal(isSafeExternalHttpUrl('http://HOST.LOCAL/x'), false, 'case-insensitive .local');
  assert.equal(isSafeExternalHttpUrl('https://cams.example.com/c/1', { httpsOnly: true }), true);
  assert.equal(isSafeExternalHttpUrl('http://cams.example.com/c/1', { httpsOnly: true }), false, 'httpsOnly rejects http');
});

test('safeRangeHeader: the contract both CCTV media proxies rely on', () => {
  // Wave-6b: pure function, pinned here because the Pages Function twin
  // imports THIS module — a regression here is a production regression.
  assert.equal(safeRangeHeader('bytes=0-'), `bytes=0-${64 * 1024 * 1024 - 1}`, 'open-ended is clamped, never open');
  assert.equal(safeRangeHeader('bytes=100-199'), 'bytes=100-199', 'a span under the cap passes through');
  assert.equal(safeRangeHeader('  bytes=5-9  '), 'bytes=5-9', 'trimmed');
  assert.equal(safeRangeHeader('bytes=199-100'), null, 'reversed range rejected');
  assert.equal(safeRangeHeader('bytes=abc-'), null, 'malformed rejected');
  assert.equal(safeRangeHeader('bytes=0-99999999999999999999999'), null, 'over-long last byte rejected');
  assert.equal(safeRangeHeader('item=0-5'), null, 'non-bytes unit rejected');
  assert.equal(safeRangeHeader(42), null, 'non-string rejected');
  // A caller may tighten the ceiling (the CCTV relays pass their 64 MB body
  // cap explicitly); an unusable ceiling drops the header rather than
  // forwarding something unbounded.
  assert.equal(safeRangeHeader('bytes=0-', 16), 'bytes=0-15', 'a custom ceiling is honored');
  assert.equal(safeRangeHeader('bytes=8-', 16), 'bytes=8-23', 'the window follows the first byte');
  assert.equal(safeRangeHeader('bytes=0-', 0), null, 'a zero ceiling is refused');
});
