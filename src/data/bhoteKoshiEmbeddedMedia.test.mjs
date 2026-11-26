import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createBhoteKoshiEmbeddedMedia,
  createTrimmedYouTubePlayback,
  embeddedMediaFrameUrl,
  placeCard,
  publicEmbeddedMediaUrl,
  resolveEmbeddedMediaSource,
} from './bhoteKoshiEmbeddedMedia.js';
import { bindRenderer } from '../render/rendererOf.js';

// The cards draw provider frames; the tests never load their pages, and the
// page's note that each one is not loaded is dropped.
window.happyDOM.settings.disableIframePageLoading = true;
const consoleError = console.error;
console.error = (error, ...rest) => {
  if (!/Iframe page loading is disabled/.test(String(error?.message)))
    consoleError(error, ...rest);
};

/**
 * Embedded media in a fresh globe container of the page, and the overlay
 * root it renders into.
 */
function domFixture(options = {}) {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const media = createBhoteKoshiEmbeddedMedia({
    viewer: { container },
    documentRef: document,
    globalRef: {},
    ...options,
  });
  return { media, container, root: container.firstElementChild };
}

test('Pinokio fallback never creates provider DOM or loads SDKs', async () => {
  const unexpected = () => { throw new Error('Provider resource allocated in Pinokio'); };
  const media = createBhoteKoshiEmbeddedMedia({
    viewer: {},
    documentRef: { createElement: unexpected },
    globalRef: {
      navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Pinokio/8.0.40' },
      setTimeout: unexpected,
      requestAnimationFrame: unexpected,
    },
    facebookLoader: unexpected,
    youtubeLoader: unexpected,
    xLoader: unexpected,
  });
  for (const sourceUrl of [
    'https://www.youtube.com/watch?v=abcdefghijk',
    'https://www.facebook.com/watch/?v=123456789',
    'https://x.com/example/status/123456789',
  ]) {
    const options = { observation: { media: { sourceUrl } }, autoplay: true };
    assert.equal(media.warm(options), false, 'no hidden preload');
    assert.equal(media.show(options), false, 'retain the existing fallback card');
    assert.equal(media.play(), false);
    assert.equal(media.pause(), false);
    media.hide();
  }
  media.destroy();
  media.hide();
  await Promise.resolve();
});

test('ordinary browsers retain real preloads on the same launcher URL', () => {
  for (const userAgent of [
    'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    'Mozilla/5.0 Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 Electron/38.0.0',
    '',
  ]) {
    const { media, root } = preloadFixture({ globalRef: {
      navigator: { userAgent }, location: { href: 'http://127.0.0.1:42003/' },
    } });
    assert.equal(media.warm({ observation: { media: {
      sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    } } }), true);
    assert.equal(root.children.length, 1);
    media.pause();
    assert.equal(root.children.length, 0);
    media.destroy();
  }
});

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
  const { media, container, root } = domFixture();
  const options = { observation: { title: 'Clip', media: { sourceUrl: 'https://youtu.be/DbqRexFxv3k' } }, anchor: {}, autoplay: true };
  assert.equal(media.show(options), true);
  const card = root.querySelector('section');
  const frame = card.querySelector('iframe');
  assert.ok(card.isConnected);
  assert.equal(media.pause(), true);
  assert.equal(card.isConnected, false);
  frame.dispatchEvent(new Event('load'));
  assert.equal(root.querySelector('section'), null);
  assert.equal(media.show(options), true, 'an explicit replay creates a fresh player');
  assert.notEqual(root.querySelector('section iframe'), frame);
  media.destroy();
  assert.equal(container.children.length, 0);
});

test('a card draws its provider, source, status and original link, and words them again in a new locale', async () => {
  const { setLocale } = await import('../i18n/index.js');
  const { media, root } = domFixture();
  assert.equal(media.show({
    observation: { title: 'Flood footage', media: { sourceUrl: 'https://youtu.be/DbqRexFxv3k', orientation: 'portrait' } },
    anchor: {},
  }), true);
  const card = root.querySelector('section');
  assert.equal(card.className, 'bhote-embedded-callout is-youtube is-portrait');
  assert.equal(card.dataset.provider, 'youtube');
  assert.equal(card.getAttribute('aria-label'), 'Embedded YOUTUBE media for Flood footage');
  const leader = card.firstElementChild;
  assert.equal(leader.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(leader.getAttribute('class'), 'bhote-embedded-callout-leader');
  assert.equal(leader.getAttribute('aria-hidden'), 'true');
  assert.equal(leader.querySelector('path').getAttribute('pathLength'), '1');
  assert.equal(leader.querySelector('circle').getAttribute('r'), '4');
  const body = card.querySelector('.bhote-embedded-callout-body');
  assert.equal(body.getAttribute('data-overlay-input'), '');
  const player = body.firstElementChild;
  assert.equal(player.className, 'bhote-embedded-callout-player ui-scroll');
  const frame = player.firstElementChild;
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(new URL(frame.src).pathname, '/embed/DbqRexFxv3k');
  assert.equal(frame.title, 'YOUTUBE media: Flood footage');
  assert.equal(frame.getAttribute('allow'), 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  assert.equal(frame.hasAttribute('allowfullscreen'), true);
  assert.equal(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
  const [title, status, link] = body.querySelector('footer').children;
  assert.equal(title.tagName, 'STRONG');
  assert.equal(title.textContent, 'FLOOD FOOTAGE');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.textContent, 'YOUTUBE · EMBEDDED SOURCE');
  assert.equal(link.href, 'https://www.youtube.com/watch?v=DbqRexFxv3k');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.textContent, 'OPEN ORIGINAL ↗');
  frame.dispatchEvent(new Event('load'));
  assert.equal(status.textContent, 'YOUTUBE · PROVIDER CONTROLS');
  try {
    await setLocale('es');
    assert.notEqual(link.textContent, 'OPEN ORIGINAL ↗', 'the link is worded again');
    assert.notEqual(status.textContent, 'YOUTUBE · PROVIDER CONTROLS', 'the status is worded again');
    assert.ok(root.querySelector('section') === card, 'in place');
  } finally {
    await setLocale('en');
  }
  media.destroy();
});

test('an X post is built by the provider inside the card and its failure marks the card', async () => {
  let fail = false;
  const { media, root } = domFixture({
    xLoader: async () => ({ widgets: { createTweet: async (id, target) => {
      if (fail) return null;
      target.append(Object.assign(document.createElement('div'), { className: 'twitter-tweet', textContent: id }));
      return {};
    } } }),
  });
  const observation = { title: 'Clip', media: { sourceUrl: 'https://x.com/Indowatchosint/status/2092640554568007958' } };
  assert.equal(media.show({ observation, anchor: {} }), true);
  const card = root.querySelector('section');
  const status = card.querySelector('[role="status"]');
  assert.equal(status.textContent, 'LOADING X POST…');
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(card.querySelector('.bhote-embedded-callout-player .twitter-tweet').textContent, '2092640554568007958');
  assert.equal(status.textContent, 'X POST · PROVIDER CONTROLS');
  assert.equal(card.classList.contains('is-unavailable'), false);
  media.hide({ immediate: true });
  fail = true;
  assert.equal(media.show({ observation, anchor: {} }), true);
  await new Promise((resolve) => setTimeout(resolve));
  const failed = root.querySelector('section');
  assert.ok(failed.classList.contains('is-unavailable'));
  assert.equal(failed.querySelector('[role="status"]').textContent, 'The X post is unavailable or cannot be embedded. OPEN ORIGINAL.');
  media.destroy();
});

test('a warmed Facebook player moves into the card and stays through its redraws', async () => {
  let ready;
  const { media, root } = domFixture({
    facebookLoader: async () => ({
      Event: { subscribe(_name, callback) { ready = callback; }, unsubscribe() {} },
      XFBML: { parse() {} },
    }),
  });
  const observation = { title: 'Clip', media: { sourceUrl: 'https://www.facebook.com/reel/1571491657757829' } };
  media.warm({ observation });
  await Promise.resolve(); await Promise.resolve();
  const host = root.querySelector('.bhote-embedded-media-warmup');
  const embed = host.querySelector('.fb-video');
  assert.equal(media.show({ observation, anchor: {} }), true);
  const card = root.querySelector('section');
  const player = card.querySelector('.bhote-embedded-callout-player');
  assert.ok(host.parentNode === player, 'the warmed player is carried over, not rebuilt');
  assert.equal(host.className, 'bhote-facebook-player-host');
  assert.equal(host.hasAttribute('aria-hidden'), false);
  ready({ type: 'video', id: embed.id, instance: { mute() {}, play() {}, pause() {} } });
  assert.equal(card.querySelector('[role="status"]').textContent, 'FACEBOOK · PROVIDER CONTROLS');
  assert.ok(host.parentNode === player, 'a redraw keeps the provider player');
  media.destroy();
});

test('a leaving card animates out and is removed after its exit', () => {
  const timers = [];
  const { media, root } = domFixture({ globalRef: { setTimeout: (fn) => timers.push(fn), clearTimeout() {} } });
  media.show({ observation: { media: { sourceUrl: 'https://youtu.be/DbqRexFxv3k' } }, anchor: {} });
  const card = root.querySelector('section');
  card.hidden = false;
  media.hide();
  assert.ok(card.isConnected);
  assert.ok(card.classList.contains('is-leaving'));
  assert.equal(card.classList.contains('is-entering'), false);
  timers.forEach((fn) => fn());
  assert.equal(card.isConnected, false);
  media.destroy();
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
  const { media, root } = domFixture(options);
  return { media, root };
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
  assert.equal(frame.className, 'bhote-embedded-media-warmup');
  assert.equal(frame.getAttribute('aria-hidden'), 'true');
  assert.equal(frame.tabIndex, -1);
  assert.equal(frame.title, 'Preloading YOUTUBE media');
  media.hide({ preserveWarm: true });
  media.warm({ observation });
  assert.ok(root.children[0] === frame);
  assert.equal(media.show({ observation, anchor: {} }), true);
  assert.ok(frame.parentNode === root, 'keep the preload while the visible player starts');
  root.querySelector('section .bhote-embedded-callout-body > .bhote-embedded-callout-player > iframe')
    .dispatchEvent(new Event('load'));
  assert.equal(frame.isConnected, false, 'visible player readiness releases the preload');
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

test('a media card stays between the panels when right-to-left swaps their sides', () => {
  const rect = (left, right, top = 0, bottom = 900) => ({ left, right, top, bottom, width: right - left, height: bottom - top });
  // Arabic: the scene panel sits on the right, the context rail on the left.
  const panels = {
    '#scene-panel': rect(1040, 1420),
    '#right-context-rail': rect(20, 340),
    '#command-dock': rect(500, 940, 820, 880),
  };
  const card = {
    offsetWidth: 392,
    offsetHeight: 360,
    parentElement: { getBoundingClientRect: () => rect(0, 1440) },
    ownerDocument: { querySelector: (selector) => ({ getBoundingClientRect: () => panels[selector] }) },
    classList: { contains: () => false },
    style: {},
  };
  placeCard(card, { querySelector: () => null }, { x: 700, y: 400, width: 1440, height: 900 });
  const left = parseFloat(card.style.left);
  assert.ok(left >= 340 + 18, `card at ${left}px lands on the context rail`);
  assert.ok(left + 392 <= 1040 - 18, `card at ${left}px lands on the scene panel`);
});

test('a shown card follows its anchor through the renderer ports', () => {
  const listeners = new Set();
  const container = document.body.appendChild(document.createElement('div'));
  const viewer = { container, canvas: { getBoundingClientRect: () => ({ left: 500, top: 500 }) } };
  let pose = { position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } };
  const projected = [];
  // The renderer's canvas, not the viewer's, places the card.
  const unbind = bindRenderer(viewer, {
    canvas: { getBoundingClientRect: () => ({ left: 10, top: 5 }) },
    camera: { pose: () => pose },
    query: { project: (p) => { projected.push(p); return { x: 300, y: 200 }; } },
    frame: {
      on(phase, cb) {
        const entry = [phase, cb];
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
    },
  });
  const media = createBhoteKoshiEmbeddedMedia({ viewer, documentRef: document, globalRef: {} });
  const root = container.firstElementChild;
  root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
  assert.deepEqual([...listeners].map(([phase]) => phase), ['postRender']);
  const anchor = { x: 10, y: 0, z: 0 };
  assert.equal(media.show({ observation: { title: 'Clip', media: { sourceUrl: 'https://youtu.be/DbqRexFxv3k' } }, anchor }), true);
  const card = root.querySelector('section');
  assert.equal(card.hidden, false);
  assert.equal(projected.at(-1), anchor);
  assert.equal(card.style.left, `${300 + 10 + 42}px`);
  // The leader runs from the anchor to the card's near edge.
  assert.equal(card.querySelector('path').getAttribute('d'), `M ${300 + 10 - 352} ${200 + 5 - parseFloat(card.style.top)} L 0 ${Math.max(16, Math.min(360 - 16, 200 + 5 - parseFloat(card.style.top)))}`);
  // Behind the eye: hidden on the next drawn frame.
  pose = { ...pose, direction: { x: -1, y: 0, z: 0 } };
  for (const [, cb] of listeners) cb();
  assert.equal(card.hidden, true);
  media.destroy();
  assert.equal(listeners.size, 0);
  unbind();
});
