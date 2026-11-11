// The layers on Navara: every directory layer, with the manifest's Navara
// renderers and backends loaded once, through import() (loadLayerRenderers).

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLayerRenderers, rendererFor } from './layers/renderers.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

test('Navara loads its renderers once and shows every layer', async () => {
  const engine = createFakeEngine({ kind: 'navara' });
  assert.throws(() => rendererFor('wind', engine), /not loaded/);
  const first = loadLayerRenderers('navara');
  assert.equal(loadLayerRenderers('navara'), first, 'one load at a time');
  await Promise.all([first, loadLayerRenderers('navara')]);
  await loadLayerRenderers('navara');
  // Navara's own renderers answer now, with its view: a weather renderer
  // draws nothing until it has a frame.
  const viewed = { ...engine, extensions: { navara: {} } };
  const weather = rendererFor('weather-radar', viewed, {});
  assert.equal(typeof weather, 'object');
  // The layers that draw themselves still have none.
  for (const id of ['wildlife-sightings', 'sea-marks', 'ski-pistes'])
    assert.equal(rendererFor(id, engine), null, id);
  // Cesium loads the same displays: wind draws through one there too.
  await loadLayerRenderers('cesium');
  assert.equal(typeof rendererFor('wind', createFakeEngine()), 'object');
});
