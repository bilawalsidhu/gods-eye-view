import assert from 'node:assert/strict';
import test from 'node:test';
import { withFrameUpdates } from './frameDescriptor.js';

test('deleting a descriptor unsubscribes only that renderer from the warm view', () => {
  const frames = new Set();
  const view = {
    on(name, cb) {
      assert.equal(name, 'preRender');
      frames.add(cb);
    },
    off(name, cb) {
      assert.equal(name, 'preRender');
      frames.delete(cb);
    },
  };
  class Base {
    view = view;
    onCreate() {}
    onDestroy() {
      this.destroyed = true;
    }
  }
  class Layer extends withFrameUpdates(Base) {
    ticks = [];
    updateFrame(time) {
      this.ticks.push(time);
    }
  }
  const a = new Layer(),
    b = new Layer();
  a.onCreate();
  b.onCreate();
  assert.equal(typeof a.update, 'undefined', 'no duplicate SDK subscription');
  for (const cb of frames) cb(1);
  a.onDestroy();
  for (const cb of frames) cb(2);
  assert.deepEqual(a.ticks, [1]);
  assert.deepEqual(b.ticks, [1, 2]);
  assert.equal(a.destroyed, true);
  b.onDestroy();
  assert.equal(frames.size, 0);
});
