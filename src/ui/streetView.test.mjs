import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimPointer,
  isPointerFree,
  pointerOwner,
  releasePointer,
  resetPointerOwnership,
} from '../data/inputOwnership.js';
import { createStreetView } from './streetView.js';

// One fake Street View library for the whole file: the module caches the
// library it loads, exactly as the browser does.
const panoramasCreated = [];
const fakeStreetViewLibrary = {
  StreetViewPreference: { NEAREST: 'nearest' },
  StreetViewSource: { OUTDOOR: 'outdoor' },
  StreetViewService: class {
    async getPanorama({ location }) {
      return {
        data: {
          location: {
            pano: `pano@${location.lat},${location.lng}`,
            description: 'Test Street',
            latLng: { lat: () => location.lat, lng: () => location.lng },
          },
        },
      };
    }
  },
  StreetViewPanorama: class {
    constructor(element, options) {
      panoramasCreated.push(options.pano);
    }
    addListener() {
      return { remove() {} };
    }
    setPano() {}
    setPov() {}
    setVisible() {}
    getPosition() {
      return null;
    }
    getLocation() {
      return null;
    }
  },
};

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

const STORAGE_KEY = 'godsEyeView.streetView.dailyLoads';
const TODAY = new Date('2026-09-26T18:00:00Z'); // 11:00 Pacific, same day

function fakeElement() {
  return {
    className: '',
    innerHTML: '',
    textContent: '',
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener() {},
    querySelector: () => fakeElement(),
    remove() {},
  };
}

function fixture({
  apiKey = 'test-key',
  storage = memoryStorage(),
  dailyLimit,
  now = () => TODAY,
} = {}) {
  resetPointerOwnership();
  const handlers = [];
  const Cesium = {
    ScreenSpaceEventType: { LEFT_CLICK: 'LEFT_CLICK' },
    ScreenSpaceEventHandler: class {
      constructor() {
        this.destroyed = false;
        handlers.push(this);
      }
      setInputAction(action) {
        this.action = action;
      }
      destroy() {
        this.destroyed = true;
      }
    },
    defined: (value) => value !== undefined && value !== null,
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Color: { fromCssColorString: () => ({}), BLACK: {} },
    HeightReference: { CLAMP_TO_GROUND: 1 },
    Math: { toDegrees: (radians) => (radians * 180) / Math.PI },
  };
  const classes = new Set();
  const canvas = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  const viewer = {
    scene: { canvas, requestRender() {} },
    camera: { heading: 0 },
    entities: { removeById() {}, getById() {}, add: () => ({}) },
    isDestroyed: () => false,
  };
  const keyListeners = new Set();
  const documentRef = {
    defaultView: {
      google: {
        maps: { importLibrary: async () => fakeStreetViewLibrary },
      },
    },
    createElement: () => fakeElement(),
    body: { appendChild() {} },
    addEventListener: (type, listener) => {
      if (type === 'keydown') keyListeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === 'keydown') keyListeners.delete(listener);
    },
  };
  const toasts = [];
  const streetView = createStreetView({
    viewer,
    Cesium,
    documentRef,
    getApiKey: () => apiKey,
    showToast: (message) => toasts.push(message),
    storage,
    now,
    ...(dailyLimit === undefined ? {} : { dailyLimit }),
  });
  const press = (key) => {
    for (const listener of [...keyListeners]) listener({ key });
  };
  return { streetView, handlers, classes, keyListeners, toasts, press };
}

test('arming takes the pointer and shows the pick cursor', () => {
  const f = fixture();
  assert.equal(f.streetView.toggle(), true);
  assert.equal(pointerOwner(), 'street-view');
  assert.ok(f.classes.has('street-view-armed'));
  assert.match(f.toasts.at(-1), /Click a street/);
  f.streetView.destroy();
});

test('pressing the shortcut again or Escape gives the pointer back', () => {
  const f = fixture();
  f.streetView.toggle();
  f.streetView.toggle();
  assert.ok(isPointerFree());
  assert.ok(!f.classes.has('street-view-armed'));
  f.streetView.toggle();
  f.press('Escape');
  assert.ok(isPointerFree());
  f.streetView.destroy();
});

test('without a Google key nothing is armed and the toast says why', () => {
  const f = fixture({ apiKey: '  ' });
  assert.equal(f.streetView.toggle(), false);
  assert.ok(isPointerFree());
  assert.match(f.toasts.at(-1), /needs a Google Maps key/);
  f.streetView.destroy();
});

test('another tool holding the pointer blocks arming instead of stealing it', () => {
  const f = fixture();
  const lease = claimPointer('draw');
  assert.equal(f.streetView.toggle(), false);
  assert.equal(pointerOwner(), 'draw');
  assert.match(f.toasts.at(-1), /Finish draw first/);
  releasePointer(lease);
  f.streetView.destroy();
});

test('destroy releases the pointer, the click handler and the key listener', () => {
  const f = fixture();
  f.streetView.toggle();
  f.streetView.destroy();
  assert.ok(isPointerFree());
  assert.ok(f.handlers.every((handler) => handler.destroyed));
  assert.equal(f.keyListeners.size, 0);
  assert.equal(f.streetView.toggle(), false);
});

test('the daily limit refuses arming once today is used up', () => {
  const storage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify({ day: '2026-09-26', count: 150 }),
  });
  const f = fixture({ storage });
  assert.equal(f.streetView.toggle(), false);
  assert.ok(isPointerFree());
  assert.match(f.toasts.at(-1), /Daily Street View limit reached \(150\)/);
  f.streetView.destroy();
});

test("yesterday's count does not block today", () => {
  const storage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify({ day: '2026-09-25', count: 150 }),
  });
  const f = fixture({ storage });
  assert.equal(f.streetView.toggle(), true);
  f.streetView.destroy();
});

test('each new panorama counts once, and the limit stops the next one', async () => {
  const storage = memoryStorage();
  const f = fixture({ storage, dailyLimit: 2 });
  const before = panoramasCreated.length;
  assert.equal(await f.streetView.openAt({ lat: 51.5, lon: -0.12 }), true);
  // Moving an open panel reuses its panorama: not a new billable load.
  assert.equal(await f.streetView.openAt({ lat: 51.6, lon: -0.12 }), true);
  f.streetView.close();
  assert.equal(await f.streetView.openAt({ lat: 51.7, lon: -0.12 }), true);
  f.streetView.close();
  assert.equal(await f.streetView.openAt({ lat: 51.8, lon: -0.12 }), false);
  assert.equal(panoramasCreated.length - before, 2);
  assert.deepEqual(JSON.parse(storage.data.get(STORAGE_KEY)), {
    day: '2026-09-26',
    count: 2,
  });
  assert.match(f.toasts.at(-1), /limit reached \(2\)/);
  f.streetView.destroy();
});

test('the limit still holds when storage throws', async () => {
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const f = fixture({ storage: broken, dailyLimit: 1 });
  assert.equal(await f.streetView.openAt({ lat: 40.7, lon: -74 }), true);
  f.streetView.close();
  assert.equal(await f.streetView.openAt({ lat: 40.8, lon: -74 }), false);
  f.streetView.destroy();
});
