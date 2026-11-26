// src/layers/cctv/rendering.test.mjs
// Icon colors under focus de-emphasis (#1200): the focus pass fades each icon
// from the same base color the coverage refresh assigns, so a video-feed camera
// stays violet while it dims instead of falling back to the idle green.
// Teardown lets go of the icon set of the viewer that drew it.
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
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { bindRenderer } from '../../render/rendererOf.js';

const FOCUS_FACTOR = 0.5;

function assertKeepsColor(icons, id, base, label) {
  assert.deepEqual(icons.item(id).color, base, `${label}: base color kept`);
  assert.equal(icons.focus(id), FOCUS_FACTOR, `${label}: focus`);
}

test('focus de-emphasis fades each icon from its own color', () => {
  const record = (id, feedType) => ({
    camera: { id, feedType },
    position: { x: 6378137, y: 0, z: 0 },
  });
  const idleVideo = record('idle-hls', 'hls');
  const idleStill = record('idle-image', 'image');
  const activeVideo = record('active-hls', 'hls');
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { position: { x: 6378137 + 1000, y: 0, z: 0 } },
  });
  const projected = [];
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: {
      project: (position) => {
        projected.push(position);
        return { x: 10, y: 20 };
      },
    },
  });
  const state = {
    _enabled: true,
    _viewer: viewer,
    _records: [idleVideo, idleStill, activeVideo],
    _activeCameraId: activeVideo.camera.id,
    _activeFocusStyleCount: 0,
    _lastFocusStyleAt: -Infinity,
  };
  const distances = [];
  const focus = {
    focusNowMs: (nowMs) => nowMs,
    getFocusTarget: () => ({}),
    focusPassIsNeeded: () => true,
    advanceSpriteFocus: (meta, input) => {
      distances.push(input.cameraDistance);
      return { factor: FOCUS_FACTOR, active: true, transitioning: false };
    },
    focusAlphaNeedsWrite: () => true,
  };
  const { createCameraIcons, addCameraIcon, refreshCctvFocusStyles } =
    createRendering({
      state,
      services: { focus },
      parts: {
        model: {
          isVideoFeedType,
          isVideoFeedCamera: (camera) =>
            isVideoFeedType(camera.feedType) || Boolean(camera.browserMediaUrl),
        },
      },
      source: {},
    });
  try {
    const setId = createCameraIcons(viewer);
    for (const r of state._records) addCameraIcon(r);

    refreshCctvFocusStyles(1000);

    const icons = state._icons;
    assertKeepsColor(icons, 'idle-hls', LIVE_CAMERA_COLOR, 'idle video');
    assertKeepsColor(icons, 'idle-image', IDLE_CAMERA_COLOR, 'idle still');
    assertKeepsColor(icons, 'active-hls', ACTIVE_CAMERA_COLOR, 'active video');
    assert.equal(state._activeFocusStyleCount, 3);
    assert.equal(projected.length, 3, 'each shown icon is projected');
    assert.deepEqual(distances, [1000, 1000, 1000], 'from the eye');
    // What the set draws: depth-test-free, held at the mount, shrinking
    // with distance as before.
    const drawn = draw.set(setId).items.get('idle-hls');
    assert.equal(drawn.disableDepthTest, Infinity);
    assert.deepEqual(drawn.motion, { kind: 'hold' });
    assert.deepEqual(drawn.pos, idleVideo.position);
    assert.deepEqual(drawn.size, [24, 24]);
    assert.deepEqual(drawn.scaleByDistance, {
      near: 350,
      nearValue: 1.25,
      far: 4_000_000,
      farValue: 0.42,
    });
    assert.equal(drawn.focus, FOCUS_FACTOR);
    assert.equal(draw.set(setId).spec.horizonCull, true);
    // Hidden until enable() has culled and thinned the cameras: the layer
    // waits on its health check between drawing them and that pass.
    assert.equal(draw.set(setId).show, false);
  } finally {
    unbind();
  }
});

test('focus uses the painted half-width and half-height of each count', () => {
  const markers = [
    { width: 40, height: 40 },
    { width: 72, height: 58 },
  ];
  const sizes = [];
  const rendering = createRendering({
    state: { _counts: { markers } },
    services: {
      focus: {
        focusPassIsNeeded: () => true,
        advanceSpriteFocus(_owner, { spriteHalfWidthPx, spriteHalfHeightPx }) {
          sizes.push([spriteHalfWidthPx, spriteHalfHeightPx]);
          return { factor: 1 };
        },
        focusAlphaNeedsWrite: () => false,
      },
    },
  });
  rendering.applyCctvFocusDeemphasis({});
  assert.deepEqual(sizes, [
    [20, 20],
    [36, 29],
  ]);
});

test('the icons go with the viewer that drew them, whichever tears down', () => {
  const first = {};
  const second = {};
  const one = bindFakeDraw(first);
  const two = bindFakeDraw(second);
  const state = { _viewer: first };
  const lanes = [];
  const overlays = {
    registerWorldOverlayPaintLane(name, paint, options) {
      const lane = {
        name,
        paint,
        options,
        setActive() {},
        unregister() {
          this.disposed = true;
        },
      };
      lanes.push(lane);
      return lane;
    },
  };
  const { createCameraIcons, destroyCameraIcons } = createRendering({
    state,
    services: { focus: {}, overlays },
    parts: {},
    source: {},
  });
  try {
    const old = createCameraIcons(first);
    assert.equal(one.draw.sets.size, 1);
    assert.equal(lanes[0].name, 'ambient-label');
    assert.equal(lanes[0].options.target, 'shared');
    assert.equal(lanes[0].options.active, false);
    state._viewer = second;
    const current = createCameraIcons(second);
    assert.notEqual(old, current);
    assert.equal(one.draw.sets.get(old).disposed, true, 'a re-init lets go');
    assert.equal(two.draw.sets.get(current).disposed, false);
    assert.equal(lanes[0].disposed, true);
    lanes[0].paint({});

    destroyCameraIcons();
    assert.equal(two.draw.sets.get(current).disposed, true);
    assert.equal(state._icons, null);
    assert.equal(lanes[1].disposed, true);
    lanes[1].paint({});
    assert.equal(state._counts, null);
  } finally {
    one.unbind();
    two.unbind();
  }
});

test('the obstruction probe casts one ray through the query port', async () => {
  const calls = [];
  const viewer = {};
  const unbind = bindRenderer(viewer, {
    query: {
      rayCast: async (ray, options) => {
        calls.push({ ray, options });
        return { x: 1, y: 2, z: 3 };
      },
    },
  });
  const state = { _viewer: viewer };
  const rendering = createRendering({
    state,
    services: { focus: {} },
    parts: {},
  });
  try {
    assert.equal(rendering.canPickFromRay(), true);
    const origin = { x: 0, y: 0, z: 0 };
    const direction = { x: 1, y: 0, z: 0 };
    assert.deepEqual(await rendering.obstructionHit(origin, direction), {
      x: 1,
      y: 2,
      z: 3,
    });
    // The layer's own sets are not ground: the cast sees through them
    // without naming them.
    assert.deepEqual(calls, [
      { ray: { origin, direction }, options: { against: 'surface' } },
    ]);
  } finally {
    unbind();
  }
  state._viewer = {};
  assert.equal(rendering.canPickFromRay(), false);
  assert.equal(
    await rendering.obstructionHit({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    null,
  );
});

test('cards go only where the horizon lets the camera see', () => {
  const eye = Cesium.Cartesian3.fromDegrees(0, 0, 20_000_000);
  const front = Cesium.Cartesian3.fromDegrees(0, 0);
  const back = Cesium.Cartesian3.fromDegrees(180, 0);
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { position: { x: eye.x, y: eye.y, z: eye.z } },
  });
  const unbind = bindRenderer(viewer, {
    camera: camera.port,
    canvas: { clientWidth: 800, clientHeight: 0, height: 600 },
    query: { project: () => ({ x: 10, y: 20 }) },
  });
  try {
    const view = createRendering({
      state: { _viewer: viewer },
      services: { focus: {} },
      parts: {},
    }).cardView();
    assert.equal(view.width, 800);
    assert.equal(view.height, 600);
    assert.deepEqual(view.screenOf(front), { x: 10, y: 20 });
    assert.equal(view.screenOf(back), null);
  } finally {
    unbind();
  }
});

test('the projection tiles are ready only when drawn and settled', () => {
  const viewer = {};
  let globeVisible = true;
  let settled = true;
  const unbind = bindRenderer(viewer, {
    globe: {
      isGlobeVisible: () => globeVisible,
      isSettled: (kind) => kind === 'tiles' && settled,
    },
  });
  try {
    const { projectionTilesReady } = createRendering({
      state: { _viewer: viewer },
      services: { focus: {} },
      parts: {},
    });
    assert.equal(projectionTilesReady(), false, 'a globe stack hides them');
    globeVisible = false;
    assert.equal(projectionTilesReady(), true);
    settled = false;
    assert.equal(projectionTilesReady(), false, 'still streaming');
  } finally {
    unbind();
  }
  const bare = createRendering({
    state: { _viewer: {} },
    services: { focus: {} },
    parts: {},
  });
  assert.equal(bare.projectionTilesReady(), false, 'no globe, no tiles');
});

test('a view pass writes only the icons it changes, in one write', () => {
  const viewer = {};
  const eye = Cesium.Cartesian3.fromDegrees(0, 0, 2000);
  const down = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const camera = fakeCameraPort({
    pose: {
      position: { x: eye.x, y: eye.y, z: eye.z },
      direction: { x: down.x, y: down.y, z: down.z },
      up: { x: 0, y: 0, z: 1 },
      fovy: Math.PI / 3,
      aspectRatio: 4 / 3,
      near: 0.1,
      far: 5e8,
    },
  });
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera: camera.port,
    canvas: { clientWidth: 800, clientHeight: 600 },
  });
  const record = (id, lon) => {
    const p = Cesium.Cartesian3.fromDegrees(lon, 0, 10);
    return {
      camera: { id, lat: 0, lon },
      position: { x: p.x, y: p.y, z: p.z },
    };
  };
  // One in view, one far off it.
  const near = record('near', 0);
  const far = record('far', 1);
  const state = {
    _enabled: true,
    _viewer: viewer,
    _records: [near, far],
    _viewRecords: [],
    _healthById: new Map(),
    _scratchViewScreen: { x: 0, y: 0 },
  };
  const rendering = createRendering({
    state,
    services: { focus: {} },
    parts: {
      model: { isVideoFeedType: () => false, isVideoFeedCamera: () => false },
      drawSets: { roleOfSet: () => null },
    },
    source: {},
  });
  try {
    const setId = rendering.createCameraIcons(viewer);
    for (const r of state._records) rendering.addCameraIcon(r);
    const set = draw.set(setId);
    const writes = set.writes;

    assert.equal(rendering.refreshHorizonCulling(), true);
    assert.equal(set.writes, writes + 1, 'one write for the pass');
    assert.equal(set.items.get('near').show, true);
    assert.equal(set.items.get('far').show, false);

    assert.equal(rendering.refreshHorizonCulling(), false);
    assert.equal(set.writes, writes + 1, 'an unchanged view writes nothing');

    // Another layer on the same viewer draws its icons in a set of its own.
    const other = createRendering({
      state: { _viewer: viewer },
      services: { focus: {} },
      parts: {},
      source: {},
    });
    const otherId = other.createCameraIcons(viewer);
    assert.notEqual(otherId, setId);
    assert.equal(
      rendering.extractPickedCameraId({ set: otherId, id: 'near' }),
      null,
      "the other layer's icon is not this layer's camera",
    );
  } finally {
    unbind();
  }
});

test('a pose with no perspective field of view is projected by the renderer', () => {
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { position: { x: 7e6, y: 0, z: 0 }, fovy: undefined },
  });
  const asked = [];
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera: camera.port,
    canvas: { clientWidth: 800, clientHeight: 600 },
    query: {
      project: (position) => {
        asked.push(position.y);
        return position.y === 0 ? { x: 400, y: 300 } : null;
      },
    },
  });
  // On the ground under the eye, in cells of their own.
  const record = (id, y) => ({
    camera: { id, lat: 0, lon: y / 1000 },
    position: { x: 6378137, y, z: 0 },
  });
  const state = {
    _enabled: true,
    _viewer: viewer,
    _records: [record('on', 0), record('off', 1000)],
    _viewRecords: [],
    _healthById: new Map(),
    _scratchViewScreen: { x: 0, y: 0 },
  };
  const rendering = createRendering({
    state,
    services: { focus: {} },
    parts: {
      model: { isVideoFeedType: () => false, isVideoFeedCamera: () => false },
    },
    source: {},
  });
  try {
    const setId = rendering.createCameraIcons(viewer);
    for (const r of state._records) rendering.addCameraIcon(r);
    rendering.refreshHorizonCulling();
    const set = draw.set(setId);
    assert.deepEqual(asked.sort(), [0, 1000]);
    assert.equal(set.items.get('on').show, true);
    assert.equal(set.items.get('off').show, false);
  } finally {
    unbind();
  }
});

test('focus release restores video hue and alpha after the style throttle', () => {
  const viewer = {};
  const camera = fakeCameraPort({
    pose: { position: { x: 6378137 + 1000, y: 0, z: 0 } },
  });
  const { unbind } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: { project: () => ({ x: 10, y: 20 }) },
  });
  let target = {};
  const records = ['mp4', 'webm'].map((feedType) => ({
    camera: { id: feedType, feedType },
    position: { x: 6378137, y: 0, z: 0 },
  }));
  const state = {
    _enabled: true,
    _viewer: viewer,
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
  const { createCameraIcons, addCameraIcon, refreshCctvFocusStyles } =
    createRendering({
      state,
      services: { focus },
      parts: {
        model: {
          isVideoFeedCamera: (camera) => isVideoFeedType(camera.feedType),
        },
      },
      source: {},
    });
  try {
    createCameraIcons(viewer);
    for (const record of records) addCameraIcon(record);
    const icons = state._icons;

    refreshCctvFocusStyles(1000);
    for (const record of records) {
      assertKeepsColor(
        icons,
        record.camera.id,
        LIVE_CAMERA_COLOR,
        record.camera.id,
      );
    }
    target = null;
    refreshCctvFocusStyles(1050);
    for (const record of records) {
      assert.equal(icons.focus(record.camera.id), FOCUS_FACTOR, 'throttled');
    }
    refreshCctvFocusStyles(1100);
    for (const record of records) {
      assert.deepEqual(icons.item(record.camera.id).color, LIVE_CAMERA_COLOR);
      assert.equal(icons.focus(record.camera.id), 1);
    }
    assert.equal(state._activeFocusStyleCount, 0);
  } finally {
    unbind();
  }
});

test('hover picks the underlying camera only outside a painted count', () => {
  const viewer = {};
  const icon = { set: 'icons', id: 'camera' };
  let picks = 0;
  const unbind = bindRenderer(viewer, {
    query: {
      pick() {
        picks++;
        return icon;
      },
    },
  });
  try {
    const state = {
      _viewer: viewer,
      _counts: { pickedCell: ({ x }) => (x <= 17 ? {} : null) },
      _icons: { setId: icon.set, has: () => true },
      _recordById: new Map([[icon.id, {}]]),
    };
    const rendering = createRendering({
      state,
      services: { focus: {} },
      parts: {},
    });
    assert.equal(rendering.pickCameraIdAt({ x: 17, y: 0 }), null);
    assert.equal(picks, 0);
    assert.equal(rendering.pickCameraIdAt({ x: 18, y: 0 }), icon.id);
  } finally {
    unbind();
  }
});
