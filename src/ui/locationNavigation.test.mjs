import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationNavigation } from './locationNavigation.js';

/** Replace `globalThis.navigator` (Node 21+ exposes a read-only getter). */
function replaceNavigator(t, geo) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { geolocation: geo },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  });
}

function makeGeo({ onWatch } = {}) {
  return {
    getCurrentPosition(success) {
      success({
        timestamp: 1,
        coords: { latitude: 10, longitude: 20, accuracy: 3 },
      });
    },
    watchPosition(success, error) {
      onWatch?.({ success, error });
      return 42;
    },
    clearWatch() {},
  };
}

function makeViewer() {
  const added = [];
  const entities = {
    add(desc) {
      const entity = { id: desc.id };
      added.push(entity);
      return entity;
    },
    remove(entity) {
      const index = added.indexOf(entity);
      if (index >= 0) added.splice(index, 1);
      return true;
    },
  };
  return {
    entities,
    scene: { globe: { getHeight: () => 1234 } },
    camera: { lookAt() {}, lookAtTransform() {}, cancelFlight() {} },
    canvas: {
      addEventListener() {},
      removeEventListener() {},
    },
    added,
  };
}

function makeNavigation() {
  let generation = 0;
  const listeners = new Set();
  const nav = {
    _handoffListeners: listeners,
    get _navigationGeneration() {
      return generation;
    },
    subscribeCameraHandoff(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    _stampNavigation() {
      generation += 1;
      for (const listener of [...listeners]) {
        listener({ state: { generation } });
      }
    },
    // Real stamps advance the generation through the navigation controller.
    _beginDeferredNavigation() {
      this._stampNavigation();
      return generation;
    },
    _reassertNavigationHandoff() {
      return true;
    },
  };
  return nav;
}

function makeButton() {
  const listeners = new Map();
  const button = {
    listeners,
    title: '',
    disabled: false,
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  return button;
}

function makeControls() {
  return {
    hidePois() {},
    highlightCity() {},
    renderStatus() {},
    destroy() {},
  };
}

function makeState({ nav = makeNavigation(), geo = makeGeo() } = {}) {
  const toasts = [];
  const overlay = { entries: null, cleared: false };
  const viewer = makeViewer();
  const button = makeButton();
  const owner = new LocationNavigation({
    viewer,
    navigation: nav,
    readCockpit: () => null,
    services: {
      OrbitController: class {
        toggle() {}
        stop() {}
      },
      CITY_POIS: {},
      flyToLandmark: () => ({ targetPosition: { x: 1, y: 2, z: 3 } }),
      setOverlayEntries(_source, entries) {
        overlay.entries = entries;
      },
      clearOverlaySource() {
        overlay.cleared = true;
      },
    },
    elements: {
      _myLocationBtn: button,
      _locationControls: makeControls(),
    },
    operations: {
      _beginDeferredNavigation: () => nav._beginDeferredNavigation(),
      _reassertNavigationHandoff: (g) => nav._reassertNavigationHandoff(g),
      _stampNavigation: () => nav._stampNavigation(),
      _showToast: (text) => toasts.push(text),
    },
  });
  return { owner, viewer, button, nav, toasts, overlay, geo };
}

test('insecure context disables the button and explains why', (t) => {
  replaceNavigator(t, makeGeo());
  const { owner, button } = makeState();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  Object.defineProperty(globalThis, 'isSecureContext', {
    configurable: true,
    writable: true,
    value: false,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'isSecureContext', previous);
    else delete globalThis.isSecureContext;
  });
  owner._initMyLocationControl();
  assert.equal(button.disabled, true);
  assert.match(button.title, /secure \(HTTPS\)/);
});

test('geolocation fly-to and follow are keyboard accessible via the gesture', async (t) => {
  const watchErrors = [];
  replaceNavigator(t, makeGeo({ onWatch: ({ error }) => watchErrors.push(error) }));
  const { owner, button, toasts } = makeState();
  owner._initMyLocationControl();

  // Enter/Space (and programmatic .click()) land on onClick -> one-shot fly-to.
  button.listeners.get('click')({ detail: 0 });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(owner._myLocationEntity); // fly-to places and keeps the "You" marker
  assert.equal(owner._myLocationFollow, false); // ...without following

  // Shift+Enter on the button invokes onHold -> follow starts.
  const prevented = [];
  button.listeners.get('keydown')({
    key: 'Enter',
    shiftKey: true,
    preventDefault() {
      prevented.push(true);
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(prevented.length, 1);
  assert.equal(owner._myLocationFollow, true);
  assert.ok(toasts.includes('Following your location'));
});

test('a newer navigation or Cockpit/tracking hand-off ends follow', async (t) => {
  replaceNavigator(t, makeGeo());
  const { owner, nav, overlay, toasts } = makeState();
  owner._initMyLocationControl();
  owner._startMyLocationFollow({
    lat: 10,
    lon: 20,
    accuracy: 3,
  });
  assert.equal(owner._myLocationFollow, true);
  const followGeneration = owner._myLocationFollowGeneration;

  nav._stampNavigation(); // city pill / search / Cockpit entry / tracking
  assert.equal(owner._myLocationFollow, false);
  assert.ok(toasts.includes('Stopped following location'));
  assert.equal(overlay.cleared, true);
  assert.ok(followGeneration < nav._navigationGeneration);
});

test('a hand-off with an unchanged generation does not stop follow', async (t) => {
  replaceNavigator(t, makeGeo());
  const { owner, nav } = makeState();
  owner._initMyLocationControl();
  owner._startMyLocationFollow({ lat: 10, lon: 20, accuracy: 3 });
  // Simulate a re-publish of the same generation (no newer navigation).
  const listener = nav._handoffListeners ?? new Set();
  for (const fn of listener) fn({ state: { generation: nav._navigationGeneration } });
  assert.equal(owner._myLocationFollow, true);
});

test('denial ends follow; timeout toasts once and keeps watching', async (t) => {
  const handlers = {};
  replaceNavigator(
    t,
    makeGeo({
      onWatch: ({ success, error }) => {
        handlers.error = error;
        handlers.success = success;
      },
    }),
  );
  const { owner, toasts } = makeState();
  owner._initMyLocationControl();
  owner._startMyLocationFollow({ lat: 10, lon: 20, accuracy: 3 });

  // Denial is terminal.
  handlers.error({ code: 1, message: 'denied' });
  assert.equal(owner._myLocationFollow, false);
  assert.ok(toasts.filter((t) => t.includes('denied')).length >= 1);

  // Re-enter follow, then a timeout toasts once but keeps watching.
  owner._startMyLocationFollow({ lat: 10, lon: 20, accuracy: 3 });
  const toastCount = toasts.length;
  handlers.error({ code: 3, message: 'timed out' });
  assert.equal(owner._myLocationFollow, true);
  handlers.error({ code: 3, message: 'timed out again' });
  assert.equal(toasts.slice(toastCount).filter((t) => t.includes('timed out')).length, 1);
});

test('destroy stops follow, clears the marker and the overlay source, and unsubscribes', async (t) => {
  replaceNavigator(t, makeGeo());
  const { owner, viewer, overlay } = makeState();
  owner._initMyLocationControl();
  owner._startMyLocationFollow({ lat: 10, lon: 20, accuracy: 3 });
  assert.ok(viewer.added.length >= 1);
  assert.ok(Array.isArray(overlay.entries) && overlay.entries.length >= 1);

  const handoffUnsubscribe = owner._myLocationHandoffUnsubscribe;
  owner.destroy();
  assert.equal(owner._myLocationFollow, false);
  assert.equal(viewer.added.length, 0); // entity removed
  assert.equal(overlay.cleared, true);

  // destroy unsubscribed the handoff, so later stamps never revive anything.
  assert.equal(typeof handoffUnsubscribe, 'function');
});
