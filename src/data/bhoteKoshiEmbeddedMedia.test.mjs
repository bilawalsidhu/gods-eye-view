import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createBhoteKoshiEmbeddedMedia,
  createTrimmedYouTubePlayback,
  embeddedMediaFrameUrl,
  publicEmbeddedMediaUrl,
  resolveEmbeddedMediaSource,
} from './bhoteKoshiEmbeddedMedia.js';

function trimmedPlaybackFixture() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const globalRef = {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const advance = (ms) => {
    const until = now + ms;
    while (true) {
      const entry = [...timers].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, item] = entry; timers.delete(id); now = item.at; item.fn();
    }
    now = until;
  };
  let events;
  const calls = [];
  let time = 0;
  let state = -1;
  const player = {
    mute: () => calls.push('mute'), playVideo: () => calls.push('play'),
    pauseVideo: () => calls.push('pause'), destroy: () => calls.push('destroy'),
    getCurrentTime: () => time,
    getPlayerState: () => state,
  };
  const api = { Player: class { constructor(_iframe, options) { events = options.events; return player; } } };
  const statuses = [];
  const session = createTrimmedYouTubePlayback({ iframe: {}, endAtSec: 7, globalRef,
    loadApi: () => api, onStatus: (phase) => statuses.push(phase) });
  return { session, advance, calls, timers, statuses, player, get events() { return events; }, setTime(value) { time = value; }, setState(value) { state = value; } };
}

test('trimmed YouTube reconciles already-playing READY and missed PLAYING callbacks', async () => {
  for (const alreadyPlaying of [true, false]) {
    const f = trimmedPlaybackFixture();
    await Promise.resolve(); await Promise.resolve();
    if (alreadyPlaying) { f.setState(1); f.setTime(1); }
    f.events.onReady({ target: f.player });
    if (!alreadyPlaying) { f.setState(1); f.setTime(1); f.advance(100); }
    f.setTime(6); f.advance(5000);
    assert.deepEqual(f.session.getState(), { phase: 'playing', currentTime: 6 });
    f.setTime(7); f.advance(100);
    assert.deepEqual(f.session.getState(), { phase: 'completed', currentTime: 7 });
    assert.deepEqual(f.statuses, ['completed']);
    assert.equal(f.timers.size, 0);
    f.session.destroy();
  }
});

test('trimmed YouTube accepts ENDED before PLAYING and never replays a completed READY', async () => {
  for (const endedCallback of [true, false]) {
    const f = trimmedPlaybackFixture();
    await Promise.resolve(); await Promise.resolve();
    f.setState(0); f.setTime(7);
    if (endedCallback) f.events.onStateChange({ data: 0, target: f.player });
    f.events.onReady({ target: f.player });
    assert.deepEqual(f.session.getState(), { phase: 'completed', currentTime: 7 });
    assert.deepEqual(f.calls, ['pause']);
    assert.deepEqual(f.statuses, ['completed']);
    assert.equal(f.timers.size, 0);
    f.session.destroy();
  }
});

test('trimmed YouTube waits through delayed startup, stops at source 0:07, and releases its timers', async () => {
  const f = trimmedPlaybackFixture();
  await Promise.resolve(); await Promise.resolve();
  f.advance(3000);
  assert.equal(f.session.getState().phase, 'starting');
  f.events.onReady({ target: f.player });
  f.events.onStateChange({ data: 1 });
  f.setTime(4); f.advance(4000);
  assert.equal(f.session.getState().phase, 'playing', 'seven wall-clock seconds do not truncate a delayed clip');
  f.setTime(7); f.advance(100);
  assert.deepEqual(f.session.getState(), { phase: 'completed', currentTime: 7 });
  assert.deepEqual(f.statuses, ['completed']);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.at(-1), 'pause');
  f.session.destroy();
});

test('trimmed YouTube bounds blocked, failed, stalled and never-started playback', async () => {
  for (const outcome of ['blocked', 'unavailable', 'timeout', 'stalled']) {
    const f = trimmedPlaybackFixture();
    await Promise.resolve(); await Promise.resolve();
    if (outcome === 'blocked') f.events.onAutoplayBlocked();
    else if (outcome === 'unavailable') f.events.onError();
    else if (outcome === 'stalled') { f.events.onStateChange({ data: 1 }); f.advance(12000); }
    else f.advance(5000);
    assert.equal(f.session.getState().phase, outcome === 'stalled' ? 'timeout' : outcome);
    assert.equal(f.timers.size, 0);
    const calls = [...f.calls];
    f.events.onReady({ target: f.player });
    f.events.onStateChange({ data: 1 });
    assert.deepEqual(f.calls, calls, 'late provider callbacks cannot restart a terminal attempt');
    f.session.destroy();
  }
});

test('trimmed YouTube teardown revokes pending SDK and player callbacks', async () => {
  const f = trimmedPlaybackFixture();
  await Promise.resolve(); await Promise.resolve();
  f.session.destroy();
  f.events.onReady({ target: f.player });
  f.events.onStateChange({ data: 1 });
  f.events.onError(); f.advance(20000);
  assert.deepEqual(f.calls, ['destroy']);
  assert.deepEqual(f.statuses, []);
  assert.equal(f.timers.size, 0);
  let constructCount = 0;
  let resolveApi;
  const session = createTrimmedYouTubePlayback({ iframe: {}, endAtSec: 7,
    loadApi: () => new Promise((resolve) => { resolveApi = resolve; }) });
  await Promise.resolve();
  session.destroy();
  resolveApi({ Player: class { constructor() { constructCount++; } } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(constructCount, 0);
});

test('pausing YouTube removes its frame and rejects a late load from the stopped generation', () => {
  const nodes = [];
  class Element extends EventTarget {
    constructor(tag) { super(); this.tag = tag; this.children = []; this.dataset = {}; this.classList = { add() {}, remove() {} }; nodes.push(this); }
    setAttribute() {}
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  }
  const documentRef = {
    body: new Element('body'),
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
  };
  const media = createBhoteKoshiEmbeddedMedia({ viewer: {}, documentRef, globalRef: {} });
  const options = { observation: { title: 'Clip', media: { sourceUrl: 'https://youtu.be/DbqRexFxv3k' } }, anchor: {}, autoplay: true };
  assert.equal(media.show(options), true);
  const frame = nodes.find((node) => node.tag === 'iframe');
  const card = nodes.find((node) => node.tag === 'section');
  assert.ok(card.parent);
  assert.equal(media.pause(), true);
  assert.equal(card.parent, null);
  frame.dispatchEvent(new Event('load'));
  assert.equal(card.parent, null);
  assert.equal(media.show(options), true, 'an explicit replay creates a fresh player');
  media.destroy();
  assert.equal(documentRef.body.children.length, 0);
});

test('resolves supported embedded callout providers from canonical public URLs', () => {
  assert.deepEqual(
    resolveEmbeddedMediaSource('https://www.youtube.com/watch?v=DbqRexFxv3k'),
    {
      provider: 'youtube',
      id: 'DbqRexFxv3k',
      url: 'https://www.youtube.com/watch?v=DbqRexFxv3k',
    },
  );
  assert.equal(
    resolveEmbeddedMediaSource('https://www.facebook.com/reel/1571491657757829').provider,
    'facebook',
  );
  assert.deepEqual(
    resolveEmbeddedMediaSource('https://x.com/Indowatchosint/status/2092640554568007958'),
    {
      provider: 'x',
      id: '2092640554568007958',
      url: 'https://x.com/Indowatchosint/status/2092640554568007958',
    },
  );
  assert.equal(
    resolveEmbeddedMediaSource('https://twitter.com/Indowatchosint/status/2092640554568007958').provider,
    'x',
  );
  assert.equal(
    resolveEmbeddedMediaSource('https://www.youtube.com/shorts/DbqRexFxv3k').id,
    'DbqRexFxv3k',
  );
});

test('rejects deceptive hosts, non-post X links, private targets, and iframe markup', () => {
  for (const value of [
    'https://x.com.evil.example/user/status/2092640554568007958',
    'https://x.com/Indowatchosint',
    'https://youtube.com.evil.example/watch?v=DbqRexFxv3k',
    'http://www.youtube.com/watch?v=DbqRexFxv3k',
    'https://localhost/video.mp4',
    '<iframe src="https://x.com/user/status/2092640554568007958"></iframe>',
  ]) {
    assert.equal(resolveEmbeddedMediaSource(value), null, value);
  }
  assert.equal(publicEmbeddedMediaUrl('https://user:secret@x.com/name/status/123'), null);
});

test('builds privacy-aware provider frames and keeps X on its widget runtime', () => {
  const youtube = resolveEmbeddedMediaSource('https://youtu.be/DbqRexFxv3k');
  const youtubeFrame = new URL(embeddedMediaFrameUrl(youtube, { autoplay: true }));
  assert.equal(youtubeFrame.hostname, 'www.youtube-nocookie.com');
  assert.equal(youtubeFrame.pathname, '/embed/DbqRexFxv3k');
  assert.equal(youtubeFrame.searchParams.get('autoplay'), '1');
  assert.equal(youtubeFrame.searchParams.get('mute'), '1');

  const timestampedFrame = new URL(embeddedMediaFrameUrl(youtube, {
    autoplay: true,
    startAtSec: 26,
  }));
  assert.equal(timestampedFrame.searchParams.get('start'), '26');

  const facebook = resolveEmbeddedMediaSource('https://www.facebook.com/watch/?v=456');
  const facebookFrame = new URL(embeddedMediaFrameUrl(facebook, { autoplay: false }));
  assert.equal(facebookFrame.hostname, 'www.facebook.com');
  assert.equal(facebookFrame.pathname, '/plugins/video.php');
  assert.equal(facebookFrame.searchParams.get('href'), facebook.url);
  assert.equal(facebookFrame.searchParams.get('autoplay'), 'false');

  const x = resolveEmbeddedMediaSource('https://x.com/Indowatchosint/status/2092640554568007958');
  assert.equal(embeddedMediaFrameUrl(x), null);
});

test('Mailung playback stops at source timestamp 0:07 without changing other clips', async () => {
  const event = JSON.parse(await readFile(new URL('../../public/events/bhote-koshi-2026/event.json', import.meta.url), 'utf8'));
  const bounded = event.evidenceSpine.filter(point => point.media?.embedEndAtSec != null);
  assert.deepEqual(bounded.map(point => point.id), ['mailung-bazzar']);
  const media = bounded[0].media;
  assert.equal(media.embedEndAtSec, 7);
  const source = resolveEmbeddedMediaSource(media.sourceUrl);
  for (const autoplay of [false, true]) {
    const url = new URL(embeddedMediaFrameUrl(source, {
      autoplay, startAtSec: media.clipInSec, endAtSec: media.embedEndAtSec,
    }));
    assert.equal(url.searchParams.get('end'), '7');
  }
  for (const endAtSec of [undefined, null, NaN, Infinity, -1, 0, 3]) {
    const url = new URL(embeddedMediaFrameUrl(source, {startAtSec: 3, endAtSec}));
    assert.equal(url.searchParams.has('end'), false);
  }
});

function preloadFixture(options = {}) {
  class Element extends EventTarget {
    constructor(tag) {
      super(); this.tag = tag; this.children = []; this.dataset = {};
      this.classList = { add() {}, remove() {}, contains() { return false; } };
    }
    setAttribute() {}
    removeAttribute() {}
    append(...children) {
      for (const child of children) { child.remove(); child.parent = this; this.children.push(child); }
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    }
  }
  const documentRef = {
    body: new Element('body'),
    createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
  };
  const media = createBhoteKoshiEmbeddedMedia({ viewer: {}, documentRef, globalRef: {}, ...options });
  return { media, root: documentRef.body.children[0] };
}

for (const operation of ['pause', 'hide', 'destroy']) {
  test(`${operation} removes a hidden YouTube preload`, () => {
    const { media, root } = preloadFixture();
    media.warm({ sourceUrl: 'https://youtu.be/DbqRexFxv3k' });
    assert.equal(root.children.length, 1);
    media[operation]();
    assert.equal(root.children.length, 0);
    media.destroy();
  });
}

test('camera updates retain a preload until the visible player loads', () => {
  const { media, root } = preloadFixture();
  const observation = { media: { sourceUrl: 'https://youtu.be/DbqRexFxv3k' } };
  media.warm({ observation });
  const frame = root.children[0];
  media.hide({ preserveWarm: true });
  media.warm({ observation });
  assert.equal(root.children[0], frame);
  assert.equal(media.show({ observation, anchor: {} }), true);
  assert.equal(frame.parent, root, 'keep the preload while the visible player starts');
  const card = root.children.find(node => node.tag === 'section');
  const body = card.children.find(node => node.className === 'bhote-embedded-callout-body');
  const player = body.children.find(node => node.className === 'bhote-embedded-callout-player');
  player.children.find(node => node.tag === 'iframe').dispatchEvent(new Event('load'));
  assert.equal(frame.parent, null, 'visible player readiness releases the preload');
  media.destroy();
  assert.equal(root.children.length, 0);
});

test('hiding revokes a pending Facebook SDK before it can mount or subscribe', async () => {
  let resolveApi;
  const calls = [];
  const { media, root } = preloadFixture({
    facebookLoader: () => new Promise(resolve => { resolveApi = resolve; }),
  });
  media.warm({ sourceUrl: 'https://www.facebook.com/reel/1571491657757829' });
  assert.equal(root.children.length, 1);
  media.hide();
  assert.equal(root.children.length, 0);
  resolveApi({ Event: { subscribe() { calls.push('subscribe'); } }, XFBML: { parse() { calls.push('parse'); } } });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, []);
  media.destroy();
});

test('pausing cancels a mounted Facebook preload and rejects its late ready callback', async () => {
  let ready;
  let unsubscribed = 0;
  const timers = new Set();
  const playerCalls = [];
  const { media, root } = preloadFixture({
    globalRef: { setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); } },
    facebookLoader: async () => ({
      Event: { subscribe(_name, callback) { ready = callback; }, unsubscribe() { unsubscribed++; } },
      XFBML: { parse() {} },
    }),
  });
  media.warm({ sourceUrl: 'https://www.facebook.com/reel/1571491657757829' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(timers.size, 1);
  media.pause();
  assert.equal(root.children.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(unsubscribed, 1);
  ready({ type: 'video', instance: { play() { playerCalls.push('play'); }, pause() { playerCalls.push('pause'); } } });
  assert.deepEqual(playerCalls, []);
  media.destroy();
});
