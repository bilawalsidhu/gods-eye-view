/**
 * Test doubles shared by the Recent Imagery tests: manual timers, fetch
 * responses, and the engine and document fakes the box tool needs.
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

/** A DOM event target that keeps its listeners by type. */
function eventTarget(extra = {}) {
  const listeners = [];
  return {
    listeners,
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex(
        (entry) => entry[0] === type && entry[1] === fn,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(type, event) {
      for (const [name, fn] of [...listeners]) if (name === type) fn(event);
      return event;
    },
    ...extra,
  };
}

/** A pointer or key event that records whether it was consumed. */
function domEvent(fields) {
  return {
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
    ...fields,
  };
}

/**
 * Globe engine and document fakes for `initImageryBoxTool`. The canvas is
 * 1000 × 500 px mapped linearly onto 0.2° near Austin; y < 40 px is sky.
 * The engine input counts camera-input suspensions.
 */
export function boxToolFakes() {
  const camera = {
    choice: true,
    suspended: 0,
    get inputs() {
      return camera.choice && camera.suspended === 0;
    },
  };
  const captured = new Set();
  const canvas = eventTarget({
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: (id) => captured.add(id),
    hasPointerCapture: (id) => captured.has(id),
    releasePointerCapture: (id) => captured.delete(id),
  });
  const input = {
    cameraInputsEnabled: () => camera.inputs,
    suspendCameraInputs() {
      camera.suspended += 1;
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        camera.suspended -= 1;
      };
    },
  };
  const engine = {
    host: { canvas, size: () => ({ width: 1000, height: 500 }) },
    input,
  };
  const windowRef = eventTarget();
  const classes = new Set();
  const documentRef = eventTarget({
    classes,
    defaultView: windowRef,
    body: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
    },
  });
  const pickWorld = (_engine, nx, ny) =>
    ny * 500 < 40 ? null : { lon: -97.9 + nx * 0.2, lat: 30.4 - ny * 0.2 };
  const pointer = (at, fields = {}) =>
    domEvent({
      button: 0,
      pointerId: 1,
      clientX: at.x,
      clientY: at.y,
      ...fields,
    });
  /** Pointer events as the browser sends them: a press on the canvas, moves and the release on the document. */
  const down = (at, fields) =>
    canvas.dispatch('pointerdown', pointer(at, fields));
  const move = (at, fields) =>
    documentRef.dispatch('pointermove', pointer(at, fields));
  const up = (at, fields) =>
    documentRef.dispatch('pointerup', pointer(at, fields));
  /** Dispatch a keydown to the tool's document listener. */
  const key = (name) =>
    documentRef.dispatch('keydown', domEvent({ key: name }));
  return {
    engine,
    canvas,
    camera,
    captured,
    documentRef,
    windowRef,
    pickWorld,
    down,
    move,
    up,
    key,
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
    resolveHost: () => ({ collection: {}, kind: 'globe' }),
    viewCentre: () => null,
    zoomToFit: () => false,
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
