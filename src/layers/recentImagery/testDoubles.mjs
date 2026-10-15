/**
 * Test doubles shared by the Recent Imagery tests: manual timers, fetch
 * responses, and the Cesium/viewer/document fakes the box tool needs.
 */
import { thumbnailOrder } from './model.js';

export const BOX = Object.freeze({
  west: -97.8,
  south: 30.2,
  east: -97.7,
  north: 30.3,
});

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Timers that fire only when the test says so. */
export function manualTimers() {
  const pending = new Map();
  const cleared = [];
  let nextId = 1;
  return {
    pending,
    cleared,
    setTimeoutImpl(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutImpl(id) {
      cleared.push(id);
      pending.delete(id);
    },
    /** Fire every armed timer, in order. */
    flush() {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.fn();
    },
    armed: () => pending.size,
  };
}

/** A `fetch` response with case-insensitive headers. */
export function response({
  ok = true,
  status = ok ? 200 : 500,
  json = {},
  headers = {},
  blob = { size: 1 },
} = {}) {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok,
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    json: async () => json,
    blob: async () => blob,
  };
}

const EVENT_TYPES = {
  LEFT_DOWN: 'down',
  MOUSE_MOVE: 'move',
  LEFT_UP: 'up',
  LEFT_CLICK: 'click',
  LEFT_DOUBLE_CLICK: 'dblclick',
};

/**
 * Cesium, viewer and document fakes for `initImageryBoxTool`. The canvas is
 * 1000 × 500 px mapped linearly onto 0.2° near Austin; y < 40 px is sky.
 */
export function boxToolFakes() {
  const handlers = [];
  class ScreenSpaceEventHandler {
    constructor(canvas) {
      this.canvas = canvas;
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(fn, type) {
      this.actions.set(type, fn);
    }
    getInputAction(type) {
      return this.actions.get(type);
    }
    removeInputAction(type) {
      this.actions.delete(type);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class CustomDataSource {
    constructor(name) {
      this.name = name;
      const values = [];
      this.entities = {
        values,
        add: (entity) => (values.push(entity), entity),
        removeAll: () => values.splice(0),
      };
    }
  }
  const color = { withAlpha: (alpha) => ({ alpha }) };
  const cesium = {
    ScreenSpaceEventHandler,
    ScreenSpaceEventType: EVENT_TYPES,
    CustomDataSource,
    CallbackProperty: class {},
    PolylineDashMaterialProperty: class {},
    ClassificationType: { BOTH: 'both' },
    Color: { fromCssColorString: () => color },
    Rectangle: { fromDegrees: () => ({}) },
    Cartesian3: { fromDegreesArray: (values) => values },
  };

  const stock = new ScreenSpaceEventHandler('stock');
  const originalClick = () => 'select';
  const originalDouble = () => 'track';
  stock.setInputAction(originalClick, EVENT_TYPES.LEFT_CLICK);
  stock.setInputAction(originalDouble, EVENT_TYPES.LEFT_DOUBLE_CLICK);
  const sources = [];
  const viewer = {
    renders: 0,
    scene: {
      canvas: { clientWidth: 1000, clientHeight: 500 },
      screenSpaceCameraController: { enableInputs: true },
      requestRender: () => {
        viewer.renders += 1;
      },
    },
    screenSpaceEventHandler: stock,
    dataSources: {
      sources,
      add: (source) => (sources.push(source), Promise.resolve(source)),
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
  };

  const listeners = [];
  const classes = new Set();
  const documentRef = {
    listeners,
    classes,
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex((entry) => entry[1] === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    body: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
    },
  };

  const pickWorld = (_viewer, nx, ny) =>
    ny * 500 < 40 ? null : { lon: -97.9 + nx * 0.2, lat: 30.4 - ny * 0.2 };
  /** The live (non-stock) canvas handler, if the tool has one bound. */
  const handler = () =>
    handlers.find((h) => h.canvas !== 'stock' && !h.destroyed) || null;
  const fire = (type, event) =>
    handler()?.actions.get(EVENT_TYPES[type])?.(event);
  /** Dispatch a keydown to the tool's document listener. */
  const key = (name) => {
    const event = {
      key: name,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
    };
    listeners.find(([type]) => type === 'keydown')?.[1](event);
    return event;
  };
  return {
    cesium,
    viewer,
    documentRef,
    pickWorld,
    handler,
    fire,
    key,
    types: EVENT_TYPES,
    originalClick,
    originalDouble,
  };
}

// ---- the layer's injected parts --------------------------------------

export function candidate(product, day, cloud = 5) {
  const granules =
    product === 'VIIRS'
      ? []
      : [
          {
            id: `${product}-${day}`,
            product,
            timeStart: `${day}T17:12:00Z`,
            timeEnd: `${day}T17:14:00Z`,
            cloud,
          },
        ];
  return {
    key: `${product}:${day}`,
    product,
    day,
    granules,
    cloud: granules.length ? { min: cloud, max: cloud } : null,
    timeRange: granules.length
      ? { start: granules[0].timeStart, end: granules[0].timeEnd }
      : null,
    availability: granules.length ? 'present' : 'unknown',
    coverage: 'full',
  };
}

// Strip order, newest first: V21 (unprobed), S18 (clear), L16 (cloudy), V15.
export const CANDIDATES = Object.freeze([
  candidate('VIIRS', '2026-09-21'),
  candidate('S30', '2026-09-18', 12),
  candidate('L30', '2026-09-16', 60),
  candidate('VIIRS', '2026-09-15'),
]);

export function fakeRenderer() {
  const calls = [];
  const owned = { a: null, b: null };
  let host = { kind: 'none' };
  let peak = 0;
  return {
    calls,
    rebind(next) {
      calls.push(['rebind', next.kind]);
      host = next;
      for (const slot of ['a', 'b'])
        if (owned[slot]) owned[slot] = { ...owned[slot], kind: next.kind };
    },
    showSlot(slot, cand, box, look) {
      if (owned[slot]?.key !== cand.key) calls.push(['show', slot, cand.key]);
      owned[slot] = { key: cand.key, kind: host.kind, ...look };
      peak = Math.max(peak, this.ownedCount());
      return true;
    },
    hideSlot(slot) {
      owned[slot] = null;
    },
    setAlpha(slot, alpha) {
      calls.push(['alpha', slot, alpha]);
    },
    getOwned: () => ({ ...owned }),
    ownedCount: () => ['a', 'b'].filter((slot) => owned[slot]).length,
    peak: () => peak,
    destroy() {
      calls.push(['destroy']);
    },
  };
}

export function fakeThumbnails() {
  const calls = [];
  const listeners = new Set();
  const statuses = new Map();
  /** Every key the layer asked to probe, in the order it asked. */
  const requested = [];
  /** Direct `request` calls: `[key, priority]`. */
  const requests = [];
  const ask = (key) => {
    if (!requested.includes(key)) requested.push(key);
  };
  return {
    calls,
    requested,
    requests,
    requestOrdered(candidates, box, window) {
      calls.push(['ordered', candidates.map((c) => c.key), window]);
      const { focusIndex, firstVisible, lastVisible, extra } = window;
      thumbnailOrder(
        focusIndex,
        firstVisible,
        lastVisible,
        candidates.length,
        extra,
      ).forEach((index) => ask(candidates[index].key));
    },
    request(candidate, box, priority) {
      ask(candidate.key);
      requests.push([candidate.key, priority]);
    },
    /** Settle every requested key still unknown, as the loader would. */
    probeRequested(status = 'present') {
      for (const key of requested)
        if (!statuses.has(key)) this.probe(key, status);
    },
    clear() {
      calls.push(['clear']);
    },
    get: (key) => ({ status: statuses.get(key) || 'unknown' }),
    /** Record a probe result and tell the layer, as the loader does. */
    probe(key, status) {
      statuses.set(key, status);
      for (const listener of listeners) listener(key);
    },
    /** Record a probe result without telling anyone yet. */
    setStatus: (key, status) => statuses.set(key, status),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      calls.push(['destroy']);
    },
  };
}

export function fakeCatalog() {
  const searches = [];
  return {
    searches,
    searchHls(request) {
      return new Promise((resolve, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
        searches.push({ request, resolve, reject });
      });
    },
    resolveLast(candidates = CANDIDATES) {
      searches.at(-1).resolve({ candidates, truncated: false, errors: [] });
    },
  };
}

/** A map controller whose lease settles when the test says so. */
export function fakeController({ refuse = false } = {}) {
  const calls = [];
  const controller = {
    calls,
    acquireImageryComparison(options) {
      calls.push(['acquire', options.owner, options.switchPolicy]);
      if (refuse) throw new Error('held by bhote');
      let settle;
      const ready = new Promise((resolve) => {
        settle = resolve;
      });
      controller.lease = {
        ready,
        release: () => {
          calls.push(['release']);
          return Promise.resolve();
        },
        settle: (result = { status: 'ready' }) => settle(result),
      };
      return controller.lease;
    },
  };
  return controller;
}
