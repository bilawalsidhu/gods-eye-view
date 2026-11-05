import assert from 'node:assert/strict';
import test from 'node:test';
import {
  layerEffectDesc,
  withFrameUpdates,
  withPassDisposal,
} from './frameDescriptor.js';

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

test('a deleted effect disposes the pass the composer no longer holds', () => {
  const events = [];
  const pass = { dispose: () => events.push('dispose') };
  class Base {
    _instance = { rawPass: pass };
    get raw() {
      return this._instance;
    }
    onDestroy() {
      events.push('remove');
      this._instance = undefined;
    }
  }
  const effect = new (withPassDisposal(Base))();
  effect.onDestroy();
  assert.deepEqual(events, ['remove', 'dispose']);

  // A pass that was never created: nothing to dispose.
  const empty = new (withPassDisposal(
    class {
      onDestroy() {}
    },
  ))();
  assert.doesNotThrow(() => empty.onDestroy());

  // The pass is disposed even when Navara's removal throws.
  class Failing extends Base {
    onDestroy() {
      throw Error('removal failed');
    }
  }
  events.length = 0;
  assert.throws(() => new (withPassDisposal(Failing))().onDestroy(), /removal/);
  assert.deepEqual(events, ['dispose']);
});

test('a layer effect re-created on every attach leaves no pass, material or frame callback behind', () => {
  const frames = new Set();
  const view = {
    on: (name, cb) => frames.add(cb),
    off: (name, cb) => frames.delete(cb),
  };
  const live = new Set();
  class EffectDesc {
    view = view;
    onCreate() {
      const pass = {
        material: {},
        dispose: () => live.delete(pass),
      };
      live.add(pass);
      this._instance = { rawPass: pass };
    }
    get raw() {
      return this._instance;
    }
    onDestroy() {
      // Navara's removePass: out of the composer, not disposed.
      this._instance = undefined;
    }
  }
  // As the earthquakes ground effect: disposes its own effect, then super.
  class LayerEffect extends layerEffectDesc(EffectDesc) {
    updateFrame() {}
    onDestroy() {
      this.effectDisposed = true;
      super.onDestroy();
    }
  }
  for (let attach = 0; attach < 50; attach++) {
    const effect = new LayerEffect();
    effect.onCreate();
    effect.onDestroy();
    assert.equal(effect.effectDisposed, true);
  }
  assert.equal(live.size, 0, 'every pass of a deleted effect is disposed');
  assert.equal(frames.size, 0, 'no frame callback outlives its effect');
});
