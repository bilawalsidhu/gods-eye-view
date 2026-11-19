/**
 * @module render/stub/harness
 * @description The stub as the conformance suite's renderer under test, for
 * the Node test and the browser page alike.
 */
import { DEFAULT_TOLERANCE } from '../conformance/index.js';
import { createStubRenderer, STUB_FAILING_MODEL_SCHEME } from './index.js';
import { toEcef } from './math.js';

/** @returns {import('../conformance/index.js').ConformanceHarness} */
export function createStubHarness(name = 'stub') {
  // Each renderer's container: a stand-in that says its size, which the
  // stub's `resize` follows.
  const containers = new WeakMap();
  return {
    name,
    create: async ({ viewport, capabilities }) => {
      const container = {
        clientWidth: viewport.width,
        clientHeight: viewport.height,
      };
      const r = createStubRenderer({ viewport, capabilities, container });
      containers.set(r, container);
      return r;
    },
    resizeContainer: (r, { width, height }) => {
      const container = containers.get(r);
      if (!container) return;
      container.clientWidth = width;
      container.clientHeight = height;
    },
    frame: (r) => {
      r.testing.tick();
    },
    now: (r) => r.testing.now(),
    toEcef,
    tolerance: DEFAULT_TOLERANCE,
    flightPaths: 'trace',
    // It draws only models into pixels.
    pixels: false,
    pointer: (r, type, x, y, extra) => r.testing.pointer(type, x, y, extra),
    scriptHeights: (r, fn) => r.testing.setHeights(fn),
    wallTime: (r) => r.testing.wallTime(),
    // The stub loads nothing: any url is a model it draws, but one under
    // its failing scheme.
    assets: {
      model: 'stub:model.glb',
      missingModel: `${STUB_FAILING_MODEL_SCHEME}model.glb`,
      // Any bytes: the stub parses none.
      modelBytes: async () => new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    },
  };
}
