// Contract tests for the dev-server FIRMS middleware (vite/proxies/firms.js).
// The upstream/cache semantics are shared with the Pages Function twin and
// covered by functions/api/firms.test.mjs; this file pins the DEV-only
// behavior: plugin shape, /api/firms mount, and the IPv6 Happy-Eyeballs
// workaround (issue #68 / PR #126).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { firmsProxy } from '../../vite/proxies/firms.js';

/** Capture middleware registrations without a real Vite server. */
function fakeServer() {
  const routes = [];
  return {
    routes,
    server: { middlewares: { use: (path, fn) => routes.push({ path, fn }) } },
  };
}

test('firmsProxy exposes the expected plugin shape and mount', () => {
  const plugin = firmsProxy();
  assert.equal(plugin.name, 'firms-proxy');
  assert.equal(typeof plugin.configureServer, 'function');
  const { routes, server } = fakeServer();
  plugin.configureServer(server);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/firms');
  assert.equal(typeof routes[0].fn, 'function');
});

test('configureServer pins single-family connect by default (issue #68)', () => {
  const original = net.setDefaultAutoSelectFamily;
  let observed;
  net.setDefaultAutoSelectFamily = (value) => { observed = value; };
  try {
    const plugin = firmsProxy();
    const { server } = fakeServer();
    plugin.configureServer(server);
    assert.equal(observed, false, 'dev boxes with unreachable IPv6 must not race families');
  } finally {
    net.setDefaultAutoSelectFamily = original;
  }
});

test('FIRMS_KEEP_AUTO_SELECT_FAMILY=1 opts out of the pin', () => {
  const original = net.setDefaultAutoSelectFamily;
  let calls = 0;
  net.setDefaultAutoSelectFamily = () => { calls += 1; };
  const originalEnv = process.env.FIRMS_KEEP_AUTO_SELECT_FAMILY;
  process.env.FIRMS_KEEP_AUTO_SELECT_FAMILY = '1';
  try {
    const plugin = firmsProxy();
    const { server } = fakeServer();
    plugin.configureServer(server);
    assert.equal(calls, 0, 'IPv6-primary networks keep Happy Eyeballs');
  } finally {
    net.setDefaultAutoSelectFamily = original;
    if (originalEnv === undefined) delete process.env.FIRMS_KEEP_AUTO_SELECT_FAMILY;
    else process.env.FIRMS_KEEP_AUTO_SELECT_FAMILY = originalEnv;
  }
});

beforeEach(() => {
  delete process.env.FIRMS_KEEP_AUTO_SELECT_FAMILY;
});
