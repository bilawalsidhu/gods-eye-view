import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCctvVideo } from './videoPlayback.js';
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
