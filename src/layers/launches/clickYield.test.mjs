import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycle } from './lifecycle.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import * as picking from '../../data/pickRegistry.js';

/** Any part method is a no-op unless the test supplies it. */
const stubs = (given = {}) =>
  new Proxy(given, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });

// Mission overlays are not interactive: an overlay entry under the pointer is
// another layer's card or label painted over the mission (a quake label), and
// that layer takes the click, so the mission is not also selected.
test('a card painted over a launch marker keeps its click; with none the mission selects', () => {
  const viewer = {
    scene: {
      pick: () => null,
      canvas: { clientWidth: 100, clientHeight: 100 },
    },
  };
  const input = fakeInput(viewer);
  let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  const selected = [];
  const state = { _launches: [{ id: 'L1' }], _enabled: false };
  const { methods: lifecycle } = createLifecycle({
    state,
    services: {
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
      // The card on top at a click, as the registry answers from the host.
      picking: { ...picking, clickCard: () => top },
    },
    parts: {
      panel: stubs(),
      overlays: stubs(),
      launchPad: stubs(),
      orbitRendering: stubs(),
      replay: stubs(),
      ingestion: stubs(),
      rendering: stubs({
        missionsShown: () => true,
        missionHitsAt: () => [{ id: 'mission:L1' }],
        launchIdFromPicks: (hits) =>
          hits.some((hit) => hit?.id === 'mission:L1') ? 'L1' : null,
      }),
      selection: stubs({ setSelectedMission: (id) => selected.push(id) }),
    },
    source: {},
  });
  try {
    // init installs the click handler; enable would start a feed load.
    lifecycle.init(viewer);
    state._enabled = true;
    input.click();
    assert.deepEqual(selected, [], 'the mission stands aside');
    top = null;
    input.click();
    assert.deepEqual(
      selected,
      ['L1'],
      'with no card on top, the mission selects',
    );
  } finally {
    state._inputSubscription?.();
    input.destroy();
  }
});
