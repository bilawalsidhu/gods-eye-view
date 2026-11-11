import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../fakeEngine.js';
import { createContractSuite } from './index.mjs';

for (const timing of ['on time', 'late', 'missing']) {
  test(`flight duration check: ${timing} completion`, async (context) => {
    let now = 0;
    context.mock.method(performance, 'now', () => now);
    const engine = createFakeEngine();
    const flyTo = engine.camera.flyTo;
    engine.camera.flyTo = (options) =>
      flyTo({
        ...options,
        complete: () => {
          if (timing === 'missing') return;
          if (timing === 'late') now += 200;
          options.complete?.();
        },
      });
    const check = createContractSuite(engine, {
      waitFrames: async (count) => {
        for (let frame = 0; frame < count; frame++) {
          now += 50;
          engine.fake.frame(50);
        }
      },
    }).find(({ name }) => name.startsWith('camera.flyTo: completes within'));
    try {
      if (timing === 'on time') await check.run();
      else
        await assert.rejects(
          check.run(),
          timing === 'late'
            ? /flight completed after 600 ms/
            : /flight missed its duration/,
        );
      assert.equal(engine.camera.flightActive(), false);
    } finally {
      engine.destroy();
    }
  });
}
