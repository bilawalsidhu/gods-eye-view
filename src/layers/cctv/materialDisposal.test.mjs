import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectionMaterialDisposal } from './materialDisposal.js';

test('CCTV textures are destroyed only after native batches detach, without touching other materials', () => {
  const callbacks = new Set();
  const image = {};
  const make = (image) => ({
    uniforms: { image },
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      assert.equal(this.destroyed, false);
      this.destroyed = true;
    },
  });
  const owned = make(image),
    other = make({});
  const primitives = [
    { appearance: { material: owned } },
    { appearance: { material: other } },
  ];
  const scene = {
    primitives: {
      destroyPrimitives: true,
      get length() {
        return primitives.length;
      },
      get: (i) => primitives[i],
    },
    requestRender() {},
    postRender: {
      addEventListener(fn) {
        callbacks.add(fn);
        return () => callbacks.delete(fn);
      },
    },
  };
  const disposal = createProjectionMaterialDisposal(() => scene);
  disposal.retire({ canvas: image });
  for (const fn of [...callbacks]) fn();
  assert.equal(
    owned.destroyed,
    false,
    'an attached material remains valid for rendering',
  );
  primitives.shift();
  for (const fn of [...callbacks]) fn();
  assert.equal(owned.destroyed, true);
  assert.equal(other.destroyed, false);
  assert.equal(
    callbacks.size,
    0,
    'idle cleanup does not retain a scene listener',
  );
  disposal.destroy();
});

test('shared material is retained until its last native primitive releases it', () => {
  let draw;
  let destroyed = 0;
  const image = {};
  const material = {
    uniforms: { image },
    destroy() {
      destroyed++;
    },
  };
  const native = { appearance: { material } };
  const primitives = [native, native];
  const scene = {
    primitives: {
      destroyPrimitives: true,
      get length() {
        return primitives.length;
      },
      get: (i) => primitives[i],
    },
    postRender: {
      addEventListener(fn) {
        draw = fn;
        return () => {};
      },
    },
    requestRender() {},
  };
  const disposal = createProjectionMaterialDisposal(() => scene);
  disposal.retire({ buffers: [image] });
  primitives.pop();
  draw();
  assert.equal(destroyed, 0);
  primitives.pop();
  draw();
  assert.equal(destroyed, 1);
  disposal.destroy();
});

test('active-camera batch replacements release old textures before switching cameras', () => {
  let draw,
    subscribed = true;
  const image = {};
  const make = () => ({
    uniforms: { image },
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
  });
  const first = make(),
    second = make();
  const native = { appearance: { material: first } };
  const sprites = {
    length: 10000,
    get() {
      throw new Error('must not scan contact billboards');
    },
  };
  const primitives = [native, sprites];
  const scene = {
    primitives: {
      destroyPrimitives: true,
      get length() {
        return primitives.length;
      },
      get: (i) => primitives[i],
    },
    postRender: {
      addEventListener(fn) {
        draw = fn;
        return () => {
          subscribed = false;
        };
      },
    },
    requestRender() {},
  };
  const disposal = createProjectionMaterialDisposal(() => scene);
  const runtime = { canvas: image };
  disposal.watch(runtime);
  draw();
  native.appearance.material = second;
  draw();
  assert.equal(
    first.destroyed,
    true,
    'material from an older native batch is released',
  );
  assert.equal(second.destroyed, false);
  disposal.retire(runtime);
  primitives.shift();
  draw();
  assert.equal(second.destroyed, true);
  assert.equal(subscribed, false);
});

test('native batch events trigger cleanup while unchanged frames do no scene scan', () => {
  const event = () => {
    const listeners = new Set();
    return {
      addEventListener(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      raise() {
        for (const fn of [...listeners]) fn();
      },
      get size() {
        return listeners.size;
      },
    };
  };
  const added = event(),
    removed = event(),
    rendered = event();
  const image = {};
  const make = () => ({
    uniforms: { image },
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
  });
  const first = make(),
    second = make();
  const primitives = [{ appearance: { material: first } }];
  let reads = 0;
  const scene = {
    primitives: {
      destroyPrimitives: true,
      primitiveAdded: added,
      primitiveRemoved: removed,
      get length() {
        return primitives.length;
      },
      get(i) {
        reads++;
        return primitives[i];
      },
    },
    postRender: rendered,
    requestRender() {},
  };
  const disposal = createProjectionMaterialDisposal(() => scene);
  const runtime = { canvas: image };
  disposal.watch(runtime);
  rendered.raise();
  const settledReads = reads;
  for (let i = 0; i < 60; i++) rendered.raise();
  assert.equal(reads, settledReads);
  primitives[0] = { appearance: { material: second } };
  removed.raise();
  added.raise();
  rendered.raise();
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, false);
  disposal.retire(runtime);
  primitives.length = 0;
  removed.raise();
  rendered.raise();
  assert.equal(second.destroyed, true);
  assert.deepEqual([added.size, removed.size, rendered.size], [0, 0, 0]);
});
