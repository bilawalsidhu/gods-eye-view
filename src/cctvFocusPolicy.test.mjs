import { readSource } from './testSupport/readSource.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeCctvEnableOwnership,
  runCctvLayerEnableFocus,
  runCctvLayerEnableTransition,
} from './cctvFocusPolicy.js';

test('CCTV layer enable activates nearest without stealing a tracked or cockpit view', () => {
  for (const ownership of [
    { trackedEntity: { id: 'tracked-plane' }, cockpitActive: false },
    { trackedEntity: null, cockpitActive: true },
  ]) {
    const calls = [];
    const result = runCctvLayerEnableFocus({
      ...ownership,
      activate: () => {
        calls.push(['nearest', { focus: false }]);
        return 'cam-near';
      },
      fly: (cameraId) => {
        calls.push(['fly', cameraId]);
        return 'focused';
      },
    });

    assert.equal(result, 'cam-near');
    assert.deepEqual(calls, [['nearest', { focus: false }]]);
  }

  const calls = [];
  const result = runCctvLayerEnableFocus({
    activate: () => {
      calls.push(['nearest', { focus: false }]);
      return 'cam-near';
    },
    fly: (cameraId) => {
      calls.push(['fly', cameraId]);
      return 'focused';
    },
  });

  assert.equal(result, 'focused');
  assert.deepEqual(calls, [
    ['nearest', { focus: false }],
    ['fly', 'cam-near'],
  ]);
});

test('CCTV enable retains a pre-await tracking snapshot when tracking clears during enable', async () => {
  let trackedEntity = { id: 'tracked-plane' };
  let flyCalls = 0;
  const diagnostics = [];
  const result = await runCctvLayerEnableTransition({
    target: true,
    readOwnership: () => ({ trackedEntity, cockpitActive: false }),
    setEnabled: async () => {
      await Promise.resolve();
      trackedEntity = null;
    },
    shouldFocus: () => true,
    activate: () => 'cam-near',
    fly: () => {
      flyCalls += 1;
      return 'focused';
    },
    debug: (...args) => diagnostics.push(args),
  });

  assert.equal(result, 'cam-near');
  assert.equal(flyCalls, 0, 'a pre-await owner must suppress the post-await focus flight');
  assert.deepEqual(diagnostics.map(([, identity]) => identity.trackedId), ['tracked-plane', null]);
  assert.match(diagnostics[0][0], /before setEnabled await/);
  assert.match(diagnostics[1][0], /after setEnabled await/);

  // Batch 5 seam 3: the CCTV panel methods live in src/ui/cctvPanel.js;
  // StyleManager keeps thin delegates.
  const cctvPanelSource = readSource('./ui/cctvPanel.js', import.meta.url);
  assert.match(cctvPanelSource, /await runCctvLayerEnableTransition\(\{/);
});

test('CCTV disable transition does not emit enable-ownership diagnostics', async () => {
  const diagnostics = [];
  const transitions = [];

  const result = await runCctvLayerEnableTransition({
    target: false,
    readOwnership: () => ({ trackedEntity: { id: 'tracked-plane' }, cockpitActive: false }),
    setEnabled: async (target) => transitions.push(target),
    shouldFocus: () => true,
    activate: () => 'cam-near',
    fly: () => 'focused',
    debug: (...args) => diagnostics.push(args),
  });

  assert.equal(result, null);
  assert.deepEqual(transitions, [false]);
  assert.deepEqual(diagnostics, []);
});

// --- Branch floor (cycle 4): the quiet exits are contracts too --------------

test('a failed nearest-camera activation aborts the focus without a flight', () => {
  assert.equal(runCctvLayerEnableFocus({
    activate: () => null,
    fly: () => { throw new Error('fly must not run'); },
  }), false, 'no camera → false, and the caller skips its flight');
  assert.equal(runCctvLayerEnableFocus({}), false, 'no activate at all → false');
});

test('an absent fly on a free camera resolves undefined — activation only', () => {
  const calls = [];
  const result = runCctvLayerEnableFocus({
    activate: () => { calls.push('activate'); return 'cam-near'; },
  });
  assert.equal(result, undefined, 'no fly supplied → fire-and-forget activation');
  assert.deepEqual(calls, ['activate'], 'activate ran, no fly to follow');
});

test('ownership merge is conservative on both axes', () => {
  assert.deepEqual(mergeCctvEnableOwnership(), {
    trackedEntity: null, cockpitActive: false,
  }, 'no observations at all → nothing owned');
  assert.deepEqual(
    mergeCctvEnableOwnership({ trackedEntity: { id: 'a' }, cockpitActive: false }, { trackedEntity: { id: 'b' }, cockpitActive: false }),
    { trackedEntity: { id: 'a' }, cockpitActive: false },
    'the before-snapshot wins when both sides tracked',
  );
  assert.deepEqual(
    mergeCctvEnableOwnership({ trackedEntity: null, cockpitActive: false }, { trackedEntity: { id: 'b' }, cockpitActive: true }),
    { trackedEntity: { id: 'b' }, cockpitActive: true },
    'an after-snapshot owner still suppresses',
  );
  assert.equal(
    mergeCctvEnableOwnership({ cockpitActive: 1 }, { cockpitActive: 'yes' }).cockpitActive,
    true, 'truthy observations coerce to a boolean flag',
  );
});

test('the transition tolerates missing sinks and a withheld focus request', async () => {
  // No readOwnership, no setEnabled, focus withheld: resolves null quietly.
  assert.equal(await runCctvLayerEnableTransition({
    target: true, shouldFocus: () => false, activate: () => 'cam-near',
  }), null, 'shouldFocus false → null with every sink optional');
  // target false with sinks missing entirely.
  assert.equal(await runCctvLayerEnableTransition({ target: false, shouldFocus: () => true }), null);
});

test('a non-true truthy target skips diagnostics but still focuses', async () => {
  const diagnostics = [];
  const result = await runCctvLayerEnableTransition({
    target: 1,
    readOwnership: () => ({}),
    setEnabled: async () => {},
    shouldFocus: () => true,
    activate: () => 'cam-near',
    fly: (id) => `flew-${id}`,
    debug: (...args) => diagnostics.push(args),
  });
  assert.equal(result, 'flew-cam-near', 'the focus policy runs for any truthy target');
  assert.deepEqual(diagnostics, [], 'the enable diagnostics gate on target === true');
});
