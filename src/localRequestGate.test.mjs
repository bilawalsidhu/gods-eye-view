import test from 'node:test';
import assert from 'node:assert/strict';
import { admitSameSiteRequest } from './localRequestGate.mjs';

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
  for (const header of ['x-forwarded-for', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']) {
    const r = admitSameSiteRequest({ ...same, proxyHeaders: { [header]: 'anything' } });
    assert.equal(r.ok, false, `${header} present → refused`);
  }
  // An empty forwarding header is not a proxy signal.
  assert.equal(admitSameSiteRequest({ ...same, proxyHeaders: { 'x-forwarded-for': '' } }).ok, true);
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
  assert.equal(admitSameSiteRequest({ ...same, origin: 'http://localhost:4174' }).ok, false, 'cross-port');
  assert.equal(admitSameSiteRequest({ ...same, origin: 'https://localhost:4173' }).ok, false, 'cross-scheme');
  assert.equal(admitSameSiteRequest({ ...same, origin: 'http://127.0.0.1:4173' }).ok, false, 'different loopback host');
});

test('an unparseable Origin is refused', () => {
  assert.equal(admitSameSiteRequest({ ...same, origin: 'not a url' }).ok, false);
});

test('a missing Host with a present Origin is refused (no authority to match)', () => {
  assert.equal(admitSameSiteRequest({ ...same, hostHeader: '' }).ok, false, 'empty Host → null authority');
  assert.equal(admitSameSiteRequest({ ...same, hostHeader: undefined }).ok, false, 'absent Host → null authority');
});

test('a foreign Host is refused when an Origin is present', () => {
  assert.equal(admitSameSiteRequest({ ...same, hostHeader: 'evil.example:4173' }).ok, false, 'foreign Host does not match local Origin');
});
