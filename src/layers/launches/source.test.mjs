import test from 'node:test';
import assert from 'node:assert/strict';
import { createLaunchSource } from './source.js';
import { createRocketLaunchesLayer } from './index.js';

test('launch sources preserve last-good eligibility by rejecting malformed snapshots', async () => {
  for (const payload of [{}, { results: null }]) {
    const source = createLaunchSource({
      fetchImpl: async () => new Response(JSON.stringify(payload)),
    });
    await assert.rejects(source.getLaunches(), /Malformed launch snapshot/);
  }
});

test('launch and active-orbit responses reject cancellation during parsing', async () => {
  for (const method of ['getLaunches', 'getActiveTle']) {
    const controller = new AbortController();
    const source = createLaunchSource({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          controller.abort();
          return { results: [] };
        },
        async text() {
          controller.abort();
          return 'late orbit';
        },
      }),
    });
    await assert.rejects(source[method]({ signal: controller.signal }), {
      name: 'AbortError',
    });
  }
});

test('launch factories construct independently without starting a scene or source request', () => {
  const source = {
    getLaunches() {
      assert.fail('construction fetched launches');
    },
    getActiveTle() {
      assert.fail('construction fetched orbits');
    },
  };
  const services = { satellites: {}, geometry: {}, overlays: {}, render: {} };
  const first = createRocketLaunchesLayer({ source, services });
  const second = createRocketLaunchesLayer({ source, services });
  first._setSelectedRocketMissionForTest('first');
  assert.notEqual(first, second);
  assert.equal(first.getStats().count, 0);
  assert.equal(second.getStats().count, 0);
});
