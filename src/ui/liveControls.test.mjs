// src/ui/liveControls.test.mjs — LiveControls owns the live video: the
// selected object's streams, the one player, which screen it is built into,
// and when it goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COCKPIT_LIVE_PLAYER_HOST_ID,
  LIVE_PLAYER_HOST_ID,
  LiveControls,
} from './liveControls.js';
import { createOwners } from './stores/owners.js';

const STREAMS = Object.freeze([
  {
    id: 'one',
    platform: 'youtube',
    videoId: 'AAAAAAAAAAA',
    title: 'First',
    owner: 'Owner',
    ownerUrl: 'https://www.youtube.com/@owner',
    subjects: ['station:test'],
    note: 'note',
  },
  {
    id: 'two',
    platform: 'youtube',
    videoId: 'BBBBBBBBBBB',
    title: 'Second',
    owner: 'Owner',
    ownerUrl: 'https://www.youtube.com/@owner',
    subjects: ['station:test'],
    note: 'note',
  },
  {
    id: 'other',
    platform: 'youtube',
    videoId: 'CCCCCCCCCCC',
    title: 'Elsewhere',
    owner: 'Owner',
    ownerUrl: 'https://www.youtube.com/@owner',
    subjects: ['station:other'],
    note: 'note',
  },
]);

function fixture({
  withHost = true,
  withCockpitHost = true,
  cockpitMode = false,
} = {}) {
  const globalRef = new EventTarget();
  const intervals = [];
  globalRef.setInterval = (callback, ms) => {
    const id = intervals.length + 1;
    intervals.push({ id, callback, ms, cleared: false });
    return id;
  };
  globalRef.clearInterval = (id) => {
    const timer = intervals.find((entry) => entry.id === id);
    if (timer) timer.cleared = true;
  };
  const timeouts = [];
  globalRef.setTimeout = (callback, ms) => {
    timeouts.push({ callback, ms, done: false });
    return timeouts.length;
  };
  globalRef.clearTimeout = (id) => {
    if (timeouts[id - 1]) timeouts[id - 1].done = true;
  };
  /** Run the timeouts due now, as the next tick would. */
  const tick = () => {
    for (const timeout of timeouts.splice(0))
      if (!timeout.done) timeout.callback();
  };
  const host = { id: LIVE_PLAYER_HOST_ID };
  const cockpitHost = { id: COCKPIT_LIVE_PLAYER_HOST_ID };
  const documentRef = {
    getElementById: (id) => {
      if (id === LIVE_PLAYER_HOST_ID) return withHost ? host : null;
      if (id === COCKPIT_LIVE_PLAYER_HOST_ID)
        return withCockpitHost ? cockpitHost : null;
      return null;
    },
    body: {
      classList: { contains: (name) => cockpitMode && name === 'cockpit-mode' },
    },
  };
  const published = [];
  const store = {
    ...createOwners(),
    publish: (view) => published.push(view),
  };
  let keys = [];
  const layer = { getLiveSubjectKeys: () => keys };
  const layouts = [];
  const players = [];
  const createPlayer = (options) => {
    const player = {
      options,
      destroyed: 0,
      destroy: () => (player.destroyed += 1),
    };
    players.push(player);
    return player;
  };
  const controls = new LiveControls({
    store,
    actions: {
      getLayer: (layerId) => (layerId === 'satellites' ? layer : null),
      scheduleLayout: () => layouts.push(1),
    },
    documentRef,
    globalRef,
    createPlayer,
    streams: STREAMS,
    refreshMs: 2000,
  });
  const dispatch = (type, detail) =>
    globalRef.dispatchEvent(new CustomEvent(type, { detail }));
  const select = (detail) =>
    dispatch('gev:awareness-subject-selected', {
      layerId: 'satellites',
      id: 25544,
      label: 'ISS (ZARYA)',
      ...detail,
    });
  const view = () => published.at(-1);
  const running = () => intervals.filter((timer) => !timer.cleared);
  return {
    controls,
    store,
    published,
    view,
    dispatch,
    select,
    setKeys: (next) => (keys = next),
    players,
    layouts,
    intervals,
    running,
    tick,
    host,
    cockpitHost,
  };
}

test('nothing selected publishes no section; a selection with streams publishes them', () => {
  const f = fixture();
  assert.equal(f.view(), null);
  f.setKeys(['station:test']);
  f.select();
  const view = f.view();
  assert.equal(view.label, 'ISS (ZARYA)');
  assert.equal(view.count, 2);
  assert.equal(view.index, 0);
  assert.deepEqual(
    view.streams.map((stream) => stream.id),
    ['one', 'two'],
  );
  assert.equal(view.current.id, 'one');
  assert.equal(
    view.current.watchUrl,
    'https://www.youtube.com/watch?v=AAAAAAAAAAA',
  );
  assert.equal(view.state, 'idle');
  assert.equal(
    f.layouts.length,
    1,
    'the rail is laid out once the section appears',
  );
  assert.equal(f.running().length, 1, 'the subject is re-read on a timer');
  assert.equal(f.running()[0].ms, 2000);
});

test('a selection no stream names keeps the section away; the plain key counts too', () => {
  const f = fixture();
  f.select();
  assert.equal(f.view(), null);
  assert.equal(f.layouts.length, 0);
  // A stream attached to a layer's own `<layer>:<id>` key needs no layer help.
  const g = fixture();
  g.setKeys([]);
  g.select({ layerId: 'satellites', id: 'x' });
  assert.equal(g.view(), null);
});

test('the layer is asked again on the timer: an entry that settles as docked gains the streams', () => {
  const f = fixture();
  f.select();
  assert.equal(f.view(), null);
  f.setKeys(['station:test']);
  f.running()[0].callback();
  assert.equal(f.view()?.count, 2);
  assert.equal(f.layouts.length, 1);
  // Unchanged keys do not lay out again.
  f.running()[0].callback();
  assert.equal(f.layouts.length, 1);
});

test('playLive builds the player for the chosen stream in the section, once; Try again builds it anew', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  assert.equal(
    f.players.length,
    0,
    'the views ask; selection alone builds nothing',
  );
  assert.equal(f.store.act('playLive'), true);
  assert.equal(f.players.length, 1);
  assert.equal(f.players[0].options.videoId, 'AAAAAAAAAAA');
  assert.equal(f.players[0].options.host, f.host);
  assert.equal(f.view().state, 'loading');
  // Asked again while loading or playing, the same player stays.
  assert.equal(f.store.act('playLive'), true);
  f.players[0].options.onChange({ state: 'playing', reason: null });
  assert.equal(f.store.act('playLive'), true);
  assert.equal(f.players.length, 1, 'no second player for the same stream');
  assert.equal(f.players[0].destroyed, 0);
  assert.equal(f.view().state, 'playing');
  f.players[0].options.onChange({ state: 'offline', reason: 'ended' });
  assert.equal(f.view().state, 'offline');
  assert.equal(f.view().reason, 'ended');
  assert.equal(f.store.act('stopLive'), true);
  assert.equal(f.players[0].destroyed, 1);
  assert.equal(f.view().state, 'idle');
  // Try again builds a fresh player.
  assert.equal(f.store.act('retryLive'), true);
  assert.equal(f.players.length, 2);
});

test('Play without the host element in the page, or without a selection, does nothing', () => {
  const noHost = fixture({ withHost: false });
  noHost.setKeys(['station:test']);
  noHost.select();
  assert.equal(noHost.store.act('playLive'), false);
  assert.equal(noHost.players.length, 0);
  const idle = fixture();
  assert.equal(idle.store.act('playLive'), false);
});

test('the arrows step through the streams, wrapping, and a playing stream hands over', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  assert.equal(f.store.act('cycleLive', 1), true);
  assert.equal(f.view().current.id, 'two');
  assert.equal(f.store.act('cycleLive', 1), true);
  assert.equal(f.view().current.id, 'one', 'wraps forward');
  assert.equal(f.store.act('cycleLive', -1), true);
  assert.equal(f.view().current.id, 'two', 'wraps backward');
  assert.equal(f.players.length, 0, 'stepping while idle loads nothing');
  f.store.act('playLive');
  f.store.act('cycleLive', 1);
  assert.equal(f.players.length, 2);
  assert.equal(f.players[0].destroyed, 1);
  assert.equal(f.players[1].options.videoId, 'AAAAAAAAAAA');
  assert.equal(f.view().state, 'loading');
});

test('with one stream there is nothing to cycle', () => {
  const f = fixture();
  f.setKeys(['station:other']);
  f.select();
  assert.equal(f.view().count, 1);
  assert.equal(f.store.act('cycleLive', 1), false);
  assert.equal(f.view().current.id, 'other');
});

test('a new selection stops the stream; the same entry selected again keeps it', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.store.act('playLive');
  f.select({ origin: 'pick' });
  assert.equal(f.players[0].destroyed, 0, 'the same subject plays on');
  f.setKeys(['station:other']);
  f.select({ id: 99999, label: 'OTHER' });
  assert.equal(f.players[0].destroyed, 1);
  assert.equal(f.view().label, 'OTHER');
  assert.equal(f.view().current.id, 'other');
  assert.equal(f.view().state, 'idle');
});

test('clearing the selection takes the section down; another layer clearing does not', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.store.act('playLive');
  f.dispatch('gev:awareness-subject-cleared', { layerId: 'flights' });
  assert.equal(f.view().count, 2, 'another layer clearing is not ours');
  f.dispatch('gev:awareness-subject-cleared', { layerId: 'satellites' });
  assert.equal(f.running().length, 0, 'the timer stops with the selection');
  // The stop waits a tick, for a selection that moves straight on.
  assert.equal(f.players[0].destroyed, 0);
  f.tick();
  assert.equal(f.view(), null);
  assert.equal(f.players[0].destroyed, 1);
});

test('a selection that moves straight on to an entry with the same stream keeps the player', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.store.act('playLive');
  // The Cockpit stepping to the next view on the station: cleared, then the
  // next entry selected, in one go.
  f.dispatch('gev:awareness-subject-cleared', { layerId: 'satellites' });
  f.select({ id: 49044, label: 'ISS (NAUKA)' });
  f.tick();
  assert.equal(f.players.length, 1, 'not rebuilt');
  assert.equal(f.players[0].destroyed, 0);
  assert.equal(f.view().label, 'ISS (NAUKA)');
  assert.equal(f.view().current.id, 'one');
  // One without that stream stops it.
  f.dispatch('gev:awareness-subject-cleared', { layerId: 'satellites' });
  f.setKeys(['station:other']);
  f.select({ id: 99999, label: 'OTHER' });
  f.tick();
  assert.equal(f.players[0].destroyed, 1);
});

test('entering or leaving the Cockpit removes the player: the view now shown offers Play again', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.store.act('playLive');
  f.players[0].options.onChange({ state: 'playing', reason: null });
  f.dispatch('gev:cockpit-mode-changed', { active: true });
  assert.equal(f.players[0].destroyed, 1, 'the rail is hidden in the Cockpit');
  assert.equal(f.players.length, 1, 'nothing is built by itself');
  assert.equal(f.view().state, 'idle');
  // The same state again changes nothing.
  f.dispatch('gev:cockpit-mode-changed', { active: true });
  assert.equal(f.players.length, 1);
  // Play in the Cockpit's page builds it in that page's screen.
  assert.equal(f.store.act('playLive'), true);
  assert.equal(f.players[1].options.host, f.cockpitHost);
  f.dispatch('gev:cockpit-mode-changed', { active: false });
  assert.equal(f.players[1].destroyed, 1);
  assert.equal(f.players.length, 2);
});

test('a view that is hidden removes the player only when it is in that view', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.store.act('playLive');
  assert.equal(f.store.act('hideLive', 'cockpit'), false, 'not in the page');
  assert.equal(f.players[0].destroyed, 0);
  assert.equal(f.store.act('hideLive', 'section'), true);
  assert.equal(f.players[0].destroyed, 1);
  assert.equal(f.view().state, 'idle');
  assert.equal(f.store.act('hideLive', 'section'), false, 'nothing left');
});

test('selecting a station with streams builds no player until Play', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.select({ origin: 'pick' });
  f.dispatch('gev:cockpit-mode-changed', { active: true });
  f.dispatch('gev:cockpit-mode-changed', { active: false });
  assert.equal(f.players.length, 0);
  assert.equal(f.view().state, 'idle');
  f.store.act('playLive');
  assert.equal(f.players.length, 1);
});

test('the Cockpit going on or off with nothing playing builds nothing', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.dispatch('gev:cockpit-mode-changed', { active: true });
  f.dispatch('gev:cockpit-mode-changed', { active: false });
  assert.equal(f.players.length, 0);
  assert.equal(f.view().state, 'idle');
});

test("entering the Cockpit without the page's screen in the page removes the player", () => {
  const f = fixture({ withCockpitHost: false });
  f.setKeys(['station:test']);
  f.select();
  f.store.act('playLive');
  f.dispatch('gev:cockpit-mode-changed', { active: true });
  assert.equal(f.players[0].destroyed, 1);
  assert.equal(f.players.length, 1);
  assert.equal(
    f.view().state,
    'idle',
    'the view starts it once its screen is there',
  );
  assert.equal(f.store.act('playLive'), false, 'still no screen');
});

test("constructed with the Cockpit already on, playLive uses the page's screen", () => {
  const f = fixture({ cockpitMode: true });
  f.setKeys(['station:test']);
  f.select();
  assert.equal(f.store.act('playLive'), true);
  assert.equal(f.players[0].options.host, f.cockpitHost);
});

test('the chosen stream going from the list stops it and picks the first that remains', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.store.act('cycleLive', 1);
  f.store.act('playLive');
  f.setKeys(['station:other']);
  f.running()[0].callback();
  assert.equal(f.players[0].destroyed, 1);
  assert.equal(f.view().current.id, 'other');
  assert.equal(f.view().state, 'idle');
});

test('destroy stops the stream, detaches the actions and publishes nothing', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  f.store.act('playLive');
  f.controls.destroy();
  assert.equal(f.players[0].destroyed, 1);
  assert.equal(f.view(), null);
  assert.equal(f.store.act('playLive'), undefined, 'no owner answers');
  assert.equal(f.running().length, 0);
  const before = f.published.length;
  f.select();
  assert.equal(f.published.length, before, 'events after destroy are ignored');
});

test('the 2 s refresh publishes nothing when nothing changed', () => {
  const f = fixture();
  f.setKeys(['station:test']);
  f.select();
  const count = f.published.length;
  for (const timer of f.running()) timer.callback();
  for (const timer of f.running()) timer.callback();
  assert.equal(f.published.length, count, 'the same view is not sent again');
  f.store.act('playLive');
  assert.ok(f.published.length > count, 'a change is');
});
