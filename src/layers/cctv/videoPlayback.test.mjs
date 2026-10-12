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
test('dispose exposes pending release acknowledgement, reports failed DELETE and retries it without a second decoder', async () => {
  const source = video();
  source.canPlayType = () => 'probably';
  let resolve,
    releases = 0,
    ready = 0;
  const playback = attachCctvVideo(source, '/api/cctv/media/a', 'hls', {
    loadHls: async () => ({ default: { isSupported: () => false } }),
    onReady: () => ready++,
    fetchImpl: () => {
      releases++;
      return new Promise((r) => (resolve = r));
    },
  });
  await playback.ready;
  source.dispatchEvent(new Event('canplay'));
  assert.equal(ready, 1);
  const disposed = playback.dispose();
  assert.equal(playback.dispose(), disposed);
  assert.equal(releases, 1);
  source.dispatchEvent(new Event('canplay'));
  assert.equal(ready, 1);
  resolve({ ok: false });
  assert.equal(await disposed, false);
  const next = playback.release();
  assert.equal(releases, 2);
  resolve({ ok: true });
  assert.equal(await next, true);
  assert.equal(await playback.dispose(), true);
  assert.equal(releases, 2);
});
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

test('phone HLS stays bounded and repeated close destroys one decoder and releases one lease', async () => {
  for (const constrained of [true, false]) {
    let config,
      destroyed = 0,
      releases = 0,
      paused = 0,
      errorHandler;
    class Hls {
      static isSupported() {
        return true;
      }
      static Events = { ERROR: 'error' };
      constructor(options) {
        config = options;
      }
      on(_event, handler) {
        errorHandler = handler;
      }
      attachMedia() {}
      loadSource() {}
      destroy() {
        destroyed++;
      }
    }
    const source = video();
    source.pause = () => paused++;
    const playback = attachCctvVideo(source, '/api/cctv/media/fixture', 'hls', {
      constrained,
      loadHls: async () => ({ default: Hls }),
      fetchImpl: async () => {
        releases++;
      },
    });
    await playback.ready;
    assert.equal(config.maxBufferLength, constrained ? 8 : 24);
    assert.equal(config.maxMaxBufferLength, constrained ? 10 : 30);
    assert.equal(config.maxBufferSize, (constrained ? 4 : 16) * 1024 * 1024);
    assert.equal(config.backBufferLength, 0);
    playback.dispose();
    playback.dispose();
    errorHandler('error', { fatal: true });
    assert.equal(destroyed, 1);
    assert.equal(releases, 1);
    assert.equal(paused, 1);
  }
});

test('navigating away releases an interrupted HLS lease; cached-page hide preserves resumable media', async () => {
  const lifecycleTarget = new EventTarget(),
    source = video();
  source.canPlayType = () => 'probably';
  let releases = 0;
  const playback = attachCctvVideo(source, '/api/cctv/media/fixture', 'hls', {
    lifecycleTarget,
    loadHls: async () => ({ default: { isSupported: () => false } }),
    fetchImpl: async () => {
      releases++;
    },
  });
  await playback.ready;
  const cached = new Event('pagehide');
  cached.persisted = true;
  lifecycleTarget.dispatchEvent(cached);
  assert.equal(releases, 0);
  const leaving = new Event('pagehide');
  leaving.persisted = false;
  lifecycleTarget.dispatchEvent(leaving);
  playback.dispose();
  assert.equal(releases, 1);
});
