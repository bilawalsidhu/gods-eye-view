import assert from 'node:assert/strict';
import test from 'node:test';
import { createNavaraCloudCover } from './cockpitClouds.js';

test('only a look with clouds gives the engine a cloud cover port', () => {
  assert.equal(createNavaraCloudCover(null), null);
  assert.equal(
    createNavaraCloudCover({ hasClouds: false, setCloudCoverage() {} }),
    null,
  );
  const set = [];
  const port = createNavaraCloudCover({
    hasClouds: true,
    setCloudCoverage: (coverage) => set.push(coverage),
  });
  port.set({ coverage: 0.4 });
  port.set({ coverage: null });
  port.set({ coverage: 0 });
  port.destroy();
  assert.deepEqual(set, [0.4, null, 0, null], 'destroy gives the look its own');
});
