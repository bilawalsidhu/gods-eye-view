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
  return {
    name,
    create: async ({ viewport, capabilities }) =>
      createStubRenderer({ viewport, capabilities }),
    frame: (r) => {
      r.testing.tick();
    },
    now: (r) => r.testing.now(),
    toEcef,
    tolerance: DEFAULT_TOLERANCE,
    flightPaths: 'trace',
    pointer: (r, type, x, y, extra) => r.testing.pointer(type, x, y, extra),
    scriptHeights: (r, fn) => r.testing.setHeights(fn),
    wallTime: (r) => r.testing.wallTime(),
    // The stub loads nothing: any url is a model it draws, but one under
    // its failing scheme.
    assets: {
      model: 'stub:model.glb',
      missingModel: `${STUB_FAILING_MODEL_SCHEME}model.glb`,
    },
  };
}
