import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { aircraftViewRef } from './aircraftViews.js';
import {
  createTrackedAircraftIcon,
  trackedIconColor,
} from './trackedAircraftIcon.js';

// Once its 3D model draws the contact, Flights and Military
// make the tracked icon transparent (trackedIconColor(color, 0)) and keep it
// shown. A transparent icon must not stay pickable: the GPU icon shader
// paints a pick proxy opaque whatever the row's alpha
// (iconSetPrimitive.js: `if (v_proxy > 0.5) color = vec4(1.0);`).
test('a transparent tracked view icon carries no live pick proxy', () => {
  const viewer = {};
  const listeners = new Set();
  const frame = {
    requestRender() {},
    on(_phase, cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const { draw } = bindFakeDraw(viewer, { frame });
  const tick = () => {
    for (const cb of [...listeners]) cb({});
  };
  const icon = createTrackedAircraftIcon({
    viewer: () => viewer,
    setPrefix: 'flights',
  });
  let modelOwnsVisual = false;
  const base = Object.freeze([1, 0.8, 0.2, 1]);
  icon.show({
    id: 'abc123',
    image: aircraftViewRef('airliner'),
    sprite: { width: 28, height: 28, scale: 1, scaleByDistance: undefined },
    position: () => ({ x: 1, y: 2, z: 3 }),
    rotation: () => 0,
    course: () => 45,
    color: () => (modelOwnsVisual ? trackedIconColor(base, 0) : base),
  });
  const set = draw.find('flights-tracked-icon:');
  tick();
  assert.ok(set.items.get('abc123').pickProxy, 'visible sprite: proxy on');
  modelOwnsVisual = true;
  tick();
  const item = set.items.get('abc123');
  assert.equal(item.color[3], 0, 'the model owns the visual');
  const pickable = item.show !== false && Boolean(item.pickProxy?.size?.[0]);
  assert.equal(
    pickable,
    false,
    'a fully transparent tracked icon still has an active pick proxy',
  );
  icon.dispose();
});
