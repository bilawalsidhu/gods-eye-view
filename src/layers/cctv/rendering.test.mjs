// src/layers/cctv/rendering.test.mjs
// Icon colors under focus de-emphasis (#1200): the focus pass fades each icon
// from the same base color the coverage refresh assigns, so a video-feed camera
// stays violet while it dims instead of falling back to the idle cyan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRendering } from './rendering.js';
import {
  ACTIVE_CAMERA_COLOR,
  IDLE_CAMERA_COLOR,
  LIVE_CAMERA_COLOR,
} from './policy.js';
import { isVideoFeedType } from '../../sources/cctvTypes.js';

const FOCUS_FACTOR = 0.5;

function assertFadedFrom(actual, base, label) {
  assert.ok(actual, `${label}: color written`);
  assert.deepEqual(
    [actual.red, actual.green, actual.blue],
    [base.red, base.green, base.blue],
    `${label}: hue`,
  );
  assert.equal(actual.alpha, base.alpha * FOCUS_FACTOR, `${label}: alpha`);
}

test('focus de-emphasis fades each icon from its own color', () => {
  const record = (id, feedType) => ({
    camera: { id, feedType },
    // No position, so the pass skips screen projection; the focus stub below
    // decides the factor on its own.
    billboard: { show: true },
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
  const { refreshCctvFocusStyles } = createRendering({
    state,
    services: { focus },
    parts: { model: { isVideoFeedType } },
    source: {},
  });

  refreshCctvFocusStyles(1000);

  assertFadedFrom(idleVideo.billboard.color, LIVE_CAMERA_COLOR, 'idle video');
  assertFadedFrom(idleStill.billboard.color, IDLE_CAMERA_COLOR, 'idle still');
  assertFadedFrom(
    activeVideo.billboard.color,
    ACTIVE_CAMERA_COLOR,
    'active video',
  );
  assert.equal(state._activeFocusStyleCount, 3);
});

test('focus release restores video hue and alpha after the style throttle', () => {
  let target = {};
  const records = ['mp4', 'webm'].map((feedType) => ({
    camera: { id: feedType, feedType },
    billboard: { show: true, color: LIVE_CAMERA_COLOR },
  }));
  const state = {
    _enabled: true,
    _viewer: { scene: {}, camera: {} },
    _records: records,
    _activeCameraId: null,
    _activeFocusStyleCount: 0,
    _lastFocusStyleAt: -Infinity,
  };
  const focus = {
    focusNowMs: (nowMs) => nowMs,
    getFocusTarget: () => target,
    focusPassIsNeeded: (value, count) => !!value || count > 0,
    advanceSpriteFocus: () => ({
      factor: target ? FOCUS_FACTOR : 1,
      active: !!target,
      transitioning: false,
    }),
    focusAlphaNeedsWrite: (before, after) => before !== after,
  };
  const { refreshCctvFocusStyles } = createRendering({
    state,
    services: { focus },
    parts: { model: { isVideoFeedType } },
    source: {},
  });

  refreshCctvFocusStyles(1000);
  for (const record of records) {
    assertFadedFrom(
      record.billboard.color,
      LIVE_CAMERA_COLOR,
      record.camera.id,
    );
  }
  const dimmed = records.map((record) => record.billboard.color);
  target = null;
  refreshCctvFocusStyles(1050);
  for (let i = 0; i < records.length; i += 1) {
    assert.equal(records[i].billboard.color, dimmed[i]);
  }
  refreshCctvFocusStyles(1100);
  for (const record of records) {
    assert.deepEqual(record.billboard.color, LIVE_CAMERA_COLOR);
  }
  assert.equal(state._activeFocusStyleCount, 0);
});
