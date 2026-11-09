import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageryRegistry } from './imagery.js';

const image = { width: 2, height: 2, data: new Uint8ClampedArray(16) };

test('clearing a detail still loading clears it on the engine too', async () => {
  const details = [];
  const { imagery } = createImageryRegistry(() => ({
    source() {},
    detail: (detail, finish) => details.push([detail, finish]),
    look() {},
    destroy() {},
  }));
  const raised = imagery.createLayer({
    id: 'shell',
    source: { kind: 'image', image },
    raise: 6000,
  });
  const rectangle = { west: 1, south: 1, east: 2, north: 2 };
  // The engine already holds the detail (Cesium's shell takes it at once);
  // it has not drawn yet.
  const first = raised.setDetail({ image, rectangle });
  assert.equal(await raised.setDetail(null), true);
  assert.equal(await first, false);
  assert.equal(raised.detail(), null);
  assert.equal(details.at(-1)[0], null, 'the engine is told to clear it');
  // Nothing shown or loading: another clear asks nothing of the engine.
  const calls = details.length;
  assert.equal(await raised.setDetail(null), true);
  assert.equal(details.length, calls);
});
