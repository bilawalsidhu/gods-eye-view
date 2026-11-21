import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitSameSiteRequest,
  parseTrustedProxyIps,
  isTrustedProxyPeer,
  hasProxySignals,
} from './localRequestGate.mjs';
import { admitKeySetupRequest } from './keySetupCore.mjs';

const same = {
  hostHeader: 'localhost:4173',
  protocol: 'http:',
  origin: 'http://localhost:4173',
  secFetchSite: 'same-origin',
};

test('the honest same-origin browser request is admitted', () => {
  assert.equal(admitSameSiteRequest(same).ok, true);
});

test('a cross-site Origin is refused', () => {
  const r = admitSameSiteRequest({ ...same, origin: 'https://evil.example' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('an opaque Origin ("null") is refused even when Host would match', () => {
  const r = admitSameSiteRequest({ ...same, origin: 'null' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Sec-Fetch-Site cross-site without an Origin is refused (the <img> case)', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'localhost:4173',
    protocol: 'http:',
    secFetchSite: 'cross-site',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Sec-Fetch-Site same-site (cross-origin sibling) is refused', () => {
  const r = admitSameSiteRequest({
    ...same,
    origin: 'http://localhost:4173',
    secFetchSite: 'same-site',
  });
  assert.equal(r.ok, false, 'same-site is not same-origin');
  assert.equal(r.status, 403);
});

test('a reverse-proxy signal header is refused', () => {
  for (const header of [
    'x-forwarded-for',
    'forwarded',
    'via',
    'cf-connecting-ip',
    'cf-ray',
    'x-real-ip',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
  ]) {
    const r = admitSameSiteRequest({
      ...same,
      proxyHeaders: { [header]: 'anything' },
    });
    assert.equal(r.ok, false, `${header} present → refused`);
  }
  // An empty forwarding header is not a proxy signal.
  assert.equal(
    admitSameSiteRequest({ ...same, proxyHeaders: { 'x-forwarded-for': '' } })
      .ok,
    true,
  );
});

test('same-origin Origin with Sec-Fetch-Site same-origin is admitted', () => {
  assert.equal(admitSameSiteRequest(same).ok, true);
});

test('no Origin and no Sec-Fetch headers (curl / Node harness) is admitted', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'localhost:4173',
    protocol: 'http:',
  });
  assert.equal(r.ok, true, 'non-browser loopback tools pass');
});

test('Sec-Fetch-Site none (typed URL / bookmark) is admitted', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'localhost:4173',
    protocol: 'http:',
    secFetchSite: 'none',
  });
  assert.equal(r.ok, true);
});

test('a LAN remote address is irrelevant: the function takes no remoteAddress', () => {
  // The credential-panel gate requires a loopback socket; this gate does not.
  // Passing a LAN-shaped Host/Origin pair must still match (LAN opt-in works).
  const lan = admitSameSiteRequest({
    hostHeader: '192.168.1.5:4173',
    protocol: 'http:',
    origin: 'http://192.168.1.5:4173',
    secFetchSite: 'same-origin',
  });
  assert.equal(lan.ok, true, 'a same-origin LAN browser request is admitted');
});

test('a cross-port or cross-scheme Origin against the same Host is refused', () => {
  assert.equal(
    admitSameSiteRequest({ ...same, origin: 'http://localhost:4174' }).ok,
    false,
    'cross-port',
  );
  assert.equal(
    admitSameSiteRequest({ ...same, origin: 'https://localhost:4173' }).ok,
    false,
    'cross-scheme',
  );
  assert.equal(
    admitSameSiteRequest({ ...same, origin: 'http://127.0.0.1:4173' }).ok,
    false,
    'different loopback host',
  );
});

test('an unparseable Origin is refused', () => {
  assert.equal(
    admitSameSiteRequest({ ...same, origin: 'not a url' }).ok,
    false,
  );
});

test('a missing Host with a present Origin is refused (no authority to match)', () => {
  assert.equal(
    admitSameSiteRequest({ ...same, hostHeader: '' }).ok,
    false,
    'empty Host → null authority',
  );
  assert.equal(
    admitSameSiteRequest({ ...same, hostHeader: undefined }).ok,
    false,
    'absent Host → null authority',
  );
});

test('a foreign Host is refused when an Origin is present', () => {
  assert.equal(
    admitSameSiteRequest({ ...same, hostHeader: 'evil.example:4173' }).ok,
    false,
    'foreign Host does not match local Origin',
  );
});

test('parseTrustedProxyIps parses delimited IPs and handles IPv4-mapped IPv6', () => {
  assert.equal(parseTrustedProxyIps('').size, 0);
  assert.equal(parseTrustedProxyIps(null).size, 0);
  assert.equal(parseTrustedProxyIps(undefined).size, 0);
  assert.equal(parseTrustedProxyIps('   ').size, 0);

  const parsed = parseTrustedProxyIps(
    '127.0.0.1, 10.0.0.1  ::1, ::ffff:192.168.1.5',
  );
  assert.equal(parsed.has('127.0.0.1'), true);
  assert.equal(parsed.has('10.0.0.1'), true);
  assert.equal(parsed.has('::1'), true);
  assert.equal(parsed.has('::ffff:192.168.1.5'), true);
  assert.equal(parsed.has('192.168.1.5'), true);
});

test('parseTrustedProxyIps fails closed on malformed CIDR tokens and invalid IP strings', () => {
  const malformed = parseTrustedProxyIps(
    '0.0.0.0/0oops, 172.16.0.0/12garbage, /24x, 1.2.3/24, 1..3.4/24, 1.2.3.4.0/24, 1.2.3.4x, 10.0.0.0/33, localhost',
  );
  assert.equal(malformed.size, 0, 'malformed CIDRs and hostnames must fail closed');

  // Valid /0 and valid /24 are retained
  const valid = parseTrustedProxyIps('0.0.0.0/0, 192.168.1.0/24, 10.0.0.1');
  assert.equal(valid.has('0.0.0.0/0'), true);
  assert.equal(valid.has('192.168.1.0/24'), true);
  assert.equal(valid.has('10.0.0.1'), true);
});

test('isTrustedProxyPeer matches IPv4, IPv6, IPv4-mapped IPv6, and IPv4 CIDR blocks', () => {
  const allowlist = parseTrustedProxyIps(
    '127.0.0.1, ::1, 172.16.0.0/12, 10.0.0.0/8',
  );
  assert.equal(isTrustedProxyPeer('127.0.0.1', allowlist), true);
  assert.equal(isTrustedProxyPeer('::ffff:127.0.0.1', allowlist), true);
  assert.equal(isTrustedProxyPeer('::1', allowlist), true);
  assert.equal(isTrustedProxyPeer('172.17.0.2', allowlist), true);
  assert.equal(isTrustedProxyPeer('::ffff:172.17.0.2', allowlist), true);
  assert.equal(isTrustedProxyPeer('10.254.1.99', allowlist), true);
  assert.equal(isTrustedProxyPeer('192.168.1.5', allowlist), false);
  assert.equal(isTrustedProxyPeer('172.32.0.1', allowlist), false);
  assert.equal(isTrustedProxyPeer(undefined, allowlist), false);
  assert.equal(isTrustedProxyPeer('127.0.0.1', new Set()), false);
});

test('isTrustedProxyPeer fails closed on malformed CIDR allowlist entries and invalid peer addresses', () => {
  // Direct set with malformed entries (bypassing parser)
  const badSet = new Set(['0.0.0.0/0oops', '172.16.0.0/12garbage', '/24x', '1.2.3/24']);
  assert.equal(isTrustedProxyPeer('1.2.3.4', badSet), false);
  assert.equal(isTrustedProxyPeer('172.16.0.5', badSet), false);

  // Valid /0 matches any valid IPv4 peer
  const zeroSet = new Set(['0.0.0.0/0']);
  assert.equal(isTrustedProxyPeer('1.2.3.4', zeroSet), true);
  assert.equal(isTrustedProxyPeer('192.168.1.1', zeroSet), true);

  // Valid /24 matches subnet and rejects outside
  const subnetSet = new Set(['192.168.1.0/24']);
  assert.equal(isTrustedProxyPeer('192.168.1.5', subnetSet), true);
  assert.equal(isTrustedProxyPeer('192.168.2.1', subnetSet), false);

  // Peer addresses with empty or fractional octets fail closed
  assert.equal(isTrustedProxyPeer('1..3.4', subnetSet), false);
  assert.equal(isTrustedProxyPeer('192.168.1.5.0', subnetSet), false);
  assert.equal(isTrustedProxyPeer('192.168.1.5x', subnetSet), false);
});

test('hasProxySignals respects isTrustedProxy boundary', () => {
  // Without trusted proxy: all proxy signals rejected
  assert.equal(
    hasProxySignals(
      { 'x-forwarded-proto': 'https' },
      { isTrustedProxy: false },
    ),
    true,
  );
  assert.equal(
    hasProxySignals(
      { 'x-forwarded-for': '1.2.3.4' },
      { isTrustedProxy: false },
    ),
    true,
  );

  // With trusted proxy: single proto and single hop client IP allowed
  assert.equal(
    hasProxySignals(
      { 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4' },
      { isTrustedProxy: true },
    ),
    false,
  );
  assert.equal(
    hasProxySignals({ 'x-forwarded-proto': 'http' }, { isTrustedProxy: true }),
    false,
  );

  // With trusted proxy: multi-hop / malformed proto rejected
  assert.equal(
    hasProxySignals(
      { 'x-forwarded-proto': 'https, http' },
      { isTrustedProxy: true },
    ),
    true,
  );
  assert.equal(
    hasProxySignals({ 'x-forwarded-proto': 'ftp' }, { isTrustedProxy: true }),
    true,
  );

  // With trusted proxy: multi-hop / comma-separated X-Forwarded-For rejected
  assert.equal(
    hasProxySignals(
      {
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '6.6.6.6, 153.66.23.223',
      },
      { isTrustedProxy: true },
    ),
    true,
  );

  // With trusted proxy: foreign proxy headers still rejected
  for (const header of [
    'forwarded',
    'via',
    'cf-connecting-ip',
    'cf-ray',
    'x-real-ip',
    'x-forwarded-host',
    'x-forwarded-port',
  ]) {
    assert.equal(
      hasProxySignals({ [header]: 'val' }, { isTrustedProxy: true }),
      true,
      `${header} must be rejected`,
    );
  }
});

// Acceptance contract test suite (Maintainer Issue #978 pinned cases)

test('Acceptance Case 1: Untrusted peer with X-Forwarded-Proto is refused with 403', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'example.com',
    origin: 'https://example.com',
    secFetchSite: 'same-origin',
    proxyHeaders: { 'x-forwarded-proto': 'https' },
    isTrustedProxy: false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Acceptance Case 2: Trusted peer with proto=https and matching Origin passes', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'example.com',
    protocol: 'http:',
    origin: 'https://example.com',
    secFetchSite: 'same-origin',
    proxyHeaders: {
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.195',
    },
    isTrustedProxy: true,
  });
  assert.equal(r.ok, true);
});

test('Acceptance Case 3: Trusted peer with foreign Origin is refused with 403', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'example.com',
    origin: 'https://evil.example',
    secFetchSite: 'same-origin',
    proxyHeaders: { 'x-forwarded-proto': 'https' },
    isTrustedProxy: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Acceptance Case 4: Trusted peer with Sec-Fetch-Site=cross-site is refused with 403', () => {
  const r = admitSameSiteRequest({
    hostHeader: 'example.com',
    origin: 'https://example.com',
    secFetchSite: 'cross-site',
    proxyHeaders: { 'x-forwarded-proto': 'https' },
    isTrustedProxy: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('Acceptance Case 5: Trusted peer with malformed/multi proto is refused with 403', () => {
  const multi = admitSameSiteRequest({
    hostHeader: 'example.com',
    origin: 'https://example.com',
    secFetchSite: 'same-origin',
    proxyHeaders: { 'x-forwarded-proto': 'https, http' },
    isTrustedProxy: true,
  });
  assert.equal(multi.ok, false);
  assert.equal(multi.status, 403);

  const invalid = admitSameSiteRequest({
    hostHeader: 'example.com',
    origin: 'https://example.com',
    secFetchSite: 'same-origin',
    proxyHeaders: { 'x-forwarded-proto': 'ws' },
    isTrustedProxy: true,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 403);
});

test('Acceptance Case 6: Direct same-origin request is admitted unchanged', () => {
  assert.equal(admitSameSiteRequest(same).ok, true);
});

test('Acceptance Case 7: Credential-panel proxied request remains refused', () => {
  const r = admitKeySetupRequest({
    method: 'GET',
    remoteAddress: '127.0.0.1',
    hostHeader: 'localhost:4173',
    proxyHeaders: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.error, 'Provider Settings does not answer proxied requests');
});
