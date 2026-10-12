import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitTrustedTailnetRequest,
  isDesktopOnlyTailnetPath,
} from './localRequestGate.mjs';
import {
  admitSameSite,
  markTrustedTailnetRequest,
} from '../server/providers/common/same-site.js';

const origin = 'https://desktop.example.ts.net';
const good = {
  remoteAddress: '127.0.0.1',
  configuredOrigin: origin,
  ownerLogin: 'owner@example.invalid',
  headers: {
    host: 'desktop.example.ts.net',
    'tailscale-user-login': 'owner@example.invalid',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.100.100.1',
    origin,
    'sec-fetch-site': 'same-origin',
  },
};

test('private Serve accepts verified owner over loopback HTTPS, including no-Origin fetches', () => {
  assert.equal(admitTrustedTailnetRequest(good).ok, true);
  assert.equal(
    admitTrustedTailnetRequest({
      ...good,
      headers: { ...good.headers, origin: undefined },
    }).ok,
    true,
  );
});
for (const [name, patch] of Object.entries({
  unconfigured: { configuredOrigin: undefined },
  'wildcard origin': { configuredOrigin: 'https://*.ts.net' },
  'remote socket': { remoteAddress: '100.100.100.1' },
  'missing owner': { ownerLogin: '' },
  'wrong owner': { ownerLogin: 'other@example.invalid' },
}))
  test(`private Serve rejects ${name}`, () =>
    assert.equal(admitTrustedTailnetRequest({ ...good, ...patch }).ok, false));
for (const [name, headers] of Object.entries({
  'missing identity / Funnel': { 'tailscale-user-login': undefined },
  'wrong identity': { 'tailscale-user-login': 'other@example.invalid' },
  'multiple identities': {
    'tailscale-user-login': ['owner@example.invalid', 'other@example.invalid'],
  },
  'foreign host': { host: 'foreign.example.ts.net' },
  'host userinfo': { host: 'user@desktop.example.ts.net' },
  'missing TLS signal': { 'x-forwarded-proto': undefined },
  plaintext: { 'x-forwarded-proto': 'http' },
  'foreign forwarded host': { 'x-forwarded-host': 'foreign.example.ts.net' },
  'other proxy': { forwarded: 'for=100.100.100.1' },
  'foreign Origin': { origin: 'https://evil.example' },
  'opaque Origin': { origin: 'null' },
  'Origin path': { origin: origin + '/evil' },
  'cross-site': { 'sec-fetch-site': 'cross-site' },
  'same-site foreign origin': { 'sec-fetch-site': 'same-site' },
}))
  test(`private Serve rejects ${name}`, () =>
    assert.equal(
      admitTrustedTailnetRequest({
        ...good,
        headers: { ...good.headers, ...headers },
      }).ok,
      false,
    ));

test('remote administrative routes are blocked through normalized and encoded spellings', () => {
  for (const path of [
    '/api/setup/status',
    '/api/setup/keys',
    '/mcp',
    '/mcp/extra',
    '/api/realtime/oauth-login',
    '/api/realtime/oauth-status',
    '/api/realtime/debug-log',
    '/%61pi/setup/keys',
    '/api/%73etup/status',
    '/api/%2573etup/status',
    '/x/../api/setup/keys',
    '//api/setup/status',
    '/api/x/../setup/status',
    '/api\\setup/keys',
    '/api/realtime/token?auth=oauth',
    '/api/realtime/token?auth=unexpected',
  ]) {
    assert.equal(isDesktopOnlyTailnetPath(path), true, path);
  }
  for (const path of [
    '/',
    '/src/main.js',
    '/api/cctv/sources',
    '/api/realtime/token',
    '/api/realtime/token?auth=api-key',
  ]) {
    assert.equal(isDesktopOnlyTailnetPath(path), false, path);
  }
});

function response() {
  return { statusCode: 200, setHeader() {}, end() {} };
}

const linkedDocument = {
  ...good,
  method: 'GET',
  requestUrl: '/',
  headers: {
    ...good.headers,
    origin: undefined,
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  },
};
test('verified owner can open the app by clicking a cross-site link, then reload and use same-origin APIs', () => {
  assert.equal(admitTrustedTailnetRequest(linkedDocument).ok, true);
  assert.equal(
    admitTrustedTailnetRequest({ ...linkedDocument, requestUrl: '/index.html' })
      .ok,
    true,
  );
  assert.equal(
    admitTrustedTailnetRequest({
      ...linkedDocument,
      headers: { ...linkedDocument.headers, 'sec-fetch-site': 'none' },
    }).ok,
    true,
  );
  assert.equal(
    admitTrustedTailnetRequest({
      ...good,
      method: 'GET',
      requestUrl: '/api/cctv/sources',
    }).ok,
    true,
  );
});
test('document navigation never relaxes owner, TLS, Origin, API, method or WebSocket boundaries', () => {
  const denied = [
    { ...linkedDocument, ownerLogin: 'another@example.invalid' },
    {
      ...linkedDocument,
      headers: { ...linkedDocument.headers, 'tailscale-user-login': undefined },
    },
    {
      ...linkedDocument,
      headers: { ...linkedDocument.headers, 'x-forwarded-proto': 'http' },
    },
    {
      ...linkedDocument,
      headers: { ...linkedDocument.headers, origin: 'https://evil.example' },
    },
    {
      ...linkedDocument,
      headers: { ...linkedDocument.headers, 'sec-fetch-dest': 'iframe' },
    },
    {
      ...linkedDocument,
      headers: { ...linkedDocument.headers, 'sec-fetch-mode': 'cors' },
    },
    { ...linkedDocument, method: 'POST' },
    { ...linkedDocument, requestUrl: '/api/realtime/token' },
    { ...linkedDocument, requestUrl: '/api/cctv/sources' },
    { ...linkedDocument, requestUrl: '/api/setup/status' },
    { ...linkedDocument, requestUrl: '/api/realtime/token/../../..' },
    { ...linkedDocument, requestUrl: '/api/cctv/sources/../../../' },
    { ...linkedDocument, requestUrl: '/%69ndex.html' },
    {
      ...linkedDocument,
      headers: {
        ...linkedDocument.headers,
        upgrade: 'websocket',
        'sec-websocket-key': 'fixture',
      },
    },
  ];
  for (const input of denied)
    assert.equal(admitTrustedTailnetRequest(input).ok, false);
});
test('headers cannot mint a cost-route trust marker; marked requests still check Origin', () => {
  const req = {
    originalUrl: '/api/realtime/token',
    url: '/',
    headers: good.headers,
    socket: {},
  };
  assert.equal(admitSameSite(req, response()), true);
  markTrustedTailnetRequest(req);
  assert.equal(admitSameSite(req, response()), false);
  req.headers = { ...good.headers, origin: 'https://evil.example' };
  assert.equal(admitSameSite(req, response()), true);
});
test('marking a request never exempts desktop-only routes from ordinary proxy rejection', () => {
  for (const path of [
    '/api/realtime/debug-log',
    '/api/realtime/oauth-login',
    '/api/setup/keys',
    '/mcp',
  ]) {
    const req = { originalUrl: path, headers: good.headers, socket: {} };
    markTrustedTailnetRequest(req);
    assert.equal(admitSameSite(req, response()), true, path);
  }
});
