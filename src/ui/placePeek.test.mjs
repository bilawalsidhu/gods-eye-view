import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as inputOwnership from '../data/inputOwnership.js';

import {
  initPlacePeek,
  placePeekCandidates,
  selectClickablePlaces,
  spotTitle,
} from './placePeek.js';

function placePeekFixture() {
  let postRender;
  let doubleClick;
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.listeners = new Map();
      this.attributes = new Map();
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      this.children = children;
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
    click() {
      this.listeners.get('click')?.();
    }
    querySelector(selector) {
      const tags = selector.split(',').map((value) => value.trim());
      return (
        this.children.find((child) => tags.includes(child.tagName)) ||
        this.children.map((child) => child.querySelector(selector)).find(Boolean) ||
        null
      );
    }
    focus() {}
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((child) => child !== this);
    }
  }
  const body = new Node('body');
  const canvas = new Node('canvas');
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  const documentRef = { body, createElement: (tag) => new Node(tag) };
  const viewer = {
    scene: {
      canvas,
      globe: { ellipsoid: {} },
      postRender: {
        addEventListener: (listener) => {
          postRender = listener;
          return () => {};
        },
      },
    },
    camera: {
      positionWC: {},
      pickEllipsoid: () => ({}),
      moveEnd: { addEventListener() {}, removeEventListener() {} },
    },
  };
  class ScreenSpaceEventHandler {
    setInputAction(action) {
      doubleClick = action;
    }
    destroy() {}
  }
  const cesium = {
    Cartesian3: { fromDegrees: () => ({}) },
    Cartographic: { fromCartesian: () => ({ latitude: 0.5, longitude: -1 }) },
    Math: { toDegrees: (value) => value },
    ScreenSpaceEventHandler,
    ScreenSpaceEventType: { LEFT_DOUBLE_CLICK: 1 },
    EllipsoidalOccluder: class {
      isPointVisible() {
        return true;
      }
    },
    SceneTransforms: { worldToWindowCoordinates: () => ({ x: 10, y: 20 }) },
  };
  return {
    body,
    documentRef,
    viewer,
    cesium,
    doubleClick: (position = { x: 100, y: 100 }) => doubleClick({ position }),
    postRender: () => postRender(),
  };
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

test.beforeEach(() => inputOwnership.resetPointerOwnership());
test.afterEach(() => inputOwnership.resetPointerOwnership());

test('selectClickablePlaces keeps unique valid nearby places in distance order', () => {
  const places = selectClickablePlaces([
    { id: 'far', name: 'Station', latitude: 30.3, longitude: -97.7, distanceM: 900 },
    { id: 'near', name: 'Library', latitude: 30.2, longitude: -97.8, distanceM: 100 },
    { id: 'duplicate', name: 'library', latitude: 30.21, longitude: -97.81, distanceM: 200 },
    { id: 'invalid', name: 'Nowhere', latitude: 120, longitude: 0, distanceM: 1 },
  ]);

  assert.deepEqual(places.map((place) => place.id), ['near', 'far']);
});

test('placePeekCandidates reuses reverse-geocode labels when nearby search is unavailable', () => {
  assert.deepEqual(
    placePeekCandidates({
      formattedAddress: 'Congress Ave, Austin, TX',
      locality: 'Austin',
      region: 'Texas',
      labels: ['Congress Ave, Austin, TX', 'Austin, TX'],
    }),
    [
      { name: 'Congress Ave, Austin, TX', kind: 'address' },
      { name: 'Austin', kind: 'locality' },
      { name: 'Texas', kind: 'region' },
      { name: 'Austin, TX', kind: 'address' },
    ],
  );
});

test('spotTitle prefers locality and falls back to coordinates', () => {
  assert.equal(spotTitle({ locality: 'Austin' }, 30.2672, -97.7431), 'Austin');
  assert.equal(spotTitle(null, 30.2672, -97.7431), '30.27°N 97.74°W');
});

test('Place Peek exposes an explicit close control for touch and keyboard users', () => {
  const source = readFileSync(new URL('./placePeek.js', import.meta.url), 'utf8');
  assert.match(source, /className = 'place-peek-close'/);
  assert.match(source, /close\.addEventListener\('click', closePeek\)/);
});

test('a Place Peek label rechecks pointer ownership when activated', async () => {
  const f = placePeekFixture();
  let pointerFree = true;
  let flights = 0;
  initPlacePeek({
    ...f,
    placeSearch: {
      capabilities: { nearby: true },
      nearby: async () => [
        { name: 'Library', latitude: 30.2, longitude: -97.8, distanceM: 10 },
      ],
    },
    navigation: { runImmediateNavigation: (_kind, run) => run() },
    flyTo: () => {
      flights += 1;
    },
    pointerFree: () => pointerFree,
  });
  await Promise.resolve();
  await Promise.resolve();
  const label = f.body.children[0].children[0];
  pointerFree = false;
  label.click();
  assert.equal(flights, 0);
});

test('Place Peek labels follow pointer ownership transitions without a render', async () => {
  const f = placePeekFixture();
  let flights = 0;
  let canvasClicks = 0;
  f.viewer.scene.canvas.addEventListener('click', () => {
    canvasClicks += 1;
  });
  const placePeek = initPlacePeek({
    ...f,
    placeSearch: {
      capabilities: { nearby: true },
      nearby: async () => [
        { name: 'Library', latitude: 30.2, longitude: -97.8, distanceM: 10 },
      ],
    },
    navigation: { runImmediateNavigation: (_kind, run) => run() },
    flyTo: () => {
      flights += 1;
    },
    pointerFree: inputOwnership.isPointerFree,
    subscribePointerOwnership: inputOwnership.subscribePointerOwnership,
  });
  await settle();
  let label = f.body.children[0].children[0];
  const clickLabelPosition = () =>
    (label.style.pointerEvents === 'none' ? f.viewer.scene.canvas : label).click();

  const initialPointerEvents = label.style.pointerEvents;
  const lease = inputOwnership.claimPointer('draw');
  assert.equal(label.style.pointerEvents, 'none');
  clickLabelPosition();
  assert.equal(canvasClicks, 1);
  assert.equal(flights, 0);

  await placePeek.refresh();
  label = f.body.children[0].children[0];
  assert.equal(label.style.pointerEvents, 'none', 'new claimed labels yield');

  inputOwnership.releasePointer(lease);
  assert.equal(initialPointerEvents, 'auto', 'new free labels are clickable');
  assert.equal(label.style.pointerEvents, 'auto');
  clickLabelPosition();
  assert.equal(canvasClicks, 1);
  assert.equal(flights, 1);

  placePeek.destroy();
  const destroyedStyle = label.style.pointerEvents;
  const nextLease = inputOwnership.claimPointer('draw');
  assert.equal(label.style.pointerEvents, destroyedStyle, 'destroy removes ownership listener');
  inputOwnership.releasePointer(nextLease);
});

test('Place Peek keeps its layer transparent while labels and panel follow pointer ownership', async () => {
  const f = placePeekFixture();
  const placePeek = initPlacePeek({
    ...f,
    placeSearch: {
      capabilities: { nearby: true },
      nearby: async () => [
        { name: 'Library', latitude: 30.2, longitude: -97.8, distanceM: 10 },
      ],
      reverseGeocode: async () => ({ locality: 'Austin' }),
    },
    flyTo() {},
    pointerFree: inputOwnership.isPointerFree,
    subscribePointerOwnership: inputOwnership.subscribePointerOwnership,
  });
  await settle();
  f.doubleClick();
  await settle();
  const [layer, panel] = f.body.children;
  const label = layer.children[0];
  const styles = readFileSync(new URL('./styles/overlays.css', import.meta.url), 'utf8');

  assert.match(styles, /#place-label-layer\s*{[^}]*pointer-events:\s*none/s);
  assert.equal(layer.style.pointerEvents, undefined);
  assert.equal(label.style.pointerEvents, 'auto');
  assert.equal(panel.style.pointerEvents, 'auto');
  const lease = inputOwnership.claimPointer('draw');
  assert.equal(layer.style.pointerEvents, undefined);
  assert.equal(label.style.pointerEvents, 'none');
  assert.equal(panel.style.pointerEvents, 'none');
  inputOwnership.releasePointer(lease);
  assert.equal(layer.style.pointerEvents, undefined);
  assert.equal(label.style.pointerEvents, 'auto');
  assert.equal(panel.style.pointerEvents, 'auto');
  placePeek.destroy();
});

test('Place Peek does not open after ownership is claimed during its request', async () => {
  const f = placePeekFixture();
  const reverse = deferred();
  const placePeek = initPlacePeek({
    ...f,
    placeSearch: {
      capabilities: { nearby: false },
      reverseGeocode: () => reverse.promise,
    },
    flyTo() {},
    pointerFree: inputOwnership.isPointerFree,
    subscribePointerOwnership: inputOwnership.subscribePointerOwnership,
  });
  f.doubleClick();
  const lease = inputOwnership.claimPointer('draw');
  reverse.resolve({ locality: 'Austin' });
  await settle();

  assert.deepEqual(
    f.body.children.map((child) => child.id),
    ['place-label-layer'],
  );
  inputOwnership.releasePointer(lease);
  placePeek.destroy();
});

test('a superseded nearby result cannot replace current rendered labels', async () => {
  const f = placePeekFixture();
  const requests = [];
  const placePeek = initPlacePeek({
    ...f,
    placeSearch: {
      capabilities: { nearby: true },
      nearby: () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    },
    flyTo() {},
  });
  const replacement = placePeek.refresh();
  requests[1].resolve([
    { name: 'Current', latitude: 30.2, longitude: -97.8, distanceM: 10 },
  ]);
  await replacement;

  requests[0].resolve([
    { name: 'Superseded', latitude: 31, longitude: -98, distanceM: 10 },
  ]);
  await settle();

  assert.deepEqual(
    f.body.children[0].children.map((child) => child.textContent),
    ['Current'],
  );
  assert.doesNotThrow(f.postRender);
});

test('a superseded nearby rejection cannot clear current rendered labels', async () => {
  const f = placePeekFixture();
  const requests = [];
  const placePeek = initPlacePeek({
    ...f,
    placeSearch: {
      capabilities: { nearby: true },
      nearby: () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    },
    flyTo() {},
  });
  const replacement = placePeek.refresh();
  requests[1].resolve([
    { name: 'Current', latitude: 30.2, longitude: -97.8, distanceM: 10 },
  ]);
  await replacement;

  const staleAbort = new Error('late provider cancellation');
  staleAbort.name = 'AbortError';
  requests[0].reject(staleAbort);
  await settle();
  const current = f.body.children[0].children[0];
  current.style.left = '';

  assert.deepEqual(
    f.body.children[0].children.map((child) => child.textContent),
    ['Current'],
  );
  assert.doesNotThrow(f.postRender);
  assert.equal(current.style.left, '10px');
});

test('a current non-aborted AbortError rejection clears rendered labels', async () => {
  const f = placePeekFixture();
  const requests = [];
  const placePeek = initPlacePeek({
    ...f,
    placeSearch: {
      capabilities: { nearby: true },
      nearby: () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
    },
    flyTo() {},
  });
  requests[0].resolve([
    { name: 'Old', latitude: 30.2, longitude: -97.8, distanceM: 10 },
  ]);
  await settle();
  assert.equal(f.body.children[0].children.length, 1);

  const current = placePeek.refresh();
  const error = new Error('current provider failure');
  error.name = 'AbortError';
  requests[1].reject(error);
  await current;

  assert.equal(f.body.children[0].children.length, 0);
});
