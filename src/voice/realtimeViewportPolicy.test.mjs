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
    reason: 'pointer-crop-eligible',
    viewScale: 'city',
  });
  assert.deepEqual(
    viewportContextDecision({
      ...pointerContext,
      scene: { basemap: { viewScale: 'global' } },
    }),
    {
      send: true,
      kind: 'crop',
      reason: 'pointer-crop-eligible',
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
        call.detail.reason === 'pointer-crop-eligible',
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
        item.detail.reason === 'session-reset',
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

const outcomeEvents = new Set([
  'viewport_context.skipped',
  'viewport_context.result',
]);

function recordingViewport(options = {}) {
  const events = [];
  const channel = options.channel ?? { readyState: 'open' };
  const viewport = new RealtimeViewport({
    readChannel: () => channel,
    readCameraKey: () => 'camera:fixture',
    now: () => 1000,
    capturePointer: async () => ({
      dataUrl: 'data:image/jpeg;base64,AA==',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    }),
    capture: async () => 'data:image/jpeg;base64,AA==',
    ...options,
    operations: {
      sendRealtimeEvent: () => true,
      debugLog: (event, detail) => events.push({ event, detail }),
      ...options.operations,
    },
  });
  return { viewport, events };
}

const pointerGround = (overrides = {}) =>
  localContext({
    scope: 'pointer',
    pointer: { target: 'ground' },
    scene: { basemap: { viewScale: 'city' } },
    ...overrides,
  });

const groundSnapshot = (overrides = {}) => ({
  fresh: true,
  target: 'ground',
  screenPx: { x: 10, y: 10 },
  capturedAt: 900,
  cameraKey: 'camera:fixture',
  ...overrides,
});

test('tool results other than entity context log nothing', async () => {
  const { viewport, events } = recordingViewport();
  assert.equal(
    await viewport.sendVisualContextIfUseful({ action: 'fly_to' }),
    false,
  );
  assert.equal(await viewport.sendVisualContextIfUseful(null), false);
  assert.deepEqual(events, []);
});

test('a crop decision that cannot send logs why, under the same id', async () => {
  const cases = [
    [{ fresh: false }, 'pointer-not-fresh'],
    [{ target: 'building' }, 'pointer-not-ground'],
    [{ screenPx: null }, 'pointer-off-screen'],
    [{ capturedAt: -50000 }, 'pointer-expired'],
    [{ cameraKey: null }, 'pointer-pose-unknown'],
    [{ cameraKey: 'camera:moved' }, 'pose-changed'],
  ];
  for (const [override, reason] of cases) {
    const snapshot = groundSnapshot(override);
    const { viewport, events } = recordingViewport({
      readPointer: () => snapshot,
    });
    assert.equal(
      await viewport.sendVisualContextIfUseful(pointerGround()),
      false,
      reason,
    );
    assert.equal(events.length, 2, reason);
    const [decision, outcome] = events;
    assert.equal(decision.event, 'viewport_context.decision');
    assert.equal(decision.detail.reason, 'pointer-crop-eligible');
    assert.deepEqual(outcome, {
      event: 'viewport_context.skipped',
      detail: { contextId: decision.detail.contextId, kind: 'crop', reason },
    });
  }
});

test('a repeated pointer snapshot is logged as already requested', async () => {
  const snapshot = groundSnapshot();
  const { viewport, events } = recordingViewport({
    readPointer: () => snapshot,
  });
  assert.equal(await viewport.sendVisualContextIfUseful(pointerGround()), true);
  assert.equal(
    await viewport.sendVisualContextIfUseful(pointerGround()),
    false,
  );
  const outcomes = events.filter((item) => outcomeEvents.has(item.event));
  assert.deepEqual(
    outcomes.map((item) => [item.detail.kind, item.detail.reason]),
    [
      ['crop', 'sent'],
      ['crop', 'pointer-already-requested'],
    ],
  );
});

test('overlapping requests pair each outcome with its own decision', async () => {
  const releases = [];
  const { viewport, events } = recordingViewport({
    capture: () => new Promise((resolve) => releases.push(resolve)),
  });
  const first = viewport.sendVisualContextIfUseful(localContext());
  const second = viewport.sendVisualContextIfUseful(localContext());
  await Promise.resolve();
  releases[1]('data:image/jpeg;base64,AA==');
  releases[0]('data:image/jpeg;base64,AA==');
  assert.equal(await first, false);
  assert.equal(await second, true);
  const [firstId, secondId] = events
    .filter((item) => item.event === 'viewport_context.decision')
    .map((item) => item.detail.contextId);
  assert.notEqual(firstId, secondId);
  const outcomeFor = (id) =>
    events.filter(
      (item) => outcomeEvents.has(item.event) && item.detail.contextId === id,
    );
  assert.deepEqual(
    outcomeFor(firstId).map((item) => item.detail),
    [{ contextId: firstId, kind: 'viewport', reason: 'superseded' }],
  );
  assert.deepEqual(
    outcomeFor(secondId).map((item) => item.detail),
    [{ contextId: secondId, kind: 'viewport', reason: 'sent' }],
  );
});

test('dropped captures name their cause', async () => {
  const reasonFor = async (context, interrupt, extra = {}) => {
    let release;
    const pending = () => new Promise((resolve) => (release = resolve));
    const { viewport, events } = recordingViewport({
      capture: pending,
      capturePointer: pending,
      ...extra,
    });
    const sent = viewport.sendVisualContextIfUseful(context);
    await Promise.resolve();
    interrupt(viewport);
    release('data:image/jpeg;base64,AA==');
    assert.equal(await sent, false);
    return events
      .filter((item) => outcomeEvents.has(item.event))
      .map((item) => item.detail.reason);
  };

  assert.deepEqual(
    await reasonFor(localContext(), (viewport) => viewport.beginTurn()),
    ['superseded'],
  );
  assert.deepEqual(
    await reasonFor(localContext(), (viewport) => viewport.reset()),
    ['session-reset'],
  );
  const channel = { readyState: 'open' };
  assert.deepEqual(
    await reasonFor(localContext(), () => (channel.readyState = 'closed'), {
      channel,
    }),
    ['channel-lost'],
  );
  let cameraKey = 'camera:fixture';
  const snapshot = groundSnapshot();
  assert.deepEqual(
    await reasonFor(pointerGround(), () => (cameraKey = 'camera:moved'), {
      readPointer: () => snapshot,
      readCameraKey: () => cameraKey,
    }),
    ['frame-stale'],
  );
});

test('every send decision is followed by exactly one outcome', async () => {
  const snapshots = [
    null,
    groundSnapshot(),
    groundSnapshot({ fresh: false }),
    groundSnapshot({ cameraKey: 'camera:moved' }),
    groundSnapshot({ capturedAt: -50000 }),
  ];
  const contexts = [
    localContext(),
    localContext({ selected: { id: 'x', layerId: 'y' } }),
    pointerGround(),
    pointerGround({ scene: { basemap: { viewScale: 'global' } } }),
    pointerGround({ pointer: null }),
  ];
  const captures = [
    async () => 'data:image/jpeg;base64,AA==',
    async () => null,
  ];
  for (const snapshot of snapshots)
    for (const context of contexts)
      for (const capture of captures)
        for (const sendResult of [true, false]) {
          const { viewport, events } = recordingViewport({
            readPointer: () => snapshot,
            capture,
            capturePointer: capture,
            operations: { sendRealtimeEvent: () => sendResult },
          });
          await viewport.sendVisualContextIfUseful(context);
          const [decision, ...rest] = events;
          assert.equal(decision.event, 'viewport_context.decision');
          const outcomes = rest.filter((item) => outcomeEvents.has(item.event));
          assert.equal(outcomes.length, decision.detail.send ? 1 : 0);
          for (const outcome of outcomes) {
            assert.equal(outcome.detail.contextId, decision.detail.contextId);
            assert.equal(outcome.detail.kind, decision.detail.kind);
            if (outcome.event === 'viewport_context.result')
              assert.equal(
                outcome.detail.reason,
                sendResult ? 'sent' : 'data-channel-send-failed',
              );
          }
        }
});

test('a failed data-channel send is never logged as sent', async () => {
  for (const [sendResult, reason] of [
    [true, 'sent'],
    [false, 'data-channel-send-failed'],
  ]) {
    const { viewport, events } = recordingViewport({
      operations: { sendRealtimeEvent: () => sendResult },
    });
    assert.equal(
      await viewport.sendVisualContextIfUseful(localContext()),
      sendResult,
    );
    const outcomes = events.filter((item) => outcomeEvents.has(item.event));
    assert.deepEqual(
      outcomes.map((item) => [item.event, item.detail.reason]),
      [['viewport_context.result', reason]],
    );
  }
});

test('a step that throws still closes its decision, then rethrows', async () => {
  for (const [context, extra] of [
    [
      localContext(),
      {
        capture: async () => {
          throw new Error('capture boom');
        },
      },
    ],
    [
      pointerGround(),
      {
        readPointer: () => {
          throw new Error('pointer boom');
        },
      },
    ],
    [
      pointerGround(),
      {
        readPointer: () => groundSnapshot(),
        capturePointer: async () => {
          throw new Error('crop boom');
        },
      },
    ],
  ]) {
    const { viewport, events } = recordingViewport(extra);
    await assert.rejects(viewport.sendVisualContextIfUseful(context), /boom/);
    const [decision, ...rest] = events;
    assert.deepEqual(rest, [
      {
        event: 'viewport_context.skipped',
        detail: {
          contextId: decision.detail.contextId,
          kind: decision.detail.kind,
          reason: 'error',
        },
      },
    ]);
  }
});

test('direct calls log their defensive skips without a decision id', async () => {
  const open = recordingViewport();
  assert.equal(
    await open.viewport.sendPointerCrop(groundSnapshot(), {
      viewScale: 'global',
    }),
    false,
  );
  const closed = recordingViewport({ channel: { readyState: 'closed' } });
  assert.equal(
    await closed.viewport.sendPointerCrop(groundSnapshot(), {
      viewScale: 'city',
    }),
    false,
  );
  assert.equal(
    await closed.viewport.sendRetainedImage(
      async () => 'data:image/jpeg;base64,AA==',
      'text',
      'client.viewport_context',
    ),
    false,
  );
  assert.deepEqual(
    [...open.events, ...closed.events].map((item) => item.detail),
    [
      { contextId: null, kind: 'crop', reason: 'pointer-scale-not-useful' },
      { contextId: null, kind: 'crop', reason: 'channel-lost' },
      { contextId: null, kind: 'viewport', reason: 'channel-lost' },
    ],
  );
});

test('a throw after a real send still logs it as sent', async () => {
  let reads = 0;
  const { viewport, events } = recordingViewport({
    // The first read happens only after the image was handed to the channel.
    readCameraKey: () => {
      reads += 1;
      throw new Error('camera gone');
    },
  });
  await assert.rejects(
    viewport.sendVisualContextIfUseful(localContext()),
    /camera gone/,
  );
  assert.equal(reads, 1);
  const outcomes = events.filter((item) => outcomeEvents.has(item.event));
  assert.deepEqual(
    outcomes.map((item) => [item.event, item.detail.reason]),
    [['viewport_context.result', 'sent']],
  );
});

test('a second request for a snapshot still being captured is not sent twice', async () => {
  const releases = [];
  const snapshot = groundSnapshot();
  const { viewport, events } = recordingViewport({
    readPointer: () => snapshot,
    capturePointer: () => new Promise((resolve) => releases.push(resolve)),
  });
  const first = viewport.sendVisualContextIfUseful(pointerGround());
  const second = viewport.sendVisualContextIfUseful(pointerGround());
  await Promise.resolve();
  for (const release of releases)
    release({ dataUrl: 'data:image/jpeg;base64,AA==', rect: {} });
  assert.deepEqual([await first, await second], [true, false]);
  assert.equal(releases.length, 1);
  const outcomes = events.filter((item) => outcomeEvents.has(item.event));
  assert.deepEqual(
    outcomes.map((item) => [item.detail.contextId, item.detail.reason]),
    [
      [2, 'pointer-already-requested'],
      [1, 'sent'],
    ],
  );
});
