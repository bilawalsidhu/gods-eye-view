import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationStreetLevel } from './streetLevel.js';
import { fakeStreetLevelProvider } from '../../testSupport/streetLevelFakes.mjs';

test('explicit providers replace the default source and an empty list removes it', () => {
  const sources = { mapillary: {} };
  const provider = fakeStreetLevelProvider({
    id: 'example',
    pickPrefix: 'example:',
  });
  const layer = createApplicationStreetLevel({
    sources,
    providers: [provider],
  });
  assert.deepEqual(layer.providerIds, ['example']);
  assert.deepEqual(
    createApplicationStreetLevel({ sources, providers: [] }).providerIds,
    [],
  );
  assert.throws(
    () => createApplicationStreetLevel({ sources }),
    /Mapillary source/,
  );
  assert.throws(
    () => createApplicationStreetLevel({ providers: null }),
    /array/,
  );
});
