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
    'air-quality',
    'fire-perimeters',
    'gnss-integrity',
    'local-firms',
    'military-installations',
    'bikeshare',
    'radio',
    'alpr-cameras',
    'cctv',
    'transit',
    'recent-imagery',
  ])
    assert.equal(layerAvailableOn(id, 'navara'), true, id);
  assert.deepEqual(
    createLayerAvailability('navara')
      .available()
      .map(({ id }) => id),
    [
      'bhote-koshi-2026',
      'bhote-koshi-locator',
      'flights',
      'military',
      'local-adsb',
      'earthquakes',
      'air-quality',
      'fire-perimeters',
      'gnss-integrity',
      's2-ghostmaps',
      'alpr-cameras',
      'street-level',
      'satellites',
      'rocket-launches',
      'traffic',
      'cctv',
      'radio',
      'transit',
      'bikeshare',
      'directions',
      'recent-imagery',
      'ais-live-vessels',
      'military-installations',
      'military-awareness',
      'wind',
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
      'local-datacenters',
      'local-dams',
      'telegeography-submarine-cables',
      'local-firms',
    ],
  );
  assert.equal(layerAvailableOn('satellites', 'navara'), true);
});
