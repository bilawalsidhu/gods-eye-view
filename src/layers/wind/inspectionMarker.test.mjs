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
import { bindRenderer } from '../../render/rendererOf.js';

/** Whether the fake query port sees the point over the horizon. */
const horizon = { visible: true };

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
  const requests = [];
  const viewer = {
    get canvas() {
      return this.scene?.canvas;
    },
    scene: {
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        getBoundingClientRect: () => ({ left: 15, top: 30 }),
      },
    },
  };
  bindRenderer(viewer, {
    query: {
      project(point) {
        projected.push(point);
        return { x: 100, y: 200 };
      },
      isOccluded: () => !horizon.visible,
    },
    frame: {
      on(phase, fn) {
        assert.equal(phase, 'postRender');
        assert.equal(frames.listener, null);
        frames.listener = fn;
        return () => {
          frames.listener = null;
        };
      },
      requestRender: (reason) => requests.push(reason),
    },
  });
  const store = useWindInspectionStore(pinia);
  horizon.visible = true;
  const owner = createWindInspectionMarker({
    container,
    viewer,
    store,
  });
  const nodes = () => [
    ...container.querySelectorAll('.gev-wind-inspection-marker'),
  ];
  return {
    owner,
    viewer,
    store,
    frames,
    projected,
    requests,
    nodes,
    container,
  };
}

test('the marker follows only its captured point, hides beyond the limb, and releases its listener', async (t) => {
  const { owner, frames, projected, requests, nodes } = fixture(t);
  const point = { x: 1, y: 2, z: 3 };
  owner.show(point);
  assert.ok(requests.length > 0, 'showing asks the frame port for a frame');
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
  horizon.visible = false;
  frames.listener();
  await nextTick();
  assert.equal(marker.hidden, true);
  assert.equal(marker.style.left, '110px', 'a hidden marker keeps its place');
  assert.ok(projected.every((value) => value === point));
  horizon.visible = true;
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
    store,
  });
  newer.show({ x: 2 });
  const shown = store.marker;
  owner.destroy();
  assert.ok(store.marker === shown);
  newer.destroy();
  assert.equal(store.marker, null);
});
