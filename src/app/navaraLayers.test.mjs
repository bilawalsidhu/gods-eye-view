// The layers the Navara mode draws (registerNavaraLayerRenderers): each W1
// layer with a Navara renderer, registered once, through import().

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerNavaraLayerRenderers } from './navaraMode.js';
import {
  createLayerAvailability,
  layerAvailableOn,
  rendererFor,
} from './layers/renderers.js';

test('the Navara mode registers migrated renderers once', async () => {
  assert.equal(layerAvailableOn('military', 'navara'), false);
  await Promise.all([
    registerNavaraLayerRenderers(),
    registerNavaraLayerRenderers(),
  ]);
  await registerNavaraLayerRenderers();
  for (const id of [
    'flights',
    'military',
    'local-adsb',
    'rocket-launches',
    'satellites',
    'ais-live-vessels',
    'earthquakes',
    'local-firms',
    'military-installations',
    'bikeshare',
  ])
    assert.equal(layerAvailableOn(id, 'navara'), true, id);
  assert.deepEqual(
    createLayerAvailability('navara')
      .available()
      .map(({ id }) => id),
    [
      'flights',
      'military',
      'local-adsb',
      'earthquakes',
      'satellites',
      'rocket-launches',
      'bikeshare',
      'ais-live-vessels',
      'military-installations',
      'local-firms',
    ],
  );
  assert.equal(layerAvailableOn('satellites', 'navara'), true);
});
