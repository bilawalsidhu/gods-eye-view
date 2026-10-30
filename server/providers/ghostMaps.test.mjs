import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createGhostMapsWatcher,
  ghostMapsPollMs,
  ghostMapsProxy,
} from './ghostMaps.js';

const MASTER =
  'ArcGIS Data for ATAK (KMZs)/Common Intelligence Picture/Master Database/';
const KINETIC =
  'ArcGIS Data for ATAK (KMZs)/Common Intelligence Picture/30-Day Pulls/Kinetic_Activities_Last_30_Days.kmz';
const sha = (c) => c.repeat(40);

/** A fake GitHub: ref advertisement, tree, commit and raw files. */
function fakeGitHub() {
  const repo = { head: sha('1'), trees: new Map(), calls: [] };
  repo.trees.set(sha('1'), [
    {
      path: `${MASTER}S2U_Common_Intelligence_Picture_October_15_2026_Export_1.kmz`,
      type: 'blob',
      size: 4,
      sha: sha('a'),
    },
    { path: KINETIC, type: 'blob', size: 4, sha: sha('b') },
  ]);
  const body = (text, status = 200) =>
    new Response(text, {
      status,
      headers: { 'content-length': String(Buffer.byteLength(text)) },
    });
  const fetchImpl = async (url) => {
    repo.calls.push(url);
    if (url.endsWith('/info/refs?service=git-upload-pack'))
      return body(
        `001e# service=git-upload-pack\n0000\n003d${repo.head} refs/heads/main\n0000`,
      );
    const tree = /git\/trees\/([0-9a-f]{40})/.exec(url);
    if (tree) return body(JSON.stringify({ tree: repo.trees.get(tree[1]) }));
    if (/\/commits\//.test(url))
      return body(
        JSON.stringify({
          commit: {
            message: 'Oct 18 Update\nmore',
            committer: { date: '2026-10-18T00:00:00Z' },
          },
        }),
      );
    if (url.startsWith('https://raw.githubusercontent.com/'))
      return body('KMZ!');
    return body('nope', 404);
  };
  return { repo, fetchImpl };
}

async function withCache(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ghostmaps-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// checkNow announces the catalog before background warm-up finishes. Join the
// same file reads before changing editions or removing the temporary cache.
async function warmDefaults(watcher) {
  await Promise.all(
    watcher
      .catalog()
      .products.filter((product) => product.defaultOn)
      .map((product) => watcher.file(product.id)),
  );
}

test('a new commit is announced once, naming only the products that changed', () =>
  withCache(async (cacheDir) => {
    const { repo, fetchImpl } = fakeGitHub();
    const watcher = createGhostMapsWatcher({
      fetchImpl,
      cacheDir,
      log: () => {},
      warn: () => {},
    });
    const events = [];
    watcher.subscribe((catalog) => events.push(catalog));

    assert.equal(await watcher.checkNow(), true);
    await warmDefaults(watcher);
    const first = watcher.catalog();
    assert.equal(first.commit, sha('1'));
    assert.equal(first.message, 'Oct 18 Update');
    assert.deepEqual(
      first.products.map((p) => p.id),
      ['cip', 'kinetic-30d'],
    );
    assert.equal(events.length, 1);

    // Same head: one ref read, no REST calls, no event.
    repo.calls.length = 0;
    assert.equal(await watcher.checkNow(), false);
    assert.equal(repo.calls.length, 1);
    assert.equal(events.length, 1);

    // A new upload: the CIP gets a newer edition, the 30-day pull is untouched.
    repo.head = sha('2');
    repo.trees.set(sha('2'), [
      ...repo.trees.get(sha('1')),
      {
        path: `${MASTER}S2U_Common_Intelligence_Picture_October_18_2026_Export_1.kmz`,
        type: 'blob',
        size: 4,
        sha: sha('c'),
      },
    ]);
    assert.equal(await watcher.checkNow(), true);
    await warmDefaults(watcher);
    assert.equal(events.length, 2);
    const cip = events[1].products.find((p) => p.id === 'cip');
    assert.equal(cip.version, sha('c'));
    assert.match(cip.fileName, /October_18/);
    assert.equal(
      events[1].products.find((p) => p.id === 'kinetic-30d').version,
      sha('b'),
    );
    // Repository paths stay on the server.
    assert.equal('path' in cip, false);
    watcher.stop();
  }));

test('files download by commit-pinned URL, cache by blob, and stale blobs are pruned', () =>
  withCache(async (cacheDir) => {
    const { repo, fetchImpl } = fakeGitHub();
    const watcher = createGhostMapsWatcher({
      fetchImpl,
      cacheDir,
      log: () => {},
      warn: () => {},
    });
    await watcher.checkNow();
    const found = await watcher.file('kinetic-30d');
    assert.equal(found.bytes.toString(), 'KMZ!');
    const raw = repo.calls.filter((url) =>
      url.includes('raw.githubusercontent'),
    );
    assert.ok(raw.every((url) => url.includes(`/GhostMaps/${sha('1')}/`)));
    assert.ok(
      raw.some((url) => url.endsWith('/Kinetic_Activities_Last_30_Days.kmz')),
    );
    const before = repo.calls.length;
    await watcher.file('kinetic-30d');
    assert.equal(repo.calls.length, before, 'second read comes from disk');
    assert.equal(await watcher.file('not-a-product'), null);

    // When the edition changes, the old blob leaves the disk cache.
    await watcher.file('cip');
    repo.head = sha('2');
    repo.trees.set(sha('2'), [
      {
        path: `${MASTER}S2U_Common_Intelligence_Picture_October_18_2026_Export_1.kmz`,
        type: 'blob',
        size: 4,
        sha: sha('c'),
      },
      { path: KINETIC, type: 'blob', size: 4, sha: sha('b') },
    ]);
    await watcher.checkNow();
    await watcher.file('cip');
    const files = (await readdir(path.join(cacheDir, 'files'))).sort();
    assert.deepEqual(files, [`${sha('b')}.kmz`, `${sha('c')}.kmz`]);
    watcher.stop();
  }));

test('the catalog survives a restart from disk, and upstream failures are reported', () =>
  withCache(async (cacheDir) => {
    const { fetchImpl } = fakeGitHub();
    const quiet = { log: () => {}, warn: () => {} };
    const online = createGhostMapsWatcher({ fetchImpl, cacheDir, ...quiet });
    await online.checkNow();
    await warmDefaults(online);
    const offline = createGhostMapsWatcher({
      fetchImpl: async () => new Response('down', { status: 503 }),
      cacheDir,
      ...quiet,
    });
    assert.equal(await offline.checkNow(), false);
    const catalog = offline.catalog();
    assert.equal(catalog.commit, sha('1'));
    assert.equal(catalog.products.length, 2);
    assert.match(catalog.error, /HTTP 503/);
  }));

test('an unchanged head clears an upstream outage and announces recovery once', () =>
  withCache(async (cacheDir) => {
    const { fetchImpl } = fakeGitHub();
    let unavailable = false;
    let checkedAt = 1000;
    const requests = [];
    const watcher = createGhostMapsWatcher({
      cacheDir,
      now: () => checkedAt,
      fetchImpl: async (url, options) => {
        requests.push(url);
        if (unavailable) return new Response('down', { status: 503 });
        return fetchImpl(url, options);
      },
      log: () => {},
      warn: () => {},
    });
    const events = [];
    watcher.subscribe((catalog) => events.push(catalog));
    await watcher.checkNow();
    await Promise.all([watcher.file('cip'), watcher.file('kinetic-30d')]);
    const healthy = watcher.catalog();
    assert.equal(events.length, 1);

    unavailable = true;
    checkedAt = 2000;
    assert.equal(await watcher.checkNow(), false);
    assert.match(watcher.catalog().error, /HTTP 503/);
    assert.equal(events.length, 2);

    unavailable = false;
    checkedAt = 3000;
    requests.length = 0;
    assert.equal(await watcher.checkNow(), false, 'no new edition arrived');
    const recovered = watcher.catalog();
    assert.equal(recovered.error, null);
    assert.equal(recovered.checkedAt, checkedAt);
    assert.equal(recovered.commit, healthy.commit);
    assert.equal(recovered.changedAt, healthy.changedAt);
    assert.deepEqual(recovered.products, healthy.products);
    assert.equal(requests.length, 1, 'recovery needs only the ref read');
    assert.match(requests[0], /\/info\/refs\?service=git-upload-pack$/);
    assert.equal(events.length, 3, 'subscribers see the recovered catalog');
    assert.equal(events[2].error, null);
    assert.equal(events[2].checkedAt, checkedAt);

    checkedAt = 4000;
    assert.equal(await watcher.checkNow(), false);
    assert.equal(events.length, 3, 'healthy unchanged polls stay silent');
    watcher.stop();
  }));

test('poll interval is configurable with a 5 s floor', () => {
  assert.equal(ghostMapsPollMs(undefined), 15000);
  assert.equal(ghostMapsPollMs('30'), 30000);
  assert.equal(ghostMapsPollMs('1'), 5000);
  assert.equal(ghostMapsPollMs('soon'), 15000);
});

test('routes: unknown paths and methods are refused without contacting GitHub', async () => {
  let started = 0;
  const watcher = {
    start: () => {
      started += 1;
      return Promise.resolve(false);
    },
    catalog: () => ({ commit: sha('1'), products: [] }),
    file: async () => null,
    subscribe: () => () => {},
    subscribers: () => 0,
  };
  let handler;
  ghostMapsProxy({ watcher }).configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  const call = async (method, url) => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = String(body ?? '');
      },
    };
    await handler({ method, url }, res);
    return res;
  };
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('POST', '/catalog')).status, 405);
  assert.equal((await call('GET', '/file/../../etc')).status, 404);
  assert.equal(started, 0);
  assert.equal((await call('GET', '/file/cip')).status, 404);
  const catalog = await call('GET', '/catalog');
  assert.equal(catalog.status, 200);
  assert.equal(JSON.parse(catalog.body).commit, sha('1'));
  assert.equal(started, 2);
});
