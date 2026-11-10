import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from './fakeEngine.js';
import { fakeContractOptions } from './contractFixtures.js';
import { createContractSuite } from './contractSuite/index.mjs';
import { createContractFixtures as cesiumFixtures } from '../cesium/testing/contractFixtures.js';
import { createContractFixtures as navaraFixtures } from '../navara/testing/contractFixtures.js';

for (const [kind, create] of [
  ['cesium', cesiumFixtures],
  ['navara', navaraFixtures],
]) {
  test(`${kind} adapters pass deterministic sampling and map error suite checks`, async (t) => {
    const fixtures = await create();
    const engine = createFakeEngine({ kind });
    engine.maps = fixtures.maps;
    try {
      const checks = createContractSuite(engine, {
        ...fakeContractOptions(engine),
        fixtures,
      });
      const selected = checks.filter(
        ({ name }) =>
          name.startsWith('maps.errors:') ||
          name.startsWith('maps.terrainRevision: changes when falling') ||
          name.startsWith('surface.sampleTerrainMostDetailed: preserves') ||
          name.startsWith('surface.sampleTerrainMostDetailed: passes'),
      );
      assert.equal(selected.length, kind === 'cesium' ? 8 : 5);
      for (const { name, run } of selected) await t.test(name, run);
    } finally {
      fixtures.destroy?.();
      engine.destroy();
    }
  });
}
