// src/layers/awareness/directionOverlay.test.mjs — the Global Context compass
// and contact bearings are presented to subscribers and rendered from a store
// inside the viewer's container.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useAwarenessDirectionStore } from '../../ui/stores/awarenessDirection.js';
import AwarenessDirection from '../../ui/views/panels/AwarenessDirection.vue';
import { createState } from './state.js';
import { createRendering } from './rendering.js';

/** The rendering part over a subject with one military contact due east. */
function overlay(screenAngle) {
  const state = createState({ services: {} });
  const container = document.body.appendChild(document.createElement('div'));
  const subject = Cesium.Cartesian3.fromDegrees(0, 0, 1000);
  Object.assign(state, {
    viewer: {
      container,
      scene: { canvas: { clientWidth: 800, clientHeight: 600 } },
      camera: {
        heading: 0,
        rightWC: new Cesium.Cartesian3(0, 1, 0),
        upWC: new Cesium.Cartesian3(0, 0, 1),
      },
    },
    enabled: true,
    subject: { position: subject, layerId: 'military' },
    results: {
      cohorts: [
        {
          id: 'military',
          summary: {
            nearest: [
              {
                callsign: 'RCH123',
                position: Cesium.Cartesian3.fromDegrees(0.05, 0, 1000),
                distanceM: 5500,
                track: 90,
              },
            ],
          },
        },
      ],
    },
    cohortPages: new Map(),
  });
  const rendering = createRendering({
    state,
    services: {
      geometry: {
        getKeyholeGeometry: () => ({ centerX: 400, centerY: 300, radius: 250 }),
        celestialScreenAngle:
          screenAngle ||
          ((x, y) => ({
            angle: Math.atan2(-y, x),
            opacity: 1,
            stable: true,
          })),
      },
      render: { governorRequestRender() {} },
    },
    parts: {},
  });
  return { state, container, rendering };
}

test('the overlay publishes the compass and the nearest contact bearings', () => {
  const { rendering, container } = overlay();
  const views = [];
  rendering.subscribeDirectionOverlay((view) => views.push(view));
  assert.deepEqual(views, [null]);
  rendering.updateDirectionOverlay();
  const view = views.at(-1);
  assert.ok(view.container === container);
  assert.equal(view.hidden, false);
  // The compass sits at 66% of the 250px keyhole: 165px.
  assert.equal(view.ring.width, '330px');
  assert.equal(view.ring['--compass-rotation'], '0deg');
  assert.equal(view.heading.text, 'HDG 000°');
  assert.deepEqual(
    view.labels.map((label) => label.label),
    ['N', 'E', 'S', 'W'],
  );
  assert.equal(view.labels[0].left, '400px');
  const [marker, second] = view.markers;
  assert.equal(marker.hidden, false);
  assert.match(marker.caption.text, /^RCH123 · .+\nBRG 090° · CRS 090°$/);
  assert.equal(marker.arrow.opacity, '1');
  assert.equal(second.hidden, true);
  // An unchanged frame publishes nothing.
  const count = views.length;
  rendering.updateDirectionOverlay();
  assert.equal(views.length, count);
  rendering.hideDirectionOverlay();
  assert.equal(views.at(-1).hidden, true);
  assert.equal(views.at(-1).heading.text, 'HDG 000°', 'placement is kept');
  rendering.removeDirectionOverlay();
  assert.equal(views.at(-1), null);
});

test('an unstable frame keeps the last stable bearing, until the overlay is removed', () => {
  const answers = [
    { angle: 1, opacity: 1, stable: true },
    { angle: 2, opacity: 0.5, stable: false },
  ];
  const previous = [];
  const { state, rendering } = overlay((x, y, last) => {
    previous.push(last);
    return answers.shift() ?? { angle: last ?? 0, opacity: 1, stable: true };
  });
  rendering.updateDirectionOverlay();
  assert.equal(state.directionAngles[0], 1);
  // The heading turns, so the next frame recomputes the contact.
  state.viewer.camera.heading = 0.1;
  rendering.updateDirectionOverlay();
  assert.equal(previous[1], 1, 'the unstable frame is given the last angle');
  assert.equal(state.directionAngles[0], 1, 'and does not replace it');
  rendering.removeDirectionOverlay();
  rendering.updateDirectionOverlay();
  assert.equal(previous[2], 0, 'a rebuilt overlay starts afresh');
});

test('the scene chrome view renders the published overlay in its container', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useAwarenessDirectionStore(pinia);
  const app = createApp(AwarenessDirection).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const { rendering, container } = overlay();
  rendering.subscribeDirectionOverlay((view) => store.publish(view));
  rendering.ensureDirectionOverlay();
  await nextTick();
  const root = container.querySelector('#military-awareness-direction-overlay');
  assert.equal(root.hidden, true);
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(
    [...root.children].map((child) => child.className),
    [
      'military-awareness-compass-label cardinal-n',
      'military-awareness-compass-label cardinal-e',
      'military-awareness-compass-label cardinal-s',
      'military-awareness-compass-label cardinal-w',
      'military-awareness-compass-ring',
      'military-awareness-compass-heading',
      'military-awareness-direction-marker',
      'military-awareness-direction-marker',
      'military-awareness-direction-marker',
    ],
  );
  assert.equal(root.children[0].dataset.bearing, '0');
  assert.equal(root.children[0].getAttribute('style'), null);
  rendering.updateDirectionOverlay();
  await nextTick();
  assert.equal(root.hidden, false);
  const ring = root.querySelector('.military-awareness-compass-ring');
  assert.equal(ring.style.getPropertyValue('--compass-rotation'), '0deg');
  assert.equal(
    root.querySelector('.military-awareness-compass-heading').textContent,
    'HDG 000°',
  );
  const [marker, second] = root.querySelectorAll(
    '.military-awareness-direction-marker',
  );
  assert.equal(marker.hidden, false);
  assert.equal(
    marker.querySelector('.military-awareness-direction-arrow').textContent,
    '➜',
  );
  assert.match(
    marker.querySelector('.military-awareness-direction-label').textContent,
    /^RCH123 · /,
  );
  assert.equal(second.hidden, true);
  rendering.removeDirectionOverlay();
  await nextTick();
  assert.equal(
    container.querySelector('#military-awareness-direction-overlay'),
    null,
  );
});
