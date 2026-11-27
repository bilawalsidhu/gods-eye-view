import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartographic, Math as CesiumMath } from 'cesium';
import { from, pausedRoute, to } from '../../testSupport/pausedRoute.mjs';

test('a shown, paused route draws the craft after a position update', async (t) => {
  const { preview, widget } = await pausedRoute();
  t.after(() => preview.destroy());
  let firstFrame;
  widget.scene.postRender.addEventListener(() => {
    const craft = widget.entities.values.find((entity) => entity.billboard);
    firstFrame ??= Cartographic.fromCartesian(craft.position);
  });
  preview.update({ from, to, at: to });
  widget.tick();
  assert.ok(firstFrame, 'the paused preview drew the updated route');
  assert.ok(
    Math.abs(CesiumMath.toDegrees(firstFrame.latitude) - to.lat) < 1e-6,
  );
  assert.ok(
    Math.abs(CesiumMath.toDegrees(firstFrame.longitude) - to.lon) < 1e-6,
  );
});

test('a hidden paused route draws nothing on an update', async () => {
  const { preview, widget } = await pausedRoute();
  preview.setShown(false);
  const before = widget.renders;
  preview.update({ from, to, at: { lat: 50, lon: -40 } });
  for (let i = 0; i < 5; i++) widget.tick();
  assert.equal(widget.renders, before);
  preview.setShown(true);
  assert.equal(widget.renders, before + 1);
  preview.destroy();
});

test('a paused route opens at the current plane pose and only a playing route flies in', async (t) => {
  const { cesiumCardPreviews } = await import('./cardPreviews.js');
  const media = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: false });
  t.after(() => {
    globalThis.matchMedia = media;
  });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const open = async (active) => {
    const host = { tilesLoadedOnFirstFrame: true };
    const preview = cesiumCardPreviews.route(host, {
      from,
      to,
      at: { lat: 52, lon: -20 },
    });
    t.after(() => preview.destroy());
    const widget = host.widget;
    let plane;
    widget.entities.add = (entity) => {
      if (entity.billboard) plane = entity;
      return entity;
    };
    preview.setActive(active);
    await new Promise((resolve) => setImmediate(resolve));
    widget.tick();
    return { widget, plane, preview };
  };
  const still = await open(false);
  assert.equal(
    still.widget.useDefaultRenderLoop,
    false,
    'the first frame settled with imagery ready',
  );
  const playing = await open(true);
  const start = playing.plane.position;
  assert.notDeepEqual(start, still.plane.position);
  now += 500;
  playing.widget.tick();
  assert.notDeepEqual(playing.plane.position, start);
  assert.notDeepEqual(playing.plane.position, still.plane.position);
  playing.preview.setActive(false);
  playing.widget.tick();
  assert.deepEqual(playing.plane.position, still.plane.position);
  assert.equal(playing.widget.useDefaultRenderLoop, false);
});

test('route readiness follows the first frame with geometry', async () => {
  const { cesiumCardPreviews } = await import('./cardPreviews.js');
  const host = {};
  let frames = 0;
  const preview = cesiumCardPreviews.route(
    host,
    { from, to },
    { onReady: () => frames++ },
  );
  try {
    host.widget.tick();
    assert.equal(frames, 0, 'the plain globe is still waiting for the route');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(frames, 0);
    host.widget.tick();
    host.widget.tick();
    assert.equal(frames, 1);
  } finally {
    preview.destroy();
  }
});

test('model readiness waits for a rendered frame after the mesh is ready', async (t) => {
  const { Cartesian3, Event, Model } = await import('cesium');
  const { cesiumCardPreviews } = await import('./cardPreviews.js');
  const mesh = {
    readyEvent: new Event(),
    boundingSphere: { center: Cartesian3.ZERO, radius: 1 },
  };
  t.mock.method(Model, 'fromGltfAsync', async () => mesh);
  const host = {};
  let frames = 0;
  const preview = cesiumCardPreviews.model(
    host,
    { gltf: new Uint8Array() },
    { onReady: () => frames++ },
  );
  try {
    host.widget.scene.primitives = { add: (m) => m };
    await new Promise((resolve) => setImmediate(resolve));
    host.widget.tick();
    assert.equal(frames, 0);
    const render = t.mock.method(host.widget, 'render', () => {});
    mesh.readyEvent.raiseEvent();
    assert.equal(frames, 0, 'a ready mesh has not yet been drawn');
    render.mock.restore();
    host.widget.tick();
    assert.equal(frames, 1);
    host.widget.tick();
    assert.equal(frames, 1);
  } finally {
    preview.destroy();
  }
});
