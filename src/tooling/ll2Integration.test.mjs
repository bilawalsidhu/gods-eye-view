import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import { launchLibraryRecentUrl } from '../data/spaceProviderRequests.js';
import {
  launchLibraryRequestHeaders,
  rocketLaunchesProxy,
} from '../../server/providers/space/launch-library.js';
import { keySetupStatus } from '../keySetupCore.mjs';
import { initKeySetup } from '../keySetup.js';

test('LL2 requests from the same UTC minute share a cache key without mutating callers', () => {
  const first = new Date('2026-10-17T16:20:00.001Z');
  const last = new Date('2026-10-17T16:20:59.999Z');
  assert.equal(
    launchLibraryRecentUrl(first).href,
    launchLibraryRecentUrl(last).href,
  );
  assert.equal(first.toISOString(), '2026-10-17T16:20:00.001Z');
  assert.equal(last.toISOString(), '2026-10-17T16:20:59.999Z');
});

for (const [date, end] of [
  ['2026-10-17T16:20:00.001Z', '2026-10-17T16:20:00.000Z'],
  ['2026-10-17T16:20:59.999Z', '2026-10-17T16:20:00.000Z'],
  ['2026-10-17T16:21:00.000Z', '2026-10-17T16:21:00.000Z'],
  ['2026-01-01T00:00:00.001Z', '2026-01-01T00:00:00.000Z'],
]) {
  test(`LL2 bounds retain the 30-day UTC window at ${date}`, () => {
    const url = launchLibraryRecentUrl(new Date(date));
    assert.equal(url.origin, 'https://ll.thespacedevs.com');
    assert.equal(url.pathname, '/2.3.0/launches/');
    assert.equal(url.searchParams.get('net__lte'), end);
    assert.equal(
      Date.parse(end) - Date.parse(url.searchParams.get('net__gte')),
      30 * 86400000,
    );
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('mode'), 'detailed');
  });
}

test('LL2 headers identify the app and preserve optional server-only authorization', () => {
  const publicHeaders = launchLibraryRequestHeaders('');
  assert.match(publicHeaders['User-Agent'], /^gods-eye-view.*\/1\.0 /);
  assert.ok(
    publicHeaders['User-Agent'].includes(
      'https://github.com/bilawalsidhu/gods-eye-view',
    ),
  );
  assert.equal(publicHeaders.Accept, 'application/json');
  assert.equal(publicHeaders.Authorization, undefined);
  const paidHeaders = launchLibraryRequestHeaders(' owned-fixture-token ');
  assert.equal(paidHeaders.Authorization, 'Token owned-fixture-token');
  assert.equal(paidHeaders['User-Agent'], publicHeaders['User-Agent']);
});

test('actual setup rendering distinguishes optional paid LL2 from unrelated free keys', async () => {
  const created = [];
  const node = () => {
    const value = {
      dataset: {},
      children: [],
      append(...children) {
        this.children.push(...children);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      remove() {},
    };
    created.push(value);
    return value;
  };
  const rows = node();
  const root = node();
  root.querySelector = (selector) =>
    selector === '[data-key-setup-rows]' ? rows : null;
  const chip = node();
  const status = keySetupStatus({});
  status.keys = status.keys.filter((key) =>
    ['launch-library', 'mapillary'].includes(key.id),
  );
  const setup = await initKeySetup({
    documentRef: {
      getElementById: (id) => (id === 'key-setup-chip' ? chip : root),
      createElement: node,
      addEventListener() {},
      removeEventListener() {},
    },
    fetchImpl: async () => ({ ok: true, json: async () => status }),
  });
  assert.ok(setup);
  try {
    const ll2 = rows.children.find(
      (row) => row.dataset.keyId === 'launch-library',
    );
    const free = rows.children.find((row) => row.dataset.keyId === 'mapillary');
    const tier = (row) =>
      row.children[0].children.find(
        (child) => child.className === 'key-setup-tier',
      );
    assert.match(tier(ll2).title, /optional paid token/i);
    assert.match(ll2.children[1].textContent, /leave blank/i);
    assert.match(ll2.children[1].textContent, /no key/i);
    assert.equal(tier(free).title, 'Free key — register, paste, done');
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes('owned-fixture-token'));
  } finally {
    setup.destroy();
  }
});

test('real LL2 proxy sends cacheable headers and bounds, retaining its memory cache', async (t) => {
  for (const method of ['readFile', 'stat'])
    t.mock.method(fsp, method, async () => {
      throw new Error('owned fixture has no disk cache');
    });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(
      JSON.stringify({ results: [{ id: 'owned-launch-fixture' }] }),
    );
  });
  let handler;
  rocketLaunchesProxy().configureServer({
    middlewares: {
      use(route, value) {
        assert.equal(route, '/api/launches');
        handler = value;
      },
    },
  });
  async function request() {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET' }, res);
    return res;
  }
  const first = await request();
  const second = await request();
  assert.equal(first.status, 200);
  assert.equal(second.body, first.body);
  assert.equal(second.headers['X-GEV-Cache'], 'HIT');
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.headers['User-Agent'], /gods-eye-view/);
  assert.match(calls[0].url.searchParams.get('net__lte'), /:00\.000Z$/);
  assert.match(calls[0].url.searchParams.get('net__gte'), /:00\.000Z$/);
});

for (const preview of [false, true]) {
  test(`LL2 proxy sends its identifying headers over real owned HTTP in ${preview ? 'preview' : 'development'}`, async (t) => {
    for (const method of ['readFile', 'stat'])
      t.mock.method(fsp, method, async () => {
        throw new Error('no owned cache');
      });
    t.mock.method(fsp, 'mkdir', async () => {});
    t.mock.method(fsp, 'writeFile', async () => {});
    const received = [];
    const upstream = http.createServer((req, res) => {
      received.push({
        url: new URL(req.url, 'http://fixture.invalid'),
        headers: req.headers,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [{ id: 'owned-wire-fixture' }] }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://ll.thespacedevs.com');
      return originalFetch(
        `http://127.0.0.1:${upstream.address().port}${parsed.pathname}${parsed.search}`,
        options,
      );
    });
    let handler;
    const plugin = rocketLaunchesProxy();
    plugin[preview ? 'configurePreviewServer' : 'configureServer']({
      middlewares: {
        use(_route, value) {
          handler = value;
        },
      },
    });
    const proxy = http.createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const result = await originalFetch(
        `http://127.0.0.1:${proxy.address().port}/api/launches`,
      );
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), {
        results: [{ id: 'owned-wire-fixture' }],
      });
      assert.equal(received.length, 1);
      assert.match(
        received[0].headers['user-agent'],
        /^gods-eye-view-launch-library-proxy\/1\.0 /,
      );
      assert.equal(received[0].headers.authorization, undefined);
      assert.match(received[0].url.searchParams.get('net__lte'), /:00\.000Z$/);
    } finally {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    }
  });
}
