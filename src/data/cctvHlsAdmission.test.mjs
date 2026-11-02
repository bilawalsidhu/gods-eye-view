import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHlsPuller,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';

const base = 'https://camera.example/live/index.m3u8';
const playlist =
  '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n' +
  '#EXTINF:2,\na.m4s\n#EXTINF:2,\nb.m4s\n';

function assertEmpty(entry) {
  assert.equal(entry.controller.signal.aborted, true);
  assert.equal(entry.bytes, 0);
  for (const key of ['leases', 'segments', 'inits', 'initByUri', 'upstream'])
    assert.equal(entry[key].size, 0, key);
}

test('two full HD fMP4 caches share downloads while enforcing all production lease limits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let downloads = 0;
  const media = new Uint8Array(
    (HLS_LIMITS.sessionBytes - HLS_LIMITS.initBytes) / 2,
  );
  const manager = createHlsPuller({
    fetchImpl: async (url) => {
      downloads++;
      return new Response(
        url.endsWith('.m3u8')
          ? playlist
          : url.endsWith('init.mp4')
            ? new Uint8Array(HLS_LIMITS.initBytes)
            : media,
      );
    },
  });
  t.after(() => manager.shutdown());
  // Each group has four independent consumer leases on each camera.
  const leases = ['group-a', 'group-b'].flatMap((group) =>
    ['one', 'two'].flatMap((camera) =>
      Array.from({ length: 4 }, (_, i) => ({
        camera,
        lease: `${group}-${i}`,
      })),
    ),
  );
  const entries = await Promise.all(
    leases.map(({ camera, lease }) => manager.ensure(camera, base, lease)),
  );
  const sessions = [...new Set(entries)];
  assert.equal(sessions.length, 2);
  await Promise.all(sessions.map((entry) => entry.polling));
  assert.equal(downloads, 8, 'one playlist, init and newest pair per session');
  assert.deepEqual(manager.stats(), {
    sessions: 2,
    bytes: 2 * HLS_LIMITS.sessionBytes,
  });
  for (const entry of sessions) {
    assert.equal(entry.leases.size, 8);
    assert.equal(entry.segments.size, 2);
    assert.equal(entry.bytes, HLS_LIMITS.sessionBytes);
    assert.equal([...entry.inits.values()][0].refs, 2);
  }
  for (const camera of ['one', 'two']) {
    await assert.rejects(
      manager.ensure(camera, base, 'extra'),
      /lease capacity/,
    );
    await manager.ensure(camera, base, 'group-a-0');
  }
  await assert.rejects(
    manager.ensure('three', base, 'new'),
    /session capacity/,
  );
  assert.equal(downloads, 8, 'refusals and renewals start no upstream work');

  for (const { camera, lease } of leases.slice(0, 8))
    manager.release(camera, lease);
  assert.equal(manager.stats().bytes, 2 * HLS_LIMITS.sessionBytes);
  for (const entry of sessions) {
    assert.equal(entry.leases.size, 4);
    assert.equal(
      manager.getAsset(entry.cameraId, entry.token, 'init_0.mp4', 'group-a-0'),
      null,
    );
    assert.ok(
      manager.getAsset(entry.cameraId, entry.token, 'init_0.mp4', 'group-b-0'),
    );
  }
  for (const { camera, lease } of leases.slice(8))
    manager.release(camera, lease);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  sessions.forEach(assertEmpty);
  // Reusing the lease string must not make a URL from the old session valid.
  const replacement = await manager.ensure('one', base, 'group-a-0');
  await replacement.polling;
  assert.notEqual(replacement.token, sessions[0].token);
  assert.equal(
    manager.getAsset('one', sessions[0].token, 'init_0.mp4', 'group-a-0'),
    null,
  );
  await manager.shutdown();
  assertEmpty(replacement);
});

test('invalid fMP4 reads and releases cannot extend an abandoned lease', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let downloads = 0;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 100000 },
    fetchImpl: async (url) => {
      downloads++;
      return new Response(url.endsWith('.m3u8') ? playlist : 'bytes');
    },
  });
  t.after(() => manager.shutdown());
  const entry = await manager.ensure('cam', base, 'a');
  await manager.ensure('cam', base, 'b');
  await entry.polling;
  t.mock.timers.tick(HLS_LIMITS.idleMs - 1);
  for (const name of ['init_0.mp4', 'seg_0.mp4']) {
    assert.equal(manager.getAsset('cam', entry.token, name, 'missing'), null);
    assert.ok(manager.getAsset('cam', entry.token, name, 'b'));
  }
  await assert.rejects(
    manager.buildPlaylist(entry, 'cam', 'missing'),
    /lease capacity/,
  );
  manager.release('cam', 'missing');
  assert.equal(entry.leases.size, 2);
  t.mock.timers.tick(1);
  assert.equal(
    entry.leases.has('a'),
    false,
    'denied requests did not renew the victim',
  );
  assert.equal(entry.leases.has('b'), true);
  assert.equal(entry.stopping, false);
  assert.equal(manager.getAsset('cam', entry.token, 'init_0.mp4', 'a'), null);
  t.mock.timers.tick(HLS_LIMITS.idleMs - 1);
  assertEmpty(entry);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  t.mock.timers.tick(100000);
  assert.equal(downloads, 4, 'no polling remains after the last lease expires');
});

for (const pending of ['init.mp4', 'b.m4s']) {
  test(`last consumer release cancels a pending ${pending} and late bytes cannot refill the cache`, async (t) => {
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    let signal;
    const manager = createHlsPuller({
      fetchImpl: async (url, options) => {
        if (url.endsWith('/' + pending)) {
          signal = options.signal;
          started.resolve();
          return response.promise;
        }
        return new Response(url.endsWith('.m3u8') ? playlist : 'bytes');
      },
    });
    t.after(() => manager.shutdown());
    const entry = await manager.ensure('cam', base, 'a');
    await manager.ensure('cam', base, 'b');
    await started.promise;
    manager.release('cam', 'missing');
    assert.equal(entry.leases.size, 2);
    manager.release('cam', 'a');
    assert.equal(
      signal.aborted,
      false,
      'the second consumer still owns the download',
    );
    manager.release('cam', 'b');
    assert.equal(signal.aborted, true);
    response.resolve(new Response('late bytes'));
    await entry.polling;
    assertEmpty(entry);
    assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  });
}

for (const failed of ['next.mp4', 'd.m4s']) {
  test(`three ${failed} 404s reclaim both consumer leases without stopping the healthy session`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let failing = false;
    const next = playlist
      .replace('init.mp4', 'next.mp4')
      .replace('a.m4s', 'c.m4s')
      .replace('b.m4s', 'd.m4s');
    const manager = createHlsPuller({
      fetchImpl: async (url) => {
        const broken = url.includes('/broken/');
        if (url.endsWith('.m3u8'))
          return new Response(broken && failing ? next : playlist);
        if (broken && failing && url.endsWith('/' + failed))
          return new Response('', { status: 404 });
        return new Response('bytes');
      },
    });
    t.after(() => manager.shutdown());
    const brokenUrl = base.replace('/live/', '/broken/');
    const broken = await manager.ensure('broken', brokenUrl, 'a');
    await manager.ensure('broken', brokenUrl, 'b');
    const healthy = await manager.ensure('healthy', base, 'b');
    await Promise.all([broken.polling, healthy.polling]);
    const healthyBytes = healthy.bytes;
    failing = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      t.mock.timers.tick(HLS_LIMITS.pollMs);
      await Promise.all([broken.polling, healthy.polling]);
    }
    assert.equal(broken.failures, 3);
    assertEmpty(broken);
    assert.deepEqual(manager.stats(), { sessions: 1, bytes: healthyBytes });
    assert.ok(manager.getAsset('healthy', healthy.token, 'init_0.mp4', 'b'));
    assert.equal(
      manager.getAsset('broken', broken.token, 'init_0.mp4', 'a'),
      null,
    );
    failing = false;
    const replacement = await manager.ensure('broken', brokenUrl, 'a');
    await replacement.polling;
    assert.equal(await manager.waitReady(replacement), true);
    assert.notEqual(replacement.token, broken.token);
    assert.equal(
      manager.getAsset('broken', broken.token, 'init_0.mp4', 'a'),
      null,
    );
  });
}
