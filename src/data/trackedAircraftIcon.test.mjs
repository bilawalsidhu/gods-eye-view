import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import {
  createTrackedAircraftIcon,
  isOtherTrackedIconSet,
  trackedContactHolder,
  trackedIconColor,
} from './trackedAircraftIcon.js';

/** A viewer double with a fake draw port and a frame port whose preRender the test runs. */
function harness() {
  const viewer = {};
  const listeners = new Set();
  const requests = [];
  const frame = {
    requestRender(reason) {
      requests.push(reason);
    },
    on(phase, cb) {
      assert.equal(phase, 'preRender');
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const { draw } = bindFakeDraw(viewer, { frame });
  const tick = () => {
    for (const cb of [...listeners]) cb({});
  };
  return { viewer, draw, listeners, tick, requests };
}

const SPRITE = Object.freeze({
  width: 28,
  height: 28,
  scale: 1.2,
  scaleByDistance: { near: 1000, nearValue: 3, far: 8e6, farValue: 0.5 },
});

test('the tracked billboard is one icon re-posed each frame, and only when it changed', () => {
  const { viewer, draw, listeners, tick, requests } = harness();
  const icon = createTrackedAircraftIcon({
    viewer: () => viewer,
    setPrefix: 'flights',
  });
  assert.equal(icon.setId, null, 'no set before anything is shown');
  let pos = { x: 1, y: 2, z: 3 };
  let rotation = 0.5;
  let color = [0, 1, 1, 1];
  icon.show({
    id: 'abc123',
    image: 'data:image/svg+xml;base64,AAA',
    sprite: SPRITE,
    position: () => pos,
    rotation: () => rotation,
    color: () => color,
  });
  const set = draw.find('flights-tracked-icon:');
  assert.ok(set, 'an icon set on the draw port');
  assert.equal(set.kind, 'icons');
  assert.equal(icon.setId, set.spec.id);
  assert.equal(listeners.size, 1, 'drawn before each frame');
  assert.equal(set.items.size, 0, 'nothing is drawn between frames');
  assert.equal(requests.length, 1, 'a frame is asked for');
  tick();
  const item = set.items.get('abc123');
  assert.deepEqual(item.pos, { x: 1, y: 2, z: 3 });
  assert.notEqual(item.pos, pos, 'the position is copied');
  assert.deepEqual(item.size, [28, 28]);
  assert.equal(item.scale, 1.2);
  assert.equal(item.scaleByDistance, SPRITE.scaleByDistance);
  assert.equal(item.rotationMode, 'screen');
  assert.equal(item.rotation, 0.5);
  assert.deepEqual(item.color, [0, 1, 1, 1]);
  assert.equal(item.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(item.show, true);

  const writes = set.writes;
  color = [0, 1, 1, 1];
  tick();
  assert.equal(
    set.writes,
    writes,
    'a frame that changes nothing writes nothing',
  );

  pos = { x: 4, y: 5, z: 6 };
  rotation = 1;
  color = [0, 1, 1, 0];
  tick();
  assert.equal(set.writes, writes + 1);
  assert.deepEqual(set.items.get('abc123').pos, { x: 4, y: 5, z: 6 });
  assert.equal(set.items.get('abc123').rotation, 1);
  assert.deepEqual(set.items.get('abc123').color, [0, 1, 1, 0]);

  icon.setImage('data:image/svg+xml;base64,BBB');
  assert.equal(set.items.get('abc123').image, 'data:image/svg+xml;base64,AAA');
  tick();
  assert.equal(set.items.get('abc123').image, 'data:image/svg+xml;base64,BBB');

  const holder = trackedContactHolder('flights:abc123', icon, () => pos);
  assert.equal(holder.show, true);
  assert.deepEqual(holder.position.getValue(), { x: 4, y: 5, z: 6 });
  holder.show = false;
  tick();
  assert.equal(holder.show, false);
  assert.equal(set.items.get('abc123').show, false, 'hidden while kept');
  holder.show = true;
  tick();
  assert.equal(set.items.get('abc123').show, true);

  pos = null;
  tick();
  assert.equal(set.items.get('abc123').show, false, 'no position hides it');

  icon.hide();
  assert.equal(set.items.size, 0);
  assert.equal(listeners.size, 0, 'no frame work while hidden');
  icon.setImage('ignored');
  assert.equal(set.items.size, 0);

  icon.dispose();
  assert.equal(draw.sets.get(set.spec.id).disposed, true);
});

test('each layer lifetime gets its own set id, and showing again replaces the contact', () => {
  const { viewer, draw, tick } = harness();
  const a = createTrackedAircraftIcon({
    viewer: () => viewer,
    setPrefix: 'military',
  });
  const b = createTrackedAircraftIcon({
    viewer: () => viewer,
    setPrefix: 'military',
  });
  const target = (id) => ({
    id,
    image: 'img',
    sprite: SPRITE,
    position: () => ({ x: 1, y: 1, z: 1 }),
    rotation: () => 0,
    color: () => [1, 1, 1, 1],
  });
  a.show(target('one'));
  b.show(target('two'));
  tick();
  assert.notEqual(a.setId, b.setId);
  a.show(target('three'));
  tick();
  assert.deepEqual([...draw.set(a.setId).items.keys()], ['three']);
});

test('without a draw port nothing is drawn and nothing throws', () => {
  const icon = createTrackedAircraftIcon({
    viewer: () => null,
    setPrefix: 'flights',
  });
  icon.show({
    id: 'x',
    image: 'img',
    sprite: SPRITE,
    position: () => ({ x: 0, y: 0, z: 1 }),
    rotation: () => 0,
    color: () => [1, 1, 1, 1],
  });
  icon.setVisible(false);
  icon.hide();
  icon.dispose();
  assert.equal(icon.setId, null);
});

test("a layer tells another layer's tracked icon set from its own sets", () => {
  assert.equal(
    isOtherTrackedIconSet('flights-tracked-icon:3', 'military'),
    true,
  );
  assert.equal(
    isOtherTrackedIconSet('military-tracked-icon:1', 'flights'),
    true,
  );
  assert.equal(
    isOtherTrackedIconSet('military-tracked-icon:1', 'military'),
    false,
  );
  assert.equal(isOtherTrackedIconSet('flights-icons:2', 'military'), false);
  assert.equal(
    isOtherTrackedIconSet('flights-tracked-model:2', 'military'),
    false,
  );
  assert.equal(isOtherTrackedIconSet(undefined, 'military'), false);
});

test('the tracked icon keeps its contact\'s colour; only the alpha changes', () => {
  const amber = Object.freeze([1, 0.72, 0, 1]);
  assert.equal(trackedIconColor(amber, 1), amber, 'unchanged at its own alpha');
  const stale = trackedIconColor(amber, 0.45);
  assert.deepEqual(stale, [1, 0.72, 0, 0.45]);
  assert.equal(trackedIconColor(amber, 0.45), stale, 'one array per alpha');
  assert.ok(Object.isFrozen(stale));
  assert.deepEqual(trackedIconColor(amber, 0), [1, 0.72, 0, 0]);
});
