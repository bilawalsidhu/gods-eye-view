import test from 'node:test';
import assert from 'node:assert/strict';
import { layersNotOnThisEngine } from './shareRestoration.js';

test('the notice names the link layers this engine leaves out', () => {
  assert.deepEqual(
    layersNotOnThisEngine([
      { layerId: 'flights', phase: 'missing', targetEnabled: true },
      { layerId: 'ais-live-vessels', phase: 'missing', targetEnabled: true },
      { layerId: 'traffic', phase: 'missing', targetEnabled: false },
      { layerId: 'satellites', phase: 'settled', targetEnabled: true },
    ]),
    ['Live Flights', 'Live AIS Vessels'],
  );
  assert.deepEqual(layersNotOnThisEngine([]), []);
});
