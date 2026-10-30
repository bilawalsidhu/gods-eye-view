import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  initPlacePeek,
  placePeekCandidates,
  selectClickablePlaces,
  spotTitle,
} from './placePeek.js';

function placePeekFixture() {
  let postRender;
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.listeners = new Map();
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    click() {
      this.listeners.get('click')?.();
    }
    remove() {}
  }
  const body = new Node('body');
  const documentRef = { body, createElement: (tag) => new Node(tag) };
  const viewer = {
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
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
    setInputAction() {}
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
};

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

  requests[0].reject(new Error('late provider failure'));
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
