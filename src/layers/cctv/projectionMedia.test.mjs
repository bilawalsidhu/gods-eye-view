import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjection } from './projection.js';

function setup(
  t,
  { sourceFails = false, planeFails = false, feedType = 'mp4' } = {},
) {
  const previous = { document: globalThis.document, Image: globalThis.Image };
  const videos = [];
  const writes = [];
  let removed = 0;
  let refreshed = 0;
  class Video extends EventTarget {
    constructor() {
      super();
      this.listeners = new Map();
      this.videoWidth = 320;
      this.videoHeight = 180;
      this.paused = true;
      this.url = '';
      videos.push(this);
    }
    addEventListener(type, callback) {
      super.addEventListener(type, callback);
      this.listeners.set(type, callback);
    }
    removeEventListener(type, callback) {
      super.removeEventListener(type, callback);
      if (this.listeners.get(type) === callback) this.listeners.delete(type);
    }
    set src(value) {
      this.url = value;
      if (sourceFails) this.dispatchEvent(new Event('error'));
    }
    removeAttribute(name) {
      if (name === 'src') this.url = '';
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    load() {}
  }
  globalThis.document = {
    createElement: (tag) =>
      tag === 'video' ? new Video() : { getContext: () => ({}) },
  };
  globalThis.Image = class {};
  const state = {
    _records: [],
    _projectionEntities: [],
    _projectionOverlayOwnerId: null,
    _cctvOverlayHost: { clearSource() {}, setVisible() {} },
  };
  const renderer = {
    ready: true,
    createPlaneMaterial: (image) => ({ image }),
    setPlaneImage(runtime, image) {
      assert.ok(
        runtime.planeMaterial,
        'material must exist before playback failure',
      );
      runtime.planeMaterial.image = image;
      writes.push(image);
    },
    createPlane() {
      if (planeFails) throw new Error('plane construction failed');
      return { show: false };
    },
    removePlane() {
      removed++;
    },
  };
  const record = {
    camera: { id: 'camera', feedType },
    frustumGeometry: { halfW: 16, halfH: 9 },
    frustumPositions: {
      capCenter: { x: 1, y: 2, z: 3 },
      label: { x: 4, y: 5, z: 6 },
    },
  };
  const projection = createProjection({
    state,
    services: { render: {} },
    parts: {
      renderer,
      model: {
        isBrowserOverlayCamera: () => false,
        normalizeFeedType: (value) => value,
        isVideoFeedType: (value) => value === 'mp4',
        planeOrientationFor: () => ({}),
      },
      frames: {
        paintProjectionPlaceholder() {},
        mediaUrlFor: () => '/fixture.mp4',
        refreshProjectionImage() {
          refreshed++;
        },
      },
      presentation: { notifyListeners() {} },
    },
  });
  t.after(() => {
    projection.destroyProjectionRuntime(record.projection);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return {
    projection,
    record,
    videos,
    writes,
    removed: () => removed,
    refreshed: () => refreshed,
  };
}

test('video disposal removes texture and playback listeners and ignores retired metadata', (t) => {
  const h = setup(t);
  const runtime = h.projection.ensureProjectionRuntime(h.record);
  const video = h.videos[0];
  const retired = video.listeners.get('loadedmetadata');
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.deepEqual(h.writes, [runtime.canvas, video]);
  h.projection.destroyProjectionRuntime(runtime);
  assert.equal(video.listeners.size, 0);
  assert.equal(video.url, '');
  assert.equal(video.paused, true);
  retired();
  assert.equal(h.writes.length, 2);
  assert.equal(h.removed(), 1);
});

test('video failure releases its texture bindings while the image fallback remains usable', (t) => {
  const h = setup(t);
  const runtime = h.projection.ensureProjectionRuntime(h.record);
  const video = h.videos[0];
  const retired = video.listeners.get('resize');
  video.dispatchEvent(new Event('error'));
  assert.equal(runtime.mode, 'image');
  assert.equal(runtime.video, null);
  assert.equal(video.listeners.size, 0);
  assert.equal(h.refreshed(), 1);
  runtime.image.onload();
  assert.equal(runtime.imageReady, true);
  retired();
  assert.equal(h.writes.length, 1);
});

test('a synchronous video source failure can bind the placeholder and recover as an image', (t) => {
  const h = setup(t, { sourceFails: true });
  const runtime = h.projection.ensureProjectionRuntime(h.record);
  assert.equal(runtime.mode, 'image');
  assert.ok(runtime.image);
  assert.equal(runtime.planeMaterial.image, runtime.canvas);
  assert.equal(h.videos[0].listeners.size, 0);
  assert.equal(h.refreshed(), 1);
});

test('plane construction failure releases its already-attached media', (t) => {
  const h = setup(t, { planeFails: true });
  assert.throws(
    () => h.projection.ensureProjectionRuntime(h.record),
    /plane construction failed/,
  );
  assert.equal(h.videos[0].listeners.size, 0);
  assert.equal(h.videos[0].url, '');
  assert.equal(h.videos[0].paused, true);
  assert.equal(h.record.projection, undefined);
});

test('retired image callbacks cannot change a disposed projection', (t) => {
  const h = setup(t, { feedType: 'image' });
  const runtime = h.projection.ensureProjectionRuntime(h.record);
  const onload = runtime.image.onload;
  h.projection.destroyProjectionRuntime(runtime);
  onload();
  assert.equal(runtime.imageReady, false);
  assert.equal(runtime.imageStamp, 0);
});
