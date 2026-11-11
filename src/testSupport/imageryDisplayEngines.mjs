import nodeTest from 'node:test';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

/** Each test owns its engines and releases them even after an assertion fails. */
export function imageryDisplayTests() {
  let engines;
  return {
    test(name, run) {
      nodeTest(name, async (t) => {
        engines = [];
        if (!globalThis.document) {
          globalThis.document = {
            createElement: () => ({
              getContext: () => ({
                createImageData: (w, h) => ({
                  data: new Uint8ClampedArray(w * h * 4),
                }),
                putImageData() {},
              }),
            }),
          };
          t.after(() => {
            delete globalThis.document;
          });
        }
        try {
          await run(t);
        } finally {
          for (const engine of engines) engine.destroy();
        }
      });
    },
    createEngine(options) {
      const engine = createFakeEngine(options);
      engines.push(engine);
      return engine;
    },
  };
}
