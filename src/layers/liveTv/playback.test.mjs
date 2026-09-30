import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_TV_STARTUP_MS,
  attachLiveTvStreams,
  liveTvStreamBlocker,
} from './playback.js';

class FakeVideo {
  constructor({ nativeHls = false } = {}) {
    this.listeners = new Map();
    this.nativeHls = nativeHls;
    this.src = '';
    this.plays = 0;
    this.pauses = 0;
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  emit(type) {
    this.listeners.get(type)?.();
  }
  canPlayType() {
    return this.nativeHls ? 'maybe' : '';
  }
  play() {
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.pauses++;
  }
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
  load() {}
}

function fakeHlsModule({ supported = true } = {}) {
  const instances = [];
  class Hls {
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'parsed' };
    static ErrorTypes = { NETWORK_ERROR: 'net', MEDIA_ERROR: 'media' };
    static isSupported() {
      return supported;
    }
    constructor(config) {
      this.config = config;
      this.handlers = {};
      this.destroyed = false;
      this.recovered = 0;
      instances.push(this);
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    attachMedia(video) {
      this.video = video;
    }
    loadSource(url) {
      this.url = url;
    }
    recoverMediaError() {
      this.recovered++;
    }
    destroy() {
      this.destroyed = true;
    }
    fail(type) {
      this.handlers.error?.('error', { fatal: true, type });
    }
  }
  return { instances, loadHls: async () => ({ default: Hls }) };
}

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimer(callback, ms) {
      timers.set(++id, { callback, ms });
      return id;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    fireAll() {
      for (const [handle, { callback }] of [...timers]) {
        timers.delete(handle);
        callback();
      }
    },
    timers,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const streams = (...hosts) =>
  hosts.map((host) => ({ url: `https://${host}.example/live.m3u8` }));

test('mixed content is refused only from a secure page', () => {
  assert.equal(liveTvStreamBlocker('http://a/x.m3u8', 'https:'), 'insecure');
  assert.equal(liveTvStreamBlocker('http://a/x.m3u8', 'http:'), null);
  assert.equal(liveTvStreamBlocker('https://a/x.m3u8', 'https:'), null);
});

test('the first stream plays directly from the broadcaster', async () => {
  const video = new FakeVideo();
  const hls = fakeHlsModule();
  const timers = fakeTimers();
  const statuses = [];
  const player = attachLiveTvStreams(video, streams('one', 'two'), {
    loadHls: hls.loadHls,
    onStatus: (status) => statuses.push(status),
    pageProtocol: 'https:',
    ...timers,
  });
  await settle();
  assert.equal(hls.instances.length, 1);
  const [instance] = hls.instances;
  assert.equal(instance.url, 'https://one.example/live.m3u8');
  assert.equal(instance.video, video);
  assert.equal(instance.config.manifestLoadingMaxRetry, 0);
  assert.equal(timers.timers.size, 1);
  assert.equal([...timers.timers.values()][0].ms, LIVE_TV_STARTUP_MS);
  instance.handlers.parsed();
  assert.equal(video.plays, 1);
  video.emit('playing');
  assert.deepEqual(statuses, [
    { state: 'connecting', index: 0, total: 2 },
    { state: 'playing', index: 0, total: 2 },
  ]);
  assert.equal(timers.timers.size, 0, 'startup watchdog cleared once playing');
  player.dispose();
  assert.equal(instance.destroyed, true);
  assert.equal(video.listeners.size, 0);
});

test('fatal errors and silent startups move on, then report unavailable', async () => {
  const video = new FakeVideo();
  const hls = fakeHlsModule();
  const timers = fakeTimers();
  const statuses = [];
  attachLiveTvStreams(video, streams('one', 'two', 'three'), {
    loadHls: hls.loadHls,
    onStatus: (status) => statuses.push(status),
    pageProtocol: 'https:',
    ...timers,
  });
  await settle();
  hls.instances[0].fail('media');
  assert.equal(hls.instances[0].recovered, 1, 'one media recovery first');
  hls.instances[0].fail('net');
  assert.equal(hls.instances[0].destroyed, true);
  await settle();
  assert.equal(hls.instances[1].url, 'https://two.example/live.m3u8');
  timers.fireAll();
  await settle();
  assert.equal(hls.instances[2].url, 'https://three.example/live.m3u8');
  video.emit('error');
  await settle();
  assert.equal(hls.instances.length, 3);
  assert.deepEqual(
    statuses.map(({ state, index }) => [state, index]),
    [
      ['connecting', 0],
      ['connecting', 1],
      ['connecting', 2],
      ['unavailable', 2],
    ],
  );
  assert.equal(statuses.at(-1).reason, 'error');
});

test('http streams are skipped on a secure page without being fetched', async () => {
  const video = new FakeVideo();
  const hls = fakeHlsModule();
  const statuses = [];
  attachLiveTvStreams(
    video,
    [{ url: 'http://plain.example/live.m3u8' }, ...streams('secure')],
    {
      loadHls: hls.loadHls,
      onStatus: (status) => statuses.push(status),
      pageProtocol: 'https:',
      ...fakeTimers(),
    },
  );
  await settle();
  assert.deepEqual(
    hls.instances.map(({ url }) => url),
    ['https://secure.example/live.m3u8'],
  );
  assert.deepEqual(statuses, [{ state: 'connecting', index: 1, total: 2 }]);

  const onlyPlain = [];
  attachLiveTvStreams(
    new FakeVideo(),
    [{ url: 'http://plain.example/a.m3u8' }],
    {
      loadHls: hls.loadHls,
      onStatus: (status) => onlyPlain.push(status),
      pageProtocol: 'https:',
      ...fakeTimers(),
    },
  );
  assert.deepEqual(onlyPlain, [
    { state: 'unavailable', index: 0, total: 1, reason: 'insecure' },
  ]);
});

test('native HLS is used when hls.js is unsupported, otherwise unavailable', async () => {
  const video = new FakeVideo({ nativeHls: true });
  attachLiveTvStreams(video, streams('safari'), {
    loadHls: fakeHlsModule({ supported: false }).loadHls,
    pageProtocol: 'https:',
    ...fakeTimers(),
  });
  await settle();
  assert.equal(video.src, 'https://safari.example/live.m3u8');
  assert.equal(video.plays, 1);

  const statuses = [];
  attachLiveTvStreams(new FakeVideo(), streams('nowhere'), {
    loadHls: fakeHlsModule({ supported: false }).loadHls,
    onStatus: (status) => statuses.push(status),
    pageProtocol: 'https:',
    ...fakeTimers(),
  });
  await settle();
  assert.equal(statuses.at(-1).state, 'unavailable');
  assert.equal(statuses.at(-1).reason, 'unsupported');
});

test('disposing before hls.js loads never attaches a player', async () => {
  const hls = fakeHlsModule();
  const timers = fakeTimers();
  const player = attachLiveTvStreams(new FakeVideo(), streams('late'), {
    loadHls: hls.loadHls,
    pageProtocol: 'https:',
    ...timers,
  });
  player.dispose();
  await settle();
  assert.equal(hls.instances.length, 0);
  assert.equal(timers.timers.size, 0);
});
