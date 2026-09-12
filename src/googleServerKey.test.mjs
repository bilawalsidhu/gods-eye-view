import assert from 'node:assert/strict';
import test from 'node:test';
import config, { googleServerApiKey, googlePlacesContextProxy } from '../vite.config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadApiKey } from '../tools/streetview-headings.mjs';

/** Run fn with the two Google key env vars set to the given values, then restore. */
function withKeys({ server, browser }, fn) {
  const previous = {
    GOOGLE_MAPS_SERVER_API_KEY: process.env.GOOGLE_MAPS_SERVER_API_KEY,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  };
  const apply = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  apply('GOOGLE_MAPS_SERVER_API_KEY', server);
  apply('GOOGLE_MAPS_API_KEY', browser);
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) apply(name, value);
  }
}

test('server-side Google calls prefer the server-only key', () => {
  withKeys({ server: 'server-key', browser: 'browser-key' }, () => {
    assert.equal(googleServerApiKey(), 'server-key');
  });
});

test('unsplit setups still work: falls back to the browser key', () => {
  // The whole point of #33 being opt-in — one shared GOOGLE_MAPS_API_KEY must
  // keep serving Places/Street View exactly as before.
  withKeys({ server: undefined, browser: 'browser-key' }, () => {
    assert.equal(googleServerApiKey(), 'browser-key');
  });
  withKeys({ server: '', browser: 'browser-key' }, () => {
    assert.equal(googleServerApiKey(), 'browser-key');
  });
});

test('keyless stays keyless', () => {
  withKeys({ server: undefined, browser: undefined }, () => {
    assert.ok(!googleServerApiKey());
  });
});

test('the Street View tool resolves per-variable overrides before preferring the server key', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-streetview-key-'));
  const envPath = path.join(root, '.env');
  try {
    writeFileSync(envPath, 'GOOGLE_MAPS_API_KEY=file-browser\nGOOGLE_MAPS_SERVER_API_KEY="file-server" # separate key\n');
    assert.equal(loadApiKey(null, { envPath, environment: { GOOGLE_MAPS_API_KEY: 'shell-browser' } }), 'file-server');
    assert.equal(loadApiKey(null, { envPath, environment: { GOOGLE_MAPS_SERVER_API_KEY: 'shell-server' } }), 'shell-server');
    assert.equal(loadApiKey(null, { envPath, environment: { GOOGLE_MAPS_SERVER_API_KEY: '' } }), 'file-browser');
    assert.equal(loadApiKey('explicit-key', { envPath, environment: {} }), 'explicit-key');
    assert.equal(loadApiKey(null, { envPath: root, environment: { GOOGLE_MAPS_SERVER_API_KEY: 'shell-server' } }), 'shell-server');
    writeFileSync(envPath, 'GOOGLE_MAPS_API_KEY=file-browser\n');
    assert.equal(loadApiKey(null, { envPath, environment: {} }), 'file-browser');
    writeFileSync(envPath, '');
    assert.throws(() => loadApiKey(null, { envPath, environment: {} }), /No API key found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both Places routes select the intended key and keep it out of responses', async (t) => {
  const original = { server: process.env.GOOGLE_MAPS_SERVER_API_KEY, browser: process.env.GOOGLE_MAPS_API_KEY, limit: process.env.GEV_RATELIMIT_GOOGLE_PER_MIN };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, key: options.headers['X-Goog-Api-Key'] });
    return Response.json({ places: [] });
  });
  try {
    process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '';
    for (const [server, browser, expected] of [
      ['server-secret', 'browser-public', 'server-secret'],
      ['server-secret', '', 'server-secret'],
      ['', 'browser-public', 'browser-public'],
      ['   ', 'browser-public', 'browser-public'],
      ['', '', null],
    ]) {
      process.env.GOOGLE_MAPS_SERVER_API_KEY = server;
      process.env.GOOGLE_MAPS_API_KEY = browser;
      for (const install of ['configureServer', 'configurePreviewServer']) {
        const routes = new Map();
        googlePlacesContextProxy()[install]({ middlewares: { use: (name, handler) => routes.set(name, handler) } });
        assert.equal(routes.size, 2);
        for (const handler of routes.values()) {
          const before = calls.length;
          let body;
          const res = { setHeader() {}, end(value) { body = value; } };
          await handler({ method: 'GET', url: '/?lat=30&lon=-97&q=capitol', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
          assert.equal(res.statusCode, 200);
          assert.ok(!body.includes('server-secret'));
          if (expected) {
            assert.equal(calls.length, before + 1);
            assert.equal(calls.at(-1).key, expected);
          } else {
            assert.equal(calls.length, before);
            assert.equal(JSON.parse(body).configured, false);
          }
        }
      }
    }
  } finally {
    for (const [name, value] of Object.entries({ GOOGLE_MAPS_SERVER_API_KEY: original.server, GOOGLE_MAPS_API_KEY: original.browser, GEV_RATELIMIT_GOOGLE_PER_MIN: original.limit })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('browser defines contain the browser key and exclude the server key', () => {
  withKeys({ server: 'server-secret', browser: 'browser-public' }, () => {
    const defines = config({ mode: 'test' }).define;
    assert.equal(defines['import.meta.env.GOOGLE_MAPS_API_KEY'], '"browser-public"');
    assert.ok(!JSON.stringify(defines).includes('server-secret'));
    assert.ok(!Object.keys(defines).some((key) => key.includes('SERVER_API_KEY')));
  });
});
