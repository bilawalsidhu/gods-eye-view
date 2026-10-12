import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from './projection.js';

test('closing snapshot and failed-video fallback releases native stores and plane once', () => {
  for (const failedVideo of [false, true]) {
    let releases = 0,
      removed = 0,
      unbound = 0;
    const canvas = { width: 1920, height: 1080 },
      buffers = [
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
      ];
    const image = { src: 'fixture', onload() {}, onerror() {} };
    const runtime = {
      cameraId: 'retired',
      mode: 'image',
      video: null,
      canvas,
      buffers,
      image,
      planeEntity: {},
      planeMaterial: {},
      unbindVideoTexture() {
        unbound++;
      },
      playback: failedVideo
        ? {
            dispose() {
              releases++;
            },
          }
        : null,
    };
    const record = { camera: { id: 'retired' }, projection: runtime };
    const state = {
      _projectionOverlayOwnerId: null,
      _enabled: true,
      _records: [record],
      _projectionEntities: [runtime],
      _viewer: {
        entities: {
          remove() {
            removed++;
          },
        },
      },
    };
    const projection = createProjection({
      state,
      services: { render: {} },
      parts: {},
    });
    projection.pauseInactiveProjectionFeeds(null);
    projection.pauseInactiveProjectionFeeds(null);
    assert.equal(record.projection, null);
    assert.equal(state._projectionEntities.length, 0);
    assert.equal(removed, 1);
    assert.equal(unbound, 1);
    assert.equal(runtime.unbindVideoTexture, null);
    assert.equal(releases, failedVideo ? 1 : 0);
    assert.equal(image.src, '');
    assert.equal(image.onload, null);
    assert.equal(image.onerror, null);
    for (const c of [canvas, ...buffers]) {
      assert.equal(c.width, 1);
      assert.equal(c.height, 1);
    }
    assert.equal(runtime.planeEntity, null);
    assert.equal(runtime.planeMaterial, null);
  }
});

test('active snapshot is retained while a retired camera is freed', () => {
  const active = {
    camera: { id: 'active' },
    projection: {
      cameraId: 'active',
      mode: 'image',
      canvas: { width: 640, height: 360 },
    },
  };
  const retired = {
    camera: { id: 'retired' },
    projection: {
      cameraId: 'retired',
      mode: 'image',
      canvas: { width: 640, height: 360 },
    },
  };
  const state = {
    _projectionOverlayOwnerId: null,
    _enabled: true,
    _records: [active, retired],
    _projectionEntities: [active.projection, retired.projection],
  };
  const projection = createProjection({
    state,
    services: { render: {} },
    parts: {},
  });
  projection.pauseInactiveProjectionFeeds('active');
  assert.equal(active.projection.canvas.width, 640);
  assert.equal(retired.projection, null);
});
