// src/ui/pinnedStation.test.mjs — a pinned station's tap: the station plays
// from the catalogue already read, and Radio is never turned on for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetPinnedStationForTest,
  pinnedStationMiss,
  playPinnedStation,
} from './pinnedStation.js';

/** A Radio layer double whose state a test drives. */
function radioDouble(initial = {}, { listed = ['kut'] } = {}) {
  const listeners = new Set();
  const calls = [];
  let state = {
    enabled: false,
    selected: null,
    audioState: 'stopped',
    playingStationId: null,
    ...initial,
  };
  const radio = {
    calls,
    listeners,
    get state() {
      return state;
    },
    emit(patch) {
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    getUIState: () => state,
    playStation(id, options) {
      calls.push(['play', id, options?.origin]);
      if (!listed.includes(id)) return false;
      radio.emit({
        selected: { id },
        audioState: 'loading',
        playingStationId: id,
      });
      return true;
    },
  };
  return radio;
}

const KUT = { id: 'kut', name: 'KUT 90.5' };
const deps = (radio) => ({ module: () => radio });

test.afterEach(() => _resetPinnedStationForTest());

test('Radio off: the station plays as a user choice, and the layer stays off', () => {
  const radio = radioDouble();
  assert.equal(playPinnedStation(KUT, deps(radio)), 'playing');
  assert.deepEqual(radio.calls, [['play', 'kut', 'user']]);
  assert.equal(radio.state.enabled, false, 'nothing turned Radio on');
});

test('the station already heard plays on, without starting over', () => {
  const radio = radioDouble({
    audioState: 'playing',
    playingStationId: 'kut',
    selected: { id: 'kut' },
  });
  assert.equal(playPinnedStation(KUT, deps(radio)), 'playing');
  assert.deepEqual(radio.calls, []);
});

test('a station the catalogue does not hold is said, until a station sounds', () => {
  const radio = radioDouble({}, { listed: [] });
  assert.equal(playPinnedStation(KUT, deps(radio)), 'missing');
  assert.deepEqual(pinnedStationMiss.value, { id: 'kut', name: 'KUT 90.5' });
  radio.emit({ enabled: false });
  assert.ok(pinnedStationMiss.value, 'Radio staying off keeps the notice');
  radio.emit({ audioState: 'playing', playingStationId: 'other' });
  assert.equal(pinnedStationMiss.value, null);
  assert.equal(radio.listeners.size, 0);
});

test('without a Radio layer nothing happens', () => {
  assert.equal(playPinnedStation(KUT, { module: () => null }), 'unavailable');
  assert.equal(pinnedStationMiss.value, null);
});

test('with Local receiver chosen a pinned station does not play, and is not said to be missing', () => {
  const radio = radioDouble({ source: 'local' });
  assert.equal(playPinnedStation(KUT, deps(radio)), 'unavailable');
  assert.deepEqual(radio.calls, [], 'no internet stream asked for');
  assert.equal(pinnedStationMiss.value, null);
});
