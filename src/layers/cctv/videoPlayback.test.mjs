import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { attachCctvVideo, createLeaseId } from './videoPlayback.js';

const LEASE_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What an insecure context exposes: getRandomValues but no randomUUID. */
const insecureCrypto = {
  getRandomValues: (array) => webcrypto.getRandomValues(array),
};
function video() {
  const v = new EventTarget();
  Object.assign(v, {
    src: '',
    pause() {},
    load() {},
    removeAttribute() {},
    play: () => Promise.resolve(),
  });
  return v;
}
test('switch during lazy import never starts the stale decoder', async () => {
  let resolve;
  let constructed = 0;
  class Hls {
    constructor() {
      constructed++;
    }
    static isSupported() {
      return true;
    }
  }
  const source = video();
  const playback = attachCctvVideo(source, '/api/cctv/media/a', 'hls', {
    loadHls: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  playback.dispose();
  resolve({ default: Hls });
  await playback.ready;
  assert.equal(constructed, 0);
  assert.equal(source.src, '');
});
test('missing decoder uses honest failure fallback once', async () => {
  let failures = 0;
  const playback = attachCctvVideo(video(), '/api/cctv/media/a', 'hls', {
    loadHls: async () => {
      throw new Error('unavailable');
    },
    onFailure: () => failures++,
  });
  await playback.ready;
  playback.dispose();
  assert.equal(failures, 1);
});

test('native HLS releases its client lease without response-header access', async () => {
  const source = video();
  source.canPlayType = () => 'probably';
  const releases = [];
  const playback = attachCctvVideo(source, '/api/cctv/media/a', 'hls', {
    loadHls: async () => ({ default: { isSupported: () => false } }),
    fetchImpl: async (url, init) => {
      releases.push({ url, init });
    },
  });
  await playback.ready;
  assert.match(source.src, /\/api\/cctv\/media\/a\?lease=[a-f0-9-]{36}$/);
  const requested = source.src;
  playback.dispose();
  playback.dispose();
  assert.equal(releases.length, 1);
  assert.equal(releases[0].url, requested);
  assert.equal(releases[0].init.method, 'DELETE');
});

test('lease ids are v4 UUIDs with or without crypto.randomUUID', () => {
  assert.match(createLeaseId(), LEASE_V4);
  const ids = new Set();
  for (let i = 0; i < 64; i++) ids.add(createLeaseId(insecureCrypto));
  assert.equal(ids.size, 64);
  for (const id of ids) assert.match(id, LEASE_V4);
});

test('HLS starts on a plain-HTTP LAN page without crypto.randomUUID', async () => {
  const source = video();
  source.canPlayType = () => 'probably';
  const playback = attachCctvVideo(source, '/api/cctv/media/a', 'hls', {
    loadHls: async () => ({ default: { isSupported: () => false } }),
    fetchImpl: async () => {},
    cryptoImpl: insecureCrypto,
  });
  try {
    await playback.ready;
    const lease = new URL(
      source.src,
      'http://192.168.1.10:4173/',
    ).searchParams.get('lease');
    assert.match(lease, LEASE_V4);
  } finally {
    playback.dispose();
  }
});

test('finite video feeds retain looping while live HLS does not loop', async () => {
  for (const feedType of ['mp4', 'webm', 'hls']) {
    const source = video();
    source.loop = feedType === 'hls';
    source.canPlayType = () => 'probably';
    let imports = 0;
    const playback = attachCctvVideo(source, '/api/cctv/media/a', feedType, {
      loadHls: async () => {
        imports++;
        return { default: { isSupported: () => false } };
      },
      fetchImpl: async () => {},
    });
    try {
      await playback.ready;
      assert.equal(source.loop, feedType !== 'hls');
      assert.equal(imports, feedType === 'hls' ? 1 : 0);
    } finally {
      playback.dispose();
    }
  }
});
