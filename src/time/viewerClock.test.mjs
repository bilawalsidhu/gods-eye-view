import test from 'node:test';
import assert from 'node:assert/strict';
import { followWorldTime } from './viewerClock.js';

function fakeViewer() {
  const listeners = new Set();
  return {
    clock: { currentTime: {} },
    scene: {
      requestRender() {},
      preUpdate: {
        addEventListener(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    },
  };
}

test('the scene hears when the world time plays on its own, and when it stops', () => {
  let listener = null;
  const subscribe = (fn) => {
    listener = fn;
    return () => (listener = null);
  };
  const heard = [];
  let at = 0;
  const stop = followWorldTime(fakeViewer(), () => at, {
    subscribe,
    requestRender: () => {},
    onPlaying: (playing) => heard.push(playing),
  });
  const state = (fields) => ({
    live: false,
    playing: false,
    stepping: false,
    buffering: false,
    ...fields,
  });
  listener(state({ live: true, playing: true }));
  assert.deepEqual(heard, [], 'live time is not playback');
  listener(state({ playing: true }));
  listener(state({ playing: true }));
  assert.deepEqual(heard, [true], 'heard once');
  listener(state({ playing: true, buffering: true }));
  assert.deepEqual(heard, [true, false], 'waiting for a layer: still');
  listener(state({ playing: true }));
  listener(state({ playing: true, stepping: true }));
  assert.deepEqual(heard, [true, false, true, false], 'a driver steps it');
  listener(state({ playing: true }));
  stop();
  assert.deepEqual(
    heard,
    [true, false, true, false, true, false],
    'stopping releases',
  );
  assert.equal(listener, null);
});
