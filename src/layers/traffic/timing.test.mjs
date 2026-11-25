// src/layers/traffic/timing.test.mjs — the development timing trace marks
// the first drawn frame after a dot render through the renderer's frame
// port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRenderer } from '../../render/rendererOf.js';
import { createTiming } from './timing.js';

function fakeFrame() {
  const listeners = new Map();
  return {
    port: {
      on(phase, cb) {
        if (!listeners.has(phase)) listeners.set(phase, new Set());
        listeners.get(phase).add(cb);
        return () => listeners.get(phase).delete(cb);
      },
    },
    count: (phase) => listeners.get(phase)?.size ?? 0,
    fire: (phase) => {
      for (const cb of [...(listeners.get(phase) ?? [])]) cb({ frame: 1 });
    },
  };
}

test('the next drawn frame after a render is marked and measured once', () => {
  const viewer = { scene: {} };
  const frame = fakeFrame();
  const unbind = bindRenderer(viewer, { frame: frame.port });
  const layerState = {
    _viewer: viewer,
    _trafficTimingSequence: 0,
    _trafficTimingPostRenderRemovers: new Set(),
  };
  const timing = createTiming({
    state: layerState,
    services: {},
    parts: {},
    source: {},
  });
  performance.clearMarks();
  performance.clearMeasures();
  performance.mark('fam-camera');
  performance.mark('fam-render-end');
  const trace = {
    pass: 'full',
    trace: { id: 'trace-1', cameraChangeMark: 'fam-camera' },
  };
  try {
    timing.scheduleTrafficTimingPostRender(trace, 'fam-render-end', 7, {
      dots: 3,
    });
    assert.equal(frame.count('postRender'), 1);
    assert.equal(layerState._trafficTimingPostRenderRemovers.size, 1);
    frame.fire('postRender');
    frame.fire('postRender');
    const marks = performance
      .getEntriesByType('mark')
      .filter((m) => m.name.startsWith('traffic:trace-1:full:'));
    assert.deepEqual(
      marks.map((m) => m.name.split(':')[3]),
      ['next-post-render', 'first-visible-pixel'],
    );
    assert.equal(marks[0].detail.renderId, 7);
    assert.ok(
      performance
        .getEntriesByName('traffic:render-to-post-render:full')
        .some((m) => m.detail.renderId === 7),
    );
    assert.equal(frame.count('postRender'), 0, 'one frame, then gone');
    assert.equal(layerState._trafficTimingPostRenderRemovers.size, 0);
  } finally {
    unbind();
    performance.clearMarks();
    performance.clearMeasures();
  }
});

test('without a frame port nothing is scheduled', () => {
  const layerState = {
    _viewer: null,
    _trafficTimingSequence: 0,
    _trafficTimingPostRenderRemovers: new Set(),
  };
  const timing = createTiming({
    state: layerState,
    services: {},
    parts: {},
    source: {},
  });
  timing.scheduleTrafficTimingPostRender({}, 'none', 1, {});
  assert.equal(layerState._trafficTimingPostRenderRemovers.size, 0);
});
