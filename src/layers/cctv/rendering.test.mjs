// src/layers/cctv/rendering.test.mjs
// Icon colors under focus de-emphasis (#1200): the focus pass fades each icon
// from the same base color the coverage refresh assigns, so a video-feed camera
// stays violet while it dims instead of falling back to the idle cyan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRendering } from './rendering.js';
import { createGeometry } from './geometry.js';
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
    parts: {
      renderer: { ready: true },
      model: {
        isVideoFeedCamera: (camera) =>
          isVideoFeedType(camera.feedType) || Boolean(camera.browserMediaUrl),
      },
    },
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

test('coverage refresh releases departed geometry and preserves media for reselection', () => {
  const records = ['opening', 'final', 'neighbor'].map((id) => ({
    camera: { id, headingConfidence: 'high' },
    frustumGeometry: {},
    frustumPositions: {},
    coverageEntities: [],
  }));
  const state = {
    _enabled: true,
    _coverageMode: 'on',
    _showProjection: true,
    _records: records,
    _coverageEntities: [],
  };
  let active = records[0];
  let visible = new Set(['opening']);
  const lines = new Set();
  const planes = new Set();
  const services = { ground: {}, focus: {} };
  const parts = {
    renderer: {
      ready: true,
      createCoverage(id) {
        const line = { id, show: false };
        lines.add(line);
        return [line];
      },
      removeCoverageEntity: (line) => lines.delete(line),
      styleLine: (line, { visible }) => {
        line.show = visible;
      },
      removePlane: (runtime) => planes.delete(runtime.planeEntity),
      setMarkersVisible() {},
    },
    selection: { getActiveRecord: () => active },
    model: { isBrowserOverlayCamera: () => false },
    projection: {
      ensureProjectionRuntime(record) {
        record.projection ??= { canvas: {} };
        const runtime = record.projection;
        if (!runtime.planeEntity) {
          runtime.planeEntity = {};
          runtime.needsPlane = false;
          planes.add(runtime.planeEntity);
        }
      },
      setPlaneVisible: (runtime, value) => {
        runtime.planeVisible = value;
      },
      pauseInactiveProjectionFeeds() {},
    },
  };
  parts.geometry = createGeometry({ state, services, parts });
  parts.geometry.buildCoverageVisibleSet = () => visible;
  const rendering = createRendering({ state, services, parts });
  rendering.refreshCoverageStyles();
  const openingLine = records[0].coverageEntities[0];
  const media = records[0].projection.canvas;
  assert.equal(
    openingLine.show,
    true,
    'startup without a restore draws immediately',
  );
  active = records[1];
  visible = new Set(['final', 'neighbor']);
  rendering.refreshCoverageStyles();
  assert.equal(lines.has(openingLine), false);
  assert.deepEqual(records[0].coverageEntities, []);
  assert.equal(records[0].projection.planeEntity, null);
  assert.equal(records[0].projection.needsPlane, true);
  assert.equal(records[0].projection.canvas, media);
  assert.deepEqual(
    [...lines].map((line) => line.id),
    ['final', 'neighbor'],
  );
  assert.ok([...lines].every((line) => line.show));
  assert.deepEqual(state._coverageEntities, [...lines]);
  assert.equal(planes.size, 1);
  const finalLine = records[1].coverageEntities[0];
  rendering.refreshCoverageStyles();
  assert.equal(
    records[1].coverageEntities[0],
    finalLine,
    'stationary geometry is reused',
  );
  active = records[0];
  visible = new Set();
  rendering.refreshCoverageStyles();
  assert.equal(
    lines.size,
    1,
    'active projection keeps its coverage outside the visible cohort',
  );
  assert.equal(records[0].coverageEntities[0].show, true);
  assert.notEqual(records[0].coverageEntities[0], openingLine);
  assert.equal(records[0].projection.canvas, media);
  assert.equal(planes.size, 1);
});
