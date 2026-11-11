import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../fakeEngine.js';
import { fakeContractOptions } from '../contractFixtures.js';
import { createContractSuite } from './index.mjs';

for (const scenario of ['delayed', 'cached', 'missing left', 'missing right']) {
  test(`imagery resize check: ${scenario} tiles`, async () => {
    const engine = createFakeEngine();
    const previous = engine.host.size();
    const options = fakeContractOptions(engine);
    const createLayer = engine.imagery.createLayer.bind(engine.imagery);
    let transform;
    let resized = false;
    let frames = 0;
    engine.imagery.createLayer = (input) => {
      transform = input.source.transform;
      transform();
      return createLayer(input);
    };
    const check = createContractSuite(engine, {
      ...options,
      maxWaitFrames: 20,
      makeCanvas: () => ({ getContext: () => ({ fillRect() {} }) }),
      resize: async (width, height) => {
        await options.resize(width, height);
        resized = width === 1280 && height === 800;
        frames = 0;
      },
      waitFrames: async (count) => {
        await options.waitFrames(count);
        if (resized) {
          frames += count;
          if (frames === 1 && scenario !== 'cached') transform();
        }
      },
      readRegion: (x, y, width, height) => {
        const size = engine.host.size();
        assert.ok(x >= 0 && x < size.width);
        assert.equal(y, size.height / 2);
        assert.equal(width, 1);
        assert.equal(height, 1);
        let painted = true;
        if (resized) {
          if (scenario === 'delayed') painted = frames >= 12;
          if (scenario === 'missing left') painted = x > size.width / 2;
          if (scenario === 'missing right') painted = x < size.width / 2;
        }
        return new Uint8Array(
          painted ? [51, 153, 102, 255] : [242, 239, 233, 255],
        );
      },
    }).find(({ name }) => name.startsWith('imagery.createLayer: resize'));
    try {
      if (scenario.startsWith('missing'))
        await assert.rejects(
          check.run(),
          /imagery drawn after resize did not happen within 20 frames/,
        );
      else await check.run();
      assert.deepEqual(engine.host.size(), previous);
      assert.deepEqual(engine.imagery.list(), []);
    } finally {
      engine.destroy();
    }
  });
}
