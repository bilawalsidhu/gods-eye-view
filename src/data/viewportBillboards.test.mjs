import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  insidePaddedViewport,
  ViewportBillboardCollection,
} from './viewportBillboards.js';

test('sharp surface replaces only owned color commands and preserves native picking and depth passes', () => {
  const h = harness();
  h.group.add({ position: new Cesium.Cartesian3(0, 0, 0), image: 'aircraft' });
  h.group.update({});
  h.group._aircraftSurface = { accept: () => true, release() {} };
  const own = { owner: 'aircraft' },
    sibling = { owner: 'other' };
  h.collections[0].update = (frame) => frame.commandList.push(own);
  for (const [passes, expected] of [
    [{ render: true, pick: false }, [sibling]],
    [{ render: false, pick: true }, [sibling, own]],
    [{ render: false, depth: true }, [sibling, own]],
  ]) {
    const frame = { passes, commandList: [sibling] };
    h.group.update(frame);
    assert.deepEqual(frame.commandList, expected);
  }
  h.group.destroy();
});

test('sharp rendering defers warmed picking buffers but flushes live positions on a pick and warms new images', () => {
  const h = harness();
  const b = h.group.add({
    position: new Cesium.Cartesian3(0, 0, 0),
    image: 'first',
  });
  h.group.update({});
  h.group._aircraftSurface = { accept: () => true, release() {} };
  let uploads = 0,
    pickedX;
  const native = h.collections[0];
  native.ready = true;
  native.update = (frame) => {
    uploads++;
    if (frame.passes.pick) pickedX = b.position.x;
  };
  const color = { passes: { render: true, pick: false }, commandList: [] };
  h.group.update(color);
  h.group.update(color);
  assert.equal(
    uploads,
    1,
    'ready image buffers are not uploaded on every color frame',
  );
  b.position = new Cesium.Cartesian3(0.25, 0, 0);
  h.group.update({ passes: { render: false, pick: true }, commandList: [] });
  assert.equal(pickedX, 0.25, 'pick receives the latest aircraft position');
  b.image = 'second';
  h.group.update(color);
  assert.equal(uploads, 3, 'new image warms before the next user click');
  h.group.destroy();
});

test('tracked native picks follow fleet picks even when the fleet skips a warmed color update', () => {
  const h = harness();
  h.group.add({ position: new Cesium.Cartesian3(), image: 'aircraft' });
  h.group.update({});
  const fleet = { owner: 'fleet' },
    tracked = { owner: 'tracked' };
  h.collections[0].update = (frame) => frame.commandList.push(fleet);
  let trackedUpdates = 0;
  h.group._trackedSurface = {
    update(frame) {
      trackedUpdates++;
      frame.commandList.push(tracked);
    },
    destroy() {},
  };
  const pick = { passes: { pick: true }, commandList: [] };
  h.group.update(pick);
  assert.deepEqual(pick.commandList, [fleet, tracked]);
  h.group._aircraftSurface = { accept: () => true, release() {} };
  h.group._pickWarm = false;
  const color = { passes: { render: true }, commandList: [] };
  h.group.update(color);
  assert.deepEqual(color.commandList, [tracked]);
  assert.equal(trackedUpdates, 2);
  h.group.destroy();
});

test('camera-only residency changes invalidate cached surface membership', () => {
  const h = harness();
  h.group.add({
    position: new Cesium.Cartesian3(0, 0, 0),
    image: 'first-class',
  });
  h.group.add({
    position: new Cesium.Cartesian3(2.2, 0, 0),
    image: 'new-class',
  });
  h.group.update({});
  const revision = h.group._surfaceRevision;
  h.viewer.camera.viewMatrix[12] = -2.2;
  h.group.update({});
  assert.ok(h.group._surfaceRevision > revision);
  assert.equal(h.group.renderedCount, 1);
  assert.equal(h.collections[0].rows[0].image, 'new-class');
  h.group.destroy();
});

function harness() {
  const collections = [];
  let pinned = null;
  const viewer = {
    camera: {
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      frustum: { projectionMatrix: Cesium.Matrix4.IDENTITY },
    },
    scene: { canvas: { clientWidth: 1000, clientHeight: 1000 } },
  };
  const group = new ViewportBillboardCollection(viewer, {
    isPinned: (id) => id === pinned,
    enterPaddingPx: 50,
    keepPaddingPx: 100,
    createCollection() {
      const rows = [];
      const collection = {
        rows,
        destroyed: false,
        get length() {
          return rows.length;
        },
        add(options) {
          const b = {},
            values = {};
          for (const key of Object.keys(options)) {
            Object.defineProperty(b, key, {
              get() {
                return values[key];
              },
              set(value) {
                values[key] =
                  typeof value?.clone === 'function'
                    ? value.clone(values[key])
                    : value;
              },
            });
            b[key] = options[key];
          }
          rows.push(b);
          return b;
        },
        remove(b) {
          const i = rows.indexOf(b);
          if (i < 0) return false;
          rows.splice(i, 1);
          return true;
        },
        update() {},
        isDestroyed() {
          return this.destroyed;
        },
        destroy() {
          this.destroyed = true;
          rows.length = 0;
        },
      };
      collections.push(collection);
      return collection;
    },
  });
  return {
    viewer,
    group,
    collections,
    pin(id) {
      pinned = id;
      group._dirty = true;
    },
  };
}

test('padded viewport includes glyph edges and rejects points behind the camera', () => {
  const m = Cesium.Matrix4.IDENTITY;
  assert.equal(
    insidePaddedViewport(new Cesium.Cartesian3(1.09, 0, 0), m, 1000, 1000, 50),
    true,
  );
  assert.equal(
    insidePaddedViewport(new Cesium.Cartesian3(1.11, 0, 0), m, 1000, 1000, 50),
    false,
  );
  const behind = Cesium.Matrix4.clone(m);
  behind[15] = -1;
  assert.equal(
    insidePaddedViewport(Cesium.Cartesian3.ZERO, behind, 1000, 1000, 50),
    false,
  );
});

test('only in-view render objects materialize while offscreen contacts retain their data and identity', () => {
  const h = harness();
  const visible = h.group.add({
    id: 'visible',
    position: new Cesium.Cartesian3(0, 0, 0),
    color: Cesium.Color.CYAN,
  });
  const far = h.group.add({
    id: 'far',
    position: new Cesium.Cartesian3(5, 0, 0),
  });
  h.group.update({});
  assert.equal(h.group.length, 2);
  assert.equal(h.group.renderedCount, 1);
  assert.equal(visible.viewportVisible, true);
  assert.equal(far.viewportVisible, false);
  assert.equal(far.id, 'far');
  assert.equal(far.position.x, 5);
  assert.equal(h.collections[0].rows[0].id, 'visible');
  assert.deepEqual(h.collections[0].rows[0].color, Cesium.Color.CYAN);
  h.viewer.camera.viewMatrix[12] = -5;
  h.group.update({});
  assert.equal(h.group.renderedCount, 1);
  assert.equal(visible.viewportVisible, false);
  assert.equal(far.viewportVisible, true);
  assert.equal(
    h.collections[0].rows[0].id,
    'far',
    'panning admits the existing contact without a feed refresh',
  );
  h.group.destroy();
});

test('viewport admission has hysteresis and tracked subjects stay resident outside the frame', () => {
  const h = harness();
  const contact = h.group.add({
    id: 'tracked',
    position: new Cesium.Cartesian3(1.05, 0, 0),
  });
  h.group.update({});
  contact.position = new Cesium.Cartesian3(1.15, 0, 0);
  h.group.update({});
  assert.equal(
    contact.viewportVisible,
    true,
    'keep margin is wider than admission',
  );
  contact.position = new Cesium.Cartesian3(1.25, 0, 0);
  h.group.update({});
  assert.equal(contact.viewportVisible, false);
  h.pin('tracked');
  h.group.update({});
  assert.equal(contact.viewportVisible, true);
  h.group.destroy();
});

test('scratch positions are cloned and hidden/destroyed layers release real render resources', () => {
  const h = harness();
  const scratch = new Cesium.Cartesian3(0, 0, 0);
  const contact = h.group.add({ id: 'a', position: scratch });
  h.group.update({});
  contact.position = scratch;
  scratch.x = 5;
  assert.equal(contact.position.x, 0);
  h.group.show = false;
  assert.equal(h.group.renderedCount, 0);
  assert.equal(h.collections[0].destroyed, true);
  assert.equal(
    h.group.contains(contact),
    true,
    'contact metadata remains available',
  );
  h.group.show = true;
  h.group.update({});
  assert.equal(h.group.renderedCount, 1);
  assert.equal(h.collections.length, 2);
  assert.equal(h.group.remove(contact), true);
  assert.equal(h.group.remove(contact), false);
  assert.equal(h.group.length, 0);
  h.group.destroy();
  h.group.destroy();
  assert.equal(h.group.isDestroyed(), true);
  assert.equal(h.collections[1].destroyed, true);
});
