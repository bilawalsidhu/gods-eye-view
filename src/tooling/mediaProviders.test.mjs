import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';
import { radioBrowserProxy } from '../../server/providers/radio.js';
import { localProviderPlugins } from '../../server/providers/local.js';

function install(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  return async (url) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method: 'GET' }, res);
    return res;
  };
}

function fixture(t, id) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(
    path.join(root, 'config/cctv_sources.austin.json'),
    JSON.stringify([
      {
        id,
        name: '<Camera & test>',
        lat: 30.27,
        lon: -97.74,
        feedType: 'video',
      },
    ]),
  );
  return root;
}

function isolate(t) {
  for (const name of [
    'CCTV_SOURCES_FILE',
    'CCTV_SOURCES_JSON',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
    'GOOGLE_MAPS_API_KEY',
  ]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('fixture must not fetch');
  });
}

test('CCTV instances resolve their own application source root and isolate catalogs and health', async (t) => {
  isolate(t);
  const first = install(cctvProxy({ sourceRoot: fixture(t, 'first') }));
  const second = install(cctvProxy({ sourceRoot: fixture(t, 'second') }));
  const [a, b] = await Promise.all([first('/sources'), second('/sources')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(
    JSON.parse(a.body).sources.map((s) => s.id),
    ['first'],
  );
  assert.deepEqual(
    JSON.parse(b.body).sources.map((s) => s.id),
    ['second'],
  );
  const stream = JSON.parse((await first('/stream/first')).body);
  assert.equal(stream.feedType, 'mp4');
  assert.equal(stream.mediaUrl, '/api/cctv/media/first');
  assert.equal((await first('/media/first')).status, 404);
  const frame = await first('/frame/first');
  assert.equal(frame.headers['X-CCTV-Source'], 'synthetic');
  assert.match(frame.body, /&lt;Camera &amp; test&gt;/);
  assert.equal(JSON.parse((await first('/health')).body).cameras.length, 1);
  assert.deepEqual(JSON.parse((await second('/health')).body).cameras, []);
});

test('composition creates exactly one CCTV and radio provider without acquisition', (t) => {
  isolate(t);
  const plugins = localProviderPlugins();
  for (const factory of [cctvProxy, radioBrowserProxy]) {
    assert.equal(plugins.filter((p) => p.name === factory().name).length, 1);
  }
});
