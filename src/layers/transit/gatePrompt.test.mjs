// The Transit coverage prompt names the altitude the closed gate
// actually opens at. Descending over Boston to 2,900 km (below 3,000 km, above
// the 2,850 km enter threshold) loads nothing, so a prompt "Fly below 3,000 km"
// asks for something the camera has already done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createViewport } from './viewport.js';
import { createQueries } from './queries.js';
import { ACTIVATION_ENTER_ALTITUDE_M } from './policy.js';

const BOSTON = { lat: 42.3601, lon: -71.0589 };

function makeLayer() {
  const services = {
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    render: { governorRequestRender() {} },
  };
  const state = createState({ services });
  const polled = [];
  const parts = {
    ingestion: {
      feedStatus: () => ({ count: 0 }),
      pollFeed: (feed) => polled.push(feed.id),
      removeFeedVehicles() {},
      sweepAgedVehicles() {},
    },
    rendering: { requestVisibility() {}, syncRenderHold() {} },
  };
  parts.viewport = createViewport({ state, services, parts });
  const queries = createQueries({ state, parts }).methods;
  state._enabled = true;
  const rad = Math.PI / 180;
  state._viewer = {
    camera: {
      positionCartographic: {
        height: 0,
        latitude: BOSTON.lat * rad,
        longitude: BOSTON.lon * rad,
      },
      computeViewRectangle: () => undefined,
    },
    scene: { globe: {} },
  };
  return { state, queries, viewport: parts.viewport, polled };
}

test('below the prompted altitude but above the gate, the prompt names the gate', () => {
  const { state, queries, viewport, polled } = makeLayer();
  state._viewer.camera.positionCartographic.height = 2_900_000;
  viewport.runProximityCheck();

  // Nothing loads at 2,900 km: the gate opens at the enter threshold.
  assert.equal(state._altitudeGateOpen, false);
  assert.deepEqual(polled, []);

  const km = Math.round(ACTIVATION_ENTER_ALTITUDE_M / 1000).toLocaleString(
    'en-US',
  );
  const { statusMessage } = queries.getStats();
  assert.equal(statusMessage, `Fly below ${km} km to a covered region`);
});
