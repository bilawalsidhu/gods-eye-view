import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from './projection.js';

function fixture() {
  const removed = [];
  const records = ['active', 'still', 'video'].map((id) => {
    const runtime = {
      cameraId: id,
      canvas: { width: 1920, height: 1080 },
      buffers: [
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
      ],
      signatureCanvas: { width: 64, height: 36 },
      image: { src: 'frame', onload() {}, onerror() {} },
      planeEntity: { id },
    };
    if (id === 'video')
      runtime.video = {
        paused: false,
        src: 'stream',
        pause() {
          this.paused = true;
        },
        removeAttribute() {
          this.src = '';
        },
        load() {},
      };
    return {
      camera: { id },
      calibration: { heading: 123 },
      projection: runtime,
    };
  });
  const state = {
    _enabled: true,
    _records: records,
    _projectionEntities: records.map((r) => r.projection),
    _viewer: { entities: { remove: (e) => removed.push(e) } },
    _projectionOverlayOwnerId: null,
  };
  const projection = createProjection({
    state,
    services: { render: {} },
    parts: {},
    source: {},
  });
  return { state, records, projection, removed };
}

test('switching cameras releases still and video resources but keeps active runtime and calibration', () => {
  const f = fixture();
  const active = f.records[0].projection;
  const still = f.records[1].projection;
  const video = f.records[2].projection;
  const backing = [still.canvas, ...still.buffers, still.signatureCanvas];
  const image = still.image;
  const element = video.video;
  f.projection.pauseInactiveProjectionFeeds('active');
  assert.equal(f.records[0].projection, active);
  assert.deepEqual(f.state._projectionEntities, [active]);
  assert.equal(f.records[1].projection, null);
  assert.equal(f.records[2].projection, null);
  assert.deepEqual(f.records[1].calibration, { heading: 123 });
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
  assert.equal(image.src, '');
  assert.ok(backing.every((c) => c.width === 0 && c.height === 0));
  assert.equal(still.canvas, null);
  assert.equal(still.buffers, null);
  assert.equal(element.paused, true);
  assert.equal(element.src, '');
  assert.equal(f.removed.length, 2);
  f.projection.destroyProjectionRuntime(still);
  assert.equal(f.removed.length, 2, 'teardown is idempotent');
});

test('disabled CCTV releases the last active projection too', () => {
  const f = fixture();
  f.state._enabled = false;
  f.projection.pauseInactiveProjectionFeeds('active');
  assert.ok(f.records.every((r) => r.projection === null));
  assert.deepEqual(f.state._projectionEntities, []);
});

test('coverage eviction preserves active geometry, camera calibration and sampled coordinates', async () => {
  const { createGeometry } = await import('./geometry.js');
  const removed = [];
  const records = ['active', 'visible', 'offscreen'].map((id) => ({
    camera: { id, headingDeg: 123 },
    coverageEntities: [{ id: `${id}-line`, show: true }],
    frustumPositions: { marker: id },
  }));
  const state = {
    _records: records,
    _coverageEntities: records.flatMap((r) => r.coverageEntities),
    _projectionEntities: [],
    _viewer: { entities: { remove: (entity) => removed.push(entity) } },
  };
  const geometry = createGeometry({
    state,
    services: { ground: {}, mesh: {} },
    parts: { projection: {} },
  });
  geometry.releaseUnusedCoverageEntities(new Set(['visible']), 'active');
  assert.equal(records[0].coverageEntities.length, 1);
  assert.equal(records[1].coverageEntities.length, 1);
  assert.deepEqual(records[2].coverageEntities, []);
  assert.equal(records[2].camera.headingDeg, 123);
  assert.deepEqual(records[2].frustumPositions, { marker: 'offscreen' });
  assert.equal(state._coverageEntities.length, 2);
  assert.equal(
    removed[0].show,
    true,
    'remove without queuing a native show mutation',
  );
  geometry.destroyCoverageEntities();
  assert.ok(records.every((r) => !r.coverageEntities.length));
  assert.equal(state._coverageEntities.length, 0);
});
