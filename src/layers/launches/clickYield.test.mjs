import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycle } from './lifecycle.js';
import { createOverlays } from './overlays.js';
import {
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
} from './policy.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import * as picking from '../../data/pickRegistry.js';

/** Any part method is a no-op unless the test supplies it. */
const stubs = (given = {}) =>
  new Proxy(given, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });

// A mission label on top takes its click through the overlay handler first;
// here an overlay entry under the pointer is another layer's card or label
// painted over the mission (a quake label), and that layer takes the click,
// so the mission is not also selected.
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

// A mission label is an interactive world-overlay entry, so the host's hit
// test names it and every other layer reads it as the card on top: a click
// on it never acts on what lies under it.
test('a mission label is the card on top for every other layer', (t) => {
  const overlays = createOverlays({
    state: {},
    services: {},
    parts: {},
    source: {},
  });
  const launch = {
    id: 'L1',
    name: 'Starlink Group 1',
    launchTime: '2026-11-01T00:00:00Z',
  };
  for (const selected of [false, true]) {
    const entry = overlays.createRocketMissionMarkerOverlayEntry(
      launch,
      { x: 1, y: 2, z: 3 },
      selected,
    );
    assert.equal(entry.interactive, true, `selected: ${selected}`);
  }
  for (const sourceId of [
    ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
    ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
  ]) {
    picking.setClickCardHitTest(() => ({ sourceId, entryId: 'launch:L1' }));
    t.after(() => picking.setClickCardHitTest(null));
    const click = { screenPosition: { x: 10, y: 10 } };
    assert.equal(picking.isUnderOtherCard(click, ['vessels']), true);
    assert.equal(picking.isUnderOtherCard(click, [sourceId]), false);
  }
});
