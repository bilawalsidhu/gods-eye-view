import test from 'node:test';
import assert from 'node:assert/strict';
import { followOnDoubleClick, followViewFrom } from './stockFollow.js';
import { bindRenderer } from '../render/rendererOf.js';
import { WGS84 } from '../geo/ellipsoid.js';

/** A viewer whose renderer answers picks with `hit` and records the camera. */
function scene({ hit, stock = true, enabled = true }) {
  const viewer = {};
  const handlers = new Map();
  const calls = [];
  const camera = {
    followed: null,
    controls: { minDistance: 0, maxDistance: Infinity },
    pose: () => ({ fovy: Math.PI / 3, aspectRatio: 2 }),
    follow(target) {
      calls.push(['follow', target]);
      camera.followed = target;
    },
    flyToBounds(sphere, options) {
      calls.push(['flyToBounds', sphere, options]);
    },
  };
  const unbind = bindRenderer(viewer, {
    camera,
    query: { pick: () => hit },
  });
  const input = {
    onPointer(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    stockEnabled: (name) => name === 'dblclickFollow' && stock,
  };
  const at = { x: WGS84.radii.x, y: 0, z: 0 };
  const follow = followOnDoubleClick({
    viewer,
    inputFor: () => input,
    name: 'test-layer',
    enabled: () => enabled,
    targetFor: (picked) =>
      picked.id === 'point'
        ? { key: 'layer:point', position: () => at }
        : picked.id === 'line'
          ? { zoomTo: { center: at, radius: 50 } }
          : null,
  });
  const dblclick = () =>
    handlers.get('dblclick')?.({ position: { x: 1, y: 2 } });
  return { follow, camera, calls, dblclick, handlers, unbind };
}

test('a double-click follows a point, framed as the default renderer framed an entity', () => {
  const s = scene({ hit: { set: 'layer', id: 'point', surface: false } });
  s.dblclick();
  const [[kind, target]] = s.calls;
  assert.equal(kind, 'follow');
  assert.equal(target.key, 'layer:point');
  assert.equal(target.frame, 'enu');
  // No size: the minimum fit range, 45 degrees down on the ground.
  const range = Math.hypot(
    target.viewFrom.x,
    target.viewFrom.y,
    target.viewFrom.z,
  );
  assert.ok(Math.abs(range - 100) < 1e-6);
  assert.ok(Math.abs(target.viewFrom.z + target.viewFrom.y) < 1e-6);
  assert.equal(s.follow.following, target);
  // Stopping ends only the follow it started.
  s.follow.stop();
  assert.equal(s.camera.followed, null);
  s.follow.destroy();
  assert.equal(s.handlers.size, 0);
  s.unbind();
});

test('a double-click on a line zooms to it at once, following nothing', () => {
  const s = scene({ hit: { set: 'layer', id: 'line', surface: false } });
  s.camera.followed = { key: 'other' };
  s.dblclick();
  assert.deepEqual(
    s.calls.map(([kind]) => kind),
    ['follow', 'flyToBounds'],
  );
  assert.equal(s.calls[0][1], null);
  assert.deepEqual(s.calls[1][2], { durationS: 0 });
  s.follow.destroy();
  s.unbind();
});

test('no follow while the stock double-click is held off, the layer is off, or the pick is not its own', () => {
  for (const options of [
    { hit: { id: 'point', surface: false }, stock: false },
    { hit: { id: 'point', surface: false }, enabled: false },
    { hit: { id: 'other', surface: false } },
    { hit: { surface: true } },
    { hit: null },
  ]) {
    const s = scene(options);
    s.dblclick();
    assert.deepEqual(s.calls, []);
    s.follow.destroy();
    s.unbind();
  }
});

test('the frame view fits a sphere and steepens far from the ground', () => {
  const camera = { pose: () => ({ fovy: Math.PI / 2, aspectRatio: 1 }) };
  const ground = { x: WGS84.radii.x, y: 0, z: 0 };
  const near = followViewFrom({ center: ground, radius: 1000 }, ground, camera);
  assert.ok(Math.abs(Math.hypot(near.x, near.y, near.z) - 1000) < 1e-6);
  const high = { x: WGS84.radii.x * 2, y: 0, z: 0 };
  const far = followViewFrom({ center: high, radius: 0 }, high, camera);
  // Looking down 45 degrees times 1.5 at twice the radius: the eye that
  // far above, south of the point.
  const elevation = Math.atan2(far.z, Math.hypot(far.x, far.y));
  assert.ok(Math.abs(elevation - (Math.PI / 4) * 1.5) < 1e-9);
  assert.ok(far.y < 0);
});

test('a drawn item is followed as an entity with a position was, or zoomed to as one without', async () => {
  const { drawnItemTarget } = await import('./stockFollow.js');
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-6;
  const { fromDegrees } = await import('../geo/ellipsoid.js');
  const point = drawnItemTarget('s', { id: 'p', pos: { lon: 10, lat: 20 } });
  assert.equal(point.key, 's:p');
  assert.ok(near(point.position(), fromDegrees(10, 20, 0)));
  const disc = drawnItemTarget('s', {
    id: 'd',
    geometry: {
      kind: 'ellipse',
      center: { lon: 10, lat: 20 },
      semiMajor: 4000,
      semiMinor: 3000,
    },
  });
  assert.equal(disc.sphere.radius, 4000);
  assert.ok(near(disc.position(), fromDegrees(10, 20, 0)));
  const flat = new Float64Array([
    ...Object.values(fromDegrees(0, 0, 0)),
    ...Object.values(fromDegrees(2, 0, 0)),
  ]);
  const line = drawnItemTarget('s', { id: 'l', positions: flat });
  assert.ok(line.zoomTo.radius > 100_000 && !line.position);
  const polygon = drawnItemTarget('s', {
    id: 'g',
    geometry: {
      kind: 'polygon',
      rings: [
        [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 0 },
          { lon: 1, lat: 1 },
        ],
      ],
    },
  });
  assert.ok(polygon.zoomTo.radius > 50_000);
  const rect = drawnItemTarget('s', {
    id: 'r',
    geometry: {
      kind: 'rectangle',
      rect: { west: 0, south: 0, east: 1, north: 1 },
    },
  });
  assert.ok(rect.zoomTo.radius > 50_000);
  assert.equal(drawnItemTarget('s', null), null);
});
