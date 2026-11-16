// src/data/youtubeLivePlayer.test.mjs — one live stream in YouTube's player,
// with the player API faked: its states and errors read back as the LIVE
// section's loading / playing / offline / unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_START_TIMEOUT_MS,
  createYouTubeLivePlayer,
} from './youtubeLivePlayer.js';
import { YOUTUBE_EMBED_HOST } from './liveStreams.js';

/** A stand-in for the panel's host element: counts what is put in it. */
function fakeHost() {
  return {
    children: [],
    replaceChildren() {
      this.children = [];
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
  };
}

/**
 * The player as YouTube's API builds it: records its options and lets the
 * test fire its events.
 */
function fakeApi() {
  const players = [];
  class Player {
    constructor(mount, options) {
      this.mount = mount;
      this.options = options;
      this.destroyed = 0;
      players.push(this);
    }
    fire(name, data) {
      this.options.events[name]?.({ data, target: this });
    }
    destroy() {
      this.destroyed += 1;
    }
  }
  return { YT: { Player }, players };
}

function fixture({ apiFails = false } = {}) {
  const api = fakeApi();
  const timers = [];
  const globalRef = {
    location: { origin: 'http://localhost:5190' },
    setTimeout(callback, delay) {
      const id = timers.length + 1;
      timers.push({ id, callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
  };
  const documentRef = { createElement: (tag) => ({ tag }) };
  const states = [];
  const host = fakeHost();
  const player = createYouTubeLivePlayer({
    host,
    videoId: 'ROboUHfPUrU',
    documentRef,
    globalRef,
    loadApi: () =>
      apiFails ? Promise.reject(new Error('blocked')) : Promise.resolve(api.YT),
    onChange: (state) => states.push(state),
  });
  // Let the API promise settle and the player be built.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const pending = () => timers.filter((timer) => !timer.cleared);
  return { api, timers, pending, states, host, player, settle };
}

test('the player is built on the privacy host with the live parameters, once the API loads', async () => {
  const { api, states, host, settle } = fixture();
  assert.deepEqual(states, [{ state: 'loading', reason: null }]);
  assert.equal(host.children.length, 1, 'a mount for the iframe is placed');
  await settle();
  assert.equal(api.players.length, 1);
  const { options } = api.players[0];
  assert.equal(options.host, YOUTUBE_EMBED_HOST);
  assert.equal(options.videoId, 'ROboUHfPUrU');
  assert.equal(options.playerVars.enablejsapi, 1);
  assert.equal(options.playerVars.mute, 1);
  assert.equal(options.playerVars.origin, 'http://localhost:5190');
});

test('playing clears the start timer; the same state is not reported twice', async () => {
  const { api, pending, states, settle } = fixture();
  await settle();
  const [player] = api.players;
  player.fire('onReady');
  assert.equal(pending().length, 1, 'one start timer is running');
  assert.equal(pending()[0].delay, LIVE_START_TIMEOUT_MS);
  player.fire('onStateChange', 1);
  player.fire('onStateChange', 1);
  assert.equal(pending().length, 0, 'the timer went when playback began');
  assert.deepEqual(states.at(-1), { state: 'playing', reason: null });
  assert.equal(states.length, 2);
});

test('a video that ends, or errors for any other reason, reads as offline', async () => {
  const ended = fixture();
  await ended.settle();
  ended.api.players[0].fire('onStateChange', 0);
  assert.deepEqual(ended.states.at(-1), { state: 'offline', reason: 'ended' });

  const errored = fixture();
  await errored.settle();
  errored.api.players[0].fire('onError', 100);
  assert.deepEqual(errored.states.at(-1), {
    state: 'offline',
    reason: 'error-100',
  });
  assert.equal(errored.pending().length, 0, 'the start timer is cleared');
});

test('embedding refused by the owner is unavailable, which no retry would change', async () => {
  for (const code of [101, 150]) {
    const { api, states, settle } = fixture();
    await settle();
    api.players[0].fire('onError', code);
    assert.deepEqual(states.at(-1), {
      state: 'unavailable',
      reason: `error-${code}`,
    });
  }
});

test('a stream that never starts playing is offline when the start timer runs out', async () => {
  const { api, pending, states, settle } = fixture();
  await settle();
  api.players[0].fire('onReady');
  const [timer] = pending();
  timer.callback();
  assert.deepEqual(states.at(-1), { state: 'offline', reason: 'timeout' });
  // Buffering states before the timer do not count as playing.
  assert.equal(
    states.some((entry) => entry.state === 'playing'),
    false,
  );
});

test('a timer that fires after playback began changes nothing', async () => {
  const { api, timers, states, settle } = fixture();
  await settle();
  api.players[0].fire('onReady');
  api.players[0].fire('onStateChange', 1);
  for (const timer of timers) timer.callback();
  assert.deepEqual(states.at(-1), { state: 'playing', reason: null });
});

test('an API that does not load leaves the stream unavailable', async () => {
  const { states, settle } = fixture({ apiFails: true });
  await settle();
  assert.deepEqual(states.at(-1), { state: 'unavailable', reason: 'api' });
});

test('destroy empties the host, destroys the player and silences later events', async () => {
  const { api, host, pending, player, states, settle } = fixture();
  await settle();
  const built = api.players[0];
  built.fire('onReady');
  player.destroy();
  player.destroy();
  assert.equal(built.destroyed, 1);
  assert.equal(host.children.length, 0);
  assert.equal(pending().length, 0);
  const before = states.length;
  built.fire('onStateChange', 1);
  built.fire('onError', 150);
  assert.equal(states.length, before, 'nothing is reported after destroy');
});

test('destroy before the API loads builds no player', async () => {
  const { api, player, states, settle } = fixture();
  player.destroy();
  await settle();
  assert.equal(api.players.length, 0);
  assert.deepEqual(states, [{ state: 'loading', reason: null }]);
});
