import assert from 'node:assert/strict';
import test from 'node:test';
import { bindRenderer } from '../render/rendererOf.js';
import { renderedFrames } from './renderedFrames.js';

test('the key changes once per drawn frame, after it is drawn', () => {
  const viewer = {};
  const listeners = { postRender: new Set() };
  bindRenderer(viewer, {
    frame: {
      on(phase, cb) {
        listeners[phase].add(cb);
        return () => listeners[phase].delete(cb);
      },
    },
  });
  assert.equal(renderedFrames(viewer), 0);
  assert.equal(renderedFrames(viewer), 0, 'reading does not advance it');
  assert.equal(listeners.postRender.size, 1);
  for (const cb of listeners.postRender) cb({});
  assert.equal(renderedFrames(viewer), 1);
  renderedFrames(viewer);
  assert.equal(listeners.postRender.size, 1, 'one listener per frame port');
});

test('without a frame port the key is -1', () => {
  assert.equal(renderedFrames(null), -1);
  assert.equal(renderedFrames({}), -1);
});
