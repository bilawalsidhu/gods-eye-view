// src/layers/cctv/rendering.test.mjs
// Icon colors under focus de-emphasis (#1200): the focus pass fades each icon
// from the same base color the coverage refresh assigns, so a video-feed camera
// stays violet while it dims instead of falling back to the idle cyan.
// Teardown takes the icons out of the scene that holds them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRendering } from './rendering.js';
import {
  ACTIVE_CAMERA_COLOR,
  IDLE_CAMERA_COLOR,
  LIVE_CAMERA_COLOR,
} from './policy.js';
import { isVideoFeedType } from '../../sources/cctvTypes.js';
import * as Cesium from 'cesium';
import { createIconSet } from '../../data/iconSet.js';

const FOCUS_FACTOR = 0.5;

function assertKeepsColor(icons, id, base, label) {
  const row = icons.row(id);
  const actual = icons.color(row);
  assert.deepEqual(
    [actual.red, actual.green, actual.blue, actual.alpha].map(
      Cesium.Color.floatToByte,
    ),
    [base.red, base.green, base.blue, base.alpha].map(Cesium.Color.floatToByte),
    `${label}: base color kept`,
  );
  assert.equal(icons.focus(row), FOCUS_FACTOR, `${label}: focus`);
}

test('focus de-emphasis fades each icon from its own color', () => {
  const record = (id, feedType) => ({
    camera: { id, feedType },
    // No position, so the pass skips screen projection; the focus stub below
    // decides the factor on its own.
  });
  const idleVideo = record('idle-hls', 'hls');
  const idleStill = record('idle-image', 'image');
  const activeVideo = record('active-hls', 'hls');
  const state = {
    _enabled: true,
    _viewer: { scene: {}, camera: {} },
    _records: [idleVideo, idleStill, activeVideo],
    _activeCameraId: activeVideo.camera.id,
    _activeFocusStyleCount: 0,
    _lastFocusStyleAt: -Infinity,
    _icons: createIconSet(),
  };
  const focus = {
    focusNowMs: (nowMs) => nowMs,
    getFocusTarget: () => ({}),
    focusPassIsNeeded: () => true,
    advanceSpriteFocus: () => ({
      factor: FOCUS_FACTOR,
      active: true,
      transitioning: false,
    }),
    focusAlphaNeedsWrite: () => true,
  };
  const { addCameraIcon, refreshCctvFocusStyles } = createRendering({
    state,
    services: { focus },
    parts: { model: { isVideoFeedType } },
    source: {},
  });
  for (const r of state._records) addCameraIcon(r);

  refreshCctvFocusStyles(1000);

  const icons = state._icons;
  assertKeepsColor(icons, 'idle-hls', LIVE_CAMERA_COLOR, 'idle video');
  assertKeepsColor(icons, 'idle-image', IDLE_CAMERA_COLOR, 'idle still');
  assertKeepsColor(icons, 'active-hls', ACTIVE_CAMERA_COLOR, 'active video');
  assert.equal(state._activeFocusStyleCount, 3);
});

test('icons leave the scene they were added to, whichever viewer tears down', () => {
  const viewer = () => {
    const held = new Set();
    return {
      held,
      scene: {
        requestRender() {},
        primitives: {
          add: (p) => held.add(p),
          remove: (p) => held.delete(p),
        },
      },
    };
  };
  const first = viewer();
  const second = viewer();
  const state = { _viewer: first };
  const { createCameraIcons, destroyCameraIcons } = createRendering({
    state,
    services: { focus: {} },
    parts: {},
    source: {},
  });

  const old = createCameraIcons(first);
  state._viewer = second;
  const current = createCameraIcons(second);
  assert.equal(first.held.has(old), false, 'a re-init takes out the old icons');
  assert.equal(old.isDestroyed(), true);

  destroyCameraIcons();
  assert.equal(second.held.has(current), false);
  assert.equal(current.isDestroyed(), true);
  assert.equal(state._icons, null);
});
