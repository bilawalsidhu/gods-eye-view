// src/layers/wind/inspectionMarker.test.mjs — the wind inspection marker
// follows only its captured point, renders in its container, and releases
// its frame listener.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useWindInspectionStore } from '../../ui/stores/windInspection.js';
import WindInspectionMarker from '../../ui/views/panels/WindInspectionMarker.vue';
import { createWindInspectionMarker } from './inspectionMarker.js';

const cesium = {
  SceneMode: { SCENE3D: 3 },
  Ellipsoid: { WGS84: {} },
  EllipsoidalOccluder: class {
    isPointVisible() {
      return cesium.visible;
    }
  },
  visible: true,
};

function fixture(t) {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  container.getBoundingClientRect = () => ({ left: 5, top: 10 });
  const pinia = createPinia();
  const app = createApp(WindInspectionMarker).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const frames = { listener: null };
  const projected = [];
  const viewer = {
    camera: { positionWC: {} },
    scene: {
      mode: 3,
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        getBoundingClientRect: () => ({ left: 15, top: 30 }),
      },
      postRender: {
        addEventListener(fn) {
          assert.equal(frames.listener, null);
          frames.listener = fn;
          return () => {
            frames.listener = null;
          };
        },
      },
      cartesianToCanvasCoordinates(point) {
        projected.push(point);
        return { x: 100, y: 200 };
      },
      requestRender() {},
    },
  };
  const store = useWindInspectionStore(pinia);
  cesium.visible = true;
  const owner = createWindInspectionMarker({
    container,
    viewer,
    cesium,
    store,
  });
  const nodes = () => [
    ...container.querySelectorAll('.gev-wind-inspection-marker'),
  ];
  return { owner, viewer, store, frames, projected, nodes, container, cesium };
}

test('the marker follows only its captured point, hides beyond the limb, and releases its listener', async (t) => {
  const { owner, viewer, frames, projected, nodes } = fixture(t);
  const point = { x: 1, y: 2, z: 3 };
  owner.show(point);
  await nextTick();
  assert.equal(nodes().length, 1);
  const [marker] = nodes();
  assert.equal(marker.getAttribute('aria-hidden'), 'true');
  assert.equal(marker.style.pointerEvents, 'none');
  assert.equal(marker.style.position, 'absolute');
  assert.equal(marker.style.zIndex, '150');
  assert.equal(marker.style.left, '110px');
  assert.equal(marker.style.top, '220px');
  assert.equal(marker.hidden, false);
  viewer.camera.positionWC = { moved: true };
  cesium.visible = false;
  frames.listener();
  await nextTick();
  assert.equal(marker.hidden, true);
  assert.equal(marker.style.left, '110px', 'a hidden marker keeps its place');
  assert.ok(projected.every((value) => value === point));
  cesium.visible = true;
  frames.listener();
  await nextTick();
  assert.equal(marker.hidden, false);
  owner.show({ x: 4 });
  await nextTick();
  assert.equal(nodes().length, 1);
  owner.clear();
  await nextTick();
  assert.equal(nodes().length, 0);
  assert.equal(frames.listener, null);
  owner.show(point);
  owner.destroy();
  owner.destroy();
  await nextTick();
  assert.equal(nodes().length, 0);
  assert.equal(frames.listener, null);
});

test('an unchanged frame publishes nothing, and an older owner leaves a newer marker', (t) => {
  const { owner, viewer, store, frames, container } = fixture(t);
  owner.show({ x: 1 });
  let publishes = 0;
  const publish = store.publish;
  store.publish = (next) => {
    publishes += 1;
    publish(next);
  };
  frames.listener();
  assert.equal(publishes, 0);
  frames.listener = null;
  const newer = createWindInspectionMarker({
    container,
    viewer,
    cesium,
    store,
  });
  newer.show({ x: 2 });
  const shown = store.marker;
  owner.destroy();
  assert.ok(store.marker === shown);
  newer.destroy();
  assert.equal(store.marker, null);
});
