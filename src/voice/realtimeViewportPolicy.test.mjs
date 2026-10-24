import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RealtimeViewport,
  viewportContextDecision,
} from './realtimeViewport.js';

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
    kind: 'viewport',
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

test('pointer ground selects the #837 crop path, not a full viewport', () => {
  const pointerContext = localContext({
    scope: 'pointer',
    pointer: { target: 'ground' },
    scene: { basemap: { viewScale: 'city' } },
  });
  assert.deepEqual(viewportContextDecision(pointerContext), {
    send: true,
    kind: 'crop',
    reason: 'pointer-ground-crop',
    viewScale: 'city',
  });
  assert.deepEqual(
    viewportContextDecision({
      ...pointerContext,
      scene: { basemap: { viewScale: 'global' } },
    }),
    {
      send: false,
      reason: 'pointer-scale-not-useful',
      viewScale: 'global',
    },
  );
  assert.deepEqual(
    viewportContextDecision({
      ...pointerContext,
      selected: { id: 'building' },
    }),
    {
      send: false,
      reason: 'pointer-identity-present',
      viewScale: 'city',
    },
  );
  assert.deepEqual(
    viewportContextDecision({ ...pointerContext, pointer: null }),
    { send: false, reason: 'pointer-missing', viewScale: 'city' },
  );
});

test('runtime dispatch preserves pointer crop and full image separation', async () => {
  const channel = { readyState: 'open' };
  const pointer = { fresh: true, target: 'ground' };
  const calls = [];
  const viewport = new RealtimeViewport({
    readChannel: () => channel,
    readPointer: () => pointer,
    operations: {
      debugLog: (event, detail) => calls.push({ event, detail }),
    },
    capture: async () => 'unused',
  });
  viewport.sendPointerCrop = async (snapshot, options) => {
    calls.push({ kind: 'crop', snapshot, options });
    return true;
  };
  viewport.sendRetainedImage = async () => {
    calls.push({ kind: 'viewport' });
    return true;
  };

  assert.equal(
    await viewport.sendVisualContextIfUseful(
      localContext({
        scope: 'pointer',
        pointer: { target: 'ground' },
        scene: { basemap: { viewScale: 'city' } },
      }),
    ),
    true,
  );
  assert.equal(calls.filter((call) => call.kind === 'crop').length, 1);
  assert.deepEqual(
    calls.find((call) => call.kind === 'crop').snapshot,
    pointer,
  );
  assert.equal(
    calls.find((call) => call.kind === 'crop').options.viewScale,
    'city',
  );
  assert.equal(calls.filter((call) => call.kind === 'viewport').length, 0);

  assert.equal(await viewport.sendVisualContextIfUseful(localContext()), true);
  assert.equal(calls.filter((call) => call.kind === 'viewport').length, 1);
  assert.equal(
    await viewport.sendVisualContextIfUseful(
      localContext({ selected: { id: 'existing' } }),
    ),
    false,
  );
  assert.equal(calls.filter((call) => call.kind === 'viewport').length, 1);
  assert.ok(
    calls.some(
      (call) =>
        call.event === 'viewport_context.decision' &&
        call.detail.reason === 'pointer-ground-crop',
    ),
  );
});

test('closed channel never captures pointer or full viewport', async () => {
  const viewport = new RealtimeViewport({
    readChannel: () => ({ readyState: 'closed' }),
    readPointer: () => {
      throw new Error('should not inspect pointer when channel is closed');
    },
    operations: {},
  });
  assert.equal(
    await viewport.sendVisualContextIfUseful(
      localContext({ scope: 'pointer', pointer: { target: 'ground' } }),
    ),
    false,
  );
  assert.equal(await viewport.sendVisualContextIfUseful(localContext()), false);
});

test('capture failures and invalidated turns are reason-coded without sending', async () => {
  const channel = { readyState: 'open' };
  const diagnostics = [];
  const viewport = new RealtimeViewport({
    readChannel: () => channel,
    operations: {
      sendRealtimeEvent: () => {
        throw new Error('should not send unavailable image');
      },
      debugLog: (event, detail) => diagnostics.push({ event, detail }),
    },
    capture: async () => null,
  });
  assert.equal(await viewport.sendVisualContextIfUseful(localContext()), false);
  assert.ok(
    diagnostics.some(
      (item) =>
        item.event === 'viewport_context.skipped' &&
        item.detail.reason === 'capture-unavailable',
    ),
  );
  let release;
  viewport.capture = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = viewport.sendVisualContextIfUseful(localContext());
  viewport.reset();
  release('data:image/jpeg;base64,AA==');
  assert.equal(await pending, false);
  assert.ok(
    diagnostics.some(
      (item) =>
        item.event === 'viewport_context.skipped' &&
        item.detail.reason === 'capture-invalidated',
    ),
  );
});

test('successful retained send is logged without recording image contents', async () => {
  const channel = { readyState: 'open' };
  const diagnostics = [];
  const viewport = new RealtimeViewport({
    readChannel: () => channel,
    readCameraKey: () => 'camera:fixture',
    operations: {
      sendRealtimeEvent: () => true,
      debugLog: (event, detail) => diagnostics.push({ event, detail }),
    },
    capture: async () => 'data:image/jpeg;base64,AA==',
  });
  assert.equal(await viewport.sendVisualContextIfUseful(localContext()), true);
  assert.ok(
    diagnostics.some(
      (item) =>
        item.event === 'viewport_context.result' &&
        item.detail.reason === 'sent',
    ),
  );
  assert.equal(JSON.stringify(diagnostics).includes('data:image/jpeg'), false);
});
