import assert from 'node:assert/strict';
import test from 'node:test';

import { viewportContextDecision } from './realtimeViewport.js';

const localContext = (overrides = {}) => ({
  action: 'get_entity_context',
  scene: { basemap: { viewScale: 'local' } },
  ...overrides,
});

test('viewport context reasons preserve the existing escalation gate', () => {
  assert.deepEqual(
    viewportContextDecision({ action: 'get_current_view_state' }),
    {
      send: false,
      reason: 'not-entity-context',
    },
  );
  assert.deepEqual(
    viewportContextDecision(localContext(), { channelOpen: false }),
    { send: false, reason: 'channel-closed' },
  );
  assert.deepEqual(
    viewportContextDecision({
      action: 'get_entity_context',
      scene: { basemap: { viewScale: 'regional' } },
    }),
    {
      send: false,
      reason: 'view-scale-not-local',
      viewScale: 'regional',
    },
  );
  assert.deepEqual(
    viewportContextDecision(
      localContext({
        selected: {
          id: 'earthquake:1',
          layerId: 'earthquakes',
        },
      }),
    ),
    {
      send: false,
      reason: 'structured-identity-sufficient',
      viewScale: 'local',
    },
  );
  assert.deepEqual(viewportContextDecision(localContext()), {
    send: true,
    reason: 'structured-identity-missing',
    viewScale: 'local',
  });
});

test('nearby structured place identity avoids visual escalation too', () => {
  assert.deepEqual(
    viewportContextDecision(
      localContext({
        scene: {
          basemap: {
            viewScale: 'local',
            nearbyPlaces: [{ name: 'Austin' }],
          },
        },
      }),
    ),
    {
      send: false,
      reason: 'structured-identity-sufficient',
      viewScale: 'local',
    },
  );
});
