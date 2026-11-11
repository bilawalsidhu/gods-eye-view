// src/celestialRingView.test.mjs — the full-globe ring renders in the
// viewer's container from what the ring owner presents, and the owner paints
// the canvases the view hands back.
import './testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useCelestialRingStore } from './ui/stores/celestialRing.js';
import CelestialRingView from './ui/views/panels/CelestialRing.vue';
import * as Cesium from 'cesium';
import { CelestialRing } from './celestialRing.js';

// happy-dom has no 2D context; a stand-in takes every drawing call.
const context = new Proxy(
  {},
  { get: (target, name) => target[name] ?? (() => context), set: () => true },
);
globalThis.HTMLCanvasElement.prototype.getContext = () => context;

function fakeViewer(container) {
  return {
    container,
    camera: {
      rightWC: new Cesium.Cartesian3(1, 0, 0),
      upWC: new Cesium.Cartesian3(0, 1, 0),
    },
    scene: {
      canvas: { clientWidth: 400, clientHeight: 300, width: 400, height: 300 },
      postRender: { addEventListener: () => () => {} },
      requestRender() {},
    },
  };
}

function fixture(t) {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const store = useCelestialRingStore(pinia);
  const app = createApp(CelestialRingView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const rings = [];
  const create = (options = {}) => {
    const ring = new CelestialRing(fakeViewer(container), {
      enabled: false,
      store,
      ...options,
    });
    rings.push(ring);
    return ring;
  };
  t.after(() => {
    for (const ring of rings) ring.destroy();
    app.unmount();
  });
  const $ = (selector) => container.querySelector(selector);
  const settle = async () => {
    for (let flush = 0; flush < 4; flush += 1) await nextTick();
  };
  return { container, store, create, $, settle };
}

test('the ring renders its overlay in the viewer container', async (t) => {
  const { create, $, settle } = fixture(t);
  const ring = create();
  await settle();
  const root = $('#celestial-ring-overlay');
  assert.equal(root.className, 'celestial-ring-overlay disabled');
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.equal(root.hasAttribute('data-globe-visible'), false);
  assert.deepEqual(
    [...root.children].map((child) => [child.tagName, child.className]),
    [
      ['DIV', 'celestial-ring-outline'],
      ['CANVAS', 'celestial-ring-canvas celestial-sun-canvas'],
      ['CANVAS', 'celestial-ring-canvas celestial-moon-canvas'],
      ['SPAN', 'celestial-marker celestial-sun material-symbols-outlined'],
      ['SPAN', 'celestial-marker celestial-moon material-symbols-outlined'],
    ],
  );
  assert.equal(root.children[0].style.display, 'none');
  assert.equal(root.children[3].textContent, 'light_mode');
  assert.equal(root.children[4].textContent, 'dark_mode');
  assert.ok(ring._sunCanvas === root.children[1]);
  assert.ok(ring._moonCanvas === root.children[2]);
  ring.setEnabled(true);
  await settle();
  assert.equal(root.className, 'celestial-ring-overlay');
  ring.destroy();
  await settle();
  assert.equal($('#celestial-ring-overlay'), null);
  assert.equal(ring._sunCanvas, null);
});

test('a drawn frame places the outline, layers and markers', async (t) => {
  const { create, $, settle } = fixture(t);
  const ring = create({ enabled: true });
  await settle();
  ring._present({ visible: true, globeVisible: 'true', ephemerisUpdates: '1' });
  ring._resize(400, 300);
  ring._renderEffectLayers(200, 150, 120, 80);
  ring._present({
    sun: { transform: 'rotate(1rad)', opacity: '0.5' },
    sunMarker: ring._markerPosition(200, 150, 100, 0, 1),
  });
  await settle();
  const root = $('#celestial-ring-overlay');
  assert.equal(root.className, 'celestial-ring-overlay visible');
  assert.equal(root.dataset.globeVisible, 'true');
  assert.equal(root.dataset.ephemerisUpdates, '1');
  const [outline, sun, moon, sunMarker] = root.children;
  assert.equal(outline.style.display, '');
  assert.equal(outline.style.left, '80px');
  assert.equal(outline.style.width, '240px');
  assert.equal(sun.style.width, '400px');
  assert.equal(sun.style.transform, 'rotate(1rad)');
  assert.equal(sun.style.opacity, '0.5');
  assert.equal(moon.style.height, '300px');
  assert.equal(sunMarker.style.left, '300px');
  assert.equal(sunMarker.style.top, '150px');
  ring.setEnabled(false);
  await settle();
  assert.equal(root.className, 'celestial-ring-overlay disabled');
  assert.equal(outline.style.display, 'none');
});

test("an earlier ring leaves a later ring's overlay alone", async (t) => {
  const { create, store, $, settle } = fixture(t);
  const earlier = create();
  await settle();
  const later = create();
  await settle();
  const root = $('#celestial-ring-overlay');
  assert.ok(later._sunCanvas === root.children[1]);
  earlier.setEnabled(true);
  earlier.destroy();
  await settle();
  assert.ok(store.ring.owner === later._owner);
  assert.equal(
    $('#celestial-ring-overlay').className,
    'celestial-ring-overlay disabled',
  );
  assert.ok(later._sunCanvas === $('.celestial-sun-canvas'));
});

// A globe framed well inside the keyhole of a 400 x 300 view.
const FRAMED = {
  earthCenterX: 200,
  earthCenterY: 150,
  earthRadius: 40,
  keyholeCenterX: 200,
  keyholeCenterY: 150,
  keyholeRadius: 140,
};

/** Run one rendered frame, past the frame-rate throttle. */
function frame(ring, disc) {
  ring._projectedEarthDisc = () => disc;
  // Fixed sun and moon directions; Cesium's own model would fetch its
  // orientation data.
  ring._updateEphemeris = () => {
    if (ring._ephemerisDirty) {
      Cesium.Cartesian3.clone(new Cesium.Cartesian3(1, 0, 0), ring._sunFixed);
      Cesium.Cartesian3.clone(new Cesium.Cartesian3(0, 1, 0), ring._moonFixed);
      ring._ephemerisDirty = false;
      ring._ephemerisUpdateCount += 1;
    }
    return true;
  };
  ring._nextDrawAt = 0;
  ring._draw();
}

test('a rendered frame publishes the layers and markers it painted', async (t) => {
  const { create, $, settle } = fixture(t);
  const ring = create({ enabled: true });
  await settle();
  frame(ring, FRAMED);
  await settle();
  const root = $('#celestial-ring-overlay');
  assert.equal(root.className, 'celestial-ring-overlay visible');
  assert.equal(root.dataset.globeVisible, 'true');
  assert.equal(root.dataset.ephemerisUpdates, '1');
  const [outline, sun, moon, sunMarker, moonMarker] = root.children;
  const debug = ring.getDebugState();
  assert.equal(debug.visible, true);
  assert.equal(outline.style.display, '');
  // The outline is the keyhole circle, a fixed inset inside its radius.
  const diameter = parseFloat(outline.style.width);
  assert.ok(diameter > 0 && diameter < 280);
  assert.equal(outline.style.height, outline.style.width);
  assert.equal(outline.style.left, `${200 - diameter / 2}px`);
  assert.equal(outline.style.top, `${150 - diameter / 2}px`);
  assert.equal(sun.style.width, '400px');
  assert.equal(moon.style.height, '300px');
  assert.equal(sun.style.transform, `rotate(${debug.sunAngle}rad)`);
  assert.equal(moon.style.transform, `rotate(${debug.moonAngle}rad)`);
  assert.equal(sun.style.opacity, String(debug.sunOpacity));
  assert.equal(moon.style.opacity, String(debug.moonOpacity));
  assert.ok(sunMarker.style.left.endsWith('px'));
  assert.ok(moonMarker.style.top.endsWith('px'));
  assert.equal(moonMarker.style.opacity, String(debug.moonOpacity));
});

test('a frame without the globe framed turns the ring off', async (t) => {
  const { create, $, settle } = fixture(t);
  let disabled = 0;
  const ring = create({ enabled: true, onAutoDisable: () => (disabled += 1) });
  await settle();
  frame(ring, FRAMED);
  frame(ring, null);
  await settle();
  assert.equal(ring.enabled, false);
  assert.equal(disabled, 1);
  assert.equal(
    $('#celestial-ring-overlay').className,
    'celestial-ring-overlay disabled',
  );
});

test('without a rendered view the ring still tracks the globe and turns off', () => {
  const pinia = createPinia();
  let disabled = 0;
  const ring = new CelestialRing(fakeViewer({}), {
    enabled: true,
    store: useCelestialRingStore(pinia),
    onAutoDisable: () => (disabled += 1),
  });
  frame(ring, FRAMED);
  assert.equal(ring.visible, true);
  frame(ring, null);
  assert.equal(ring.enabled, false);
  assert.equal(disabled, 1);
  ring.destroy();
});

test('a ring the store no longer shows stops drawing', async (t) => {
  const { create, settle } = fixture(t);
  let disabled = 0;
  const earlier = create({
    enabled: true,
    onAutoDisable: () => (disabled += 1),
  });
  await settle();
  create();
  await settle();
  frame(earlier, null);
  assert.equal(earlier.enabled, true);
  assert.equal(disabled, 0);
});
