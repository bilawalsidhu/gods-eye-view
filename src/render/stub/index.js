/**
 * @module render/stub
 * @description A renderer that draws nothing: every port of the contract in
 * memory, with exact camera poses, a scripted clock, picks against what was
 * drawn (or a scripted table), scripted heights, and a log of calls.
 *
 * Tests across Core use it in place of a real renderer, and the conformance
 * suite runs against it, so the stub is itself checked against the contract.
 * Nothing runs on its own: `testing.tick()` and `testing.advance()` drive the
 * loop on a virtual clock, one frame at a time, in the contract's order.
 */
import { CAPABILITIES, CONTRACT_VERSION } from '../contract/index.js';
import { createStubCamera } from './camera.js';
import { motionPosition } from './motion.js';
import { orbitPosition } from './orbits.js';
import { computeViewRectangle } from './viewRectangle.js';
import {
  add,
  dot,
  magnitude,
  normalize,
  scale,
  sub,
  toCartographicRadians,
  toDegrees,
  toEcef,
  vec,
  WGS84,
} from './math.js';

const FRAME_MS = 1000 / 60;

/** Every setting the stub accepts, with its descriptor. */
const KNOBS = Object.freeze([
  { key: 'pixelRatio', kind: 'number', min: 0, max: 4, default: 0, cost: 1 },
  { key: 'msaa', kind: 'enum', options: [0, 2, 4, 8], default: 4, cost: 0.4 },
  {
    key: 'tiles3dDetail',
    kind: 'number',
    min: 0,
    max: 1,
    default: 1,
    cost: 0.8,
    couples: ['lower detail lowers height accuracy'],
  },
  {
    key: 'terrainDetail',
    kind: 'number',
    min: 0,
    max: 1,
    default: 1,
    cost: 0.4,
  },
  {
    key: 'imageryDetail',
    kind: 'number',
    min: 0,
    max: 1,
    default: 1,
    cost: 0.3,
  },
  { key: 'particles', kind: 'number', min: 0, max: 1, default: 1, cost: 0.3 },
  { key: 'targetFps', kind: 'number', min: 0, max: 240, default: 0, cost: 0.2 },
]);

function uncaught(error) {
  if (typeof globalThis.reportError === 'function')
    globalThis.reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}

/**
 * @param {object} [options]
 * @param {Iterable<import('../contract/common').Capability>} [options.capabilities] Default: all.
 * @param {{width: number, height: number}} [options.viewport] CSS size; default 1280 × 720.
 * @param {number} [options.time] Scene time, epoch ms.
 * @returns {import('../contract/renderer').Renderer & {testing: StubTesting}}
 */
export function createStubRenderer(options = {}) {
  const capabilities = new Set(options.capabilities ?? CAPABILITIES);
  const viewport = { width: 1280, height: 720, ...(options.viewport ?? {}) };
  const calls = [];
  const log = (port, member, args) => calls.push({ port, member, args });
  const rendererListeners = { error: [], contextLost: [], contextRestored: [] };

  let clock = 0;
  let sceneTime = options.time ?? Date.UTC(2026, 0, 1);
  // Wall time is the virtual clock from a fixed epoch, so live motion is scripted too.
  const wallEpoch = options.wallTime ?? Date.UTC(2026, 0, 1);
  const wallTime = () => wallEpoch + clock;
  let frameCount = 0;
  let rendered = 0;
  let suspended = false;
  let targetFps = 0;
  let destroyed = false;
  const pendingReasons = [];
  const continuous = new Map();
  let holdSeq = 0;
  const phaseListeners = { preUpdate: [], preRender: [], postRender: [] };
  const onceWaiters = [];
  const onceTimers = new Set();
  const stepLog = [];

  /**
   * Hands a listener's throw to the `error` listeners. With none, it goes to
   * the platform's `reportError` (or is rethrown on a microtask), as a
   * browser reports an event listener's exception: loud, but the frame and
   * the other listeners carry on.
   */
  function report(error) {
    const errorListeners = rendererListeners.error;
    if (!errorListeners.length) return uncaught(error);
    for (const entry of errorListeners.slice()) {
      // One removed during delivery does not run, as everywhere.
      if (!entry.live) continue;
      try {
        entry.cb(error);
      } catch (thrown) {
        uncaught(thrown);
      }
    }
  }

  /**
   * Calls each listener in `list` (callbacks, or `{cb, live}` entries) with
   * the contract's rules: one removed during delivery does not run, one
   * added during delivery waits for the next event, and one that throws is
   * reported while the rest still run.
   */
  function deliver(list, ...args) {
    for (const entry of list.slice()) {
      const fn = typeof entry === 'function' ? entry : entry.cb;
      if (typeof entry === 'function' ? !list.includes(entry) : !entry.live)
        continue;
      try {
        fn(...args);
      } catch (error) {
        report(error);
      }
    }
  }

  function requestRender(reason) {
    if (!pendingReasons.includes(reason)) pendingReasons.push(reason);
  }

  const camera = createStubCamera({
    viewport: () => viewport,
    now: () => clock,
    sceneTime: () => sceneTime,
    requestRender,
    report,
    drawnPosition: (ref, aheadMs) => drawnPosition(ref, aheadMs),
  });
  camera.setViewRectangle(viewRectangle);
  camera.port.setView({
    destination: { lon: -97.7431, lat: 30.2672, height: 15000000 },
  });
  pendingReasons.length = 0;

  // --- Frame -----------------------------------------------------------------

  function runPhase(phase, t) {
    deliver(phaseListeners[phase], t);
  }

  const signalListeners = [];

  function tick() {
    if (destroyed || suspended) return false;
    clock += FRAME_MS;
    frameCount += 1;
    stepLog.length = 0;
    const step = (name) => stepLog.push(name);
    step('flight');
    camera.steps.stepFlight();
    step('input');
    step('changed');
    camera.steps.stepChanged();
    step('follow');
    camera.steps.stepFollow();
    const rendering = pendingReasons.length > 0 || continuous.size > 0;
    const t = {
      frame: frameCount,
      time: sceneTime,
      now: clock,
      dt: FRAME_MS / 1000,
      rendering,
    };
    step('preUpdate');
    runPhase('preUpdate', t);
    step('moveDetection');
    camera.steps.stepMoveDetection();
    if (!rendering) return false;
    const requested = pendingReasons.length > 0;
    pendingReasons.length = 0;
    step('preRender');
    runPhase('preRender', t);
    step('render');
    rendered += 1;
    step('postRender');
    runPhase('postRender', t);
    for (const waiter of onceWaiters.splice(0)) waiter();
    const signals = {
      cpuMs: 0,
      pixelRatio: qualitySettings.pixelRatio || 1,
      width: viewport.width,
      height: viewport.height,
      mode: 'demand',
      requested,
      holds: [...continuous.values()],
      drawCalls: sets.size,
    };
    deliver(signalListeners, signals);
    return true;
  }

  const frame = {
    on(phase, cb) {
      const entry = { cb, live: true };
      phaseListeners[phase].push(entry);
      return () => {
        entry.live = false;
        const list = phaseListeners[phase];
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
      };
    },
    requestRender(reason) {
      requestRender(String(reason));
    },
    holdContinuous(reason) {
      const key = ++holdSeq;
      continuous.set(key, String(reason));
      return () => continuous.delete(key);
    },
    mode: () => 'demand',
    diagnostics: () => ({
      mode: 'demand',
      frames: frameCount,
      rendered,
      pendingReasons: pendingReasons.slice(),
      holds: [...continuous.values()],
      suspended,
      targetFps,
    }),
    suspend(hidden) {
      suspended = Boolean(hidden);
    },
    renderNow() {
      requestRender('renderNow');
      tick();
    },
    renderOnce({ timeoutMs } = {}) {
      requestRender('renderOnce');
      return new Promise((resolve, reject) => {
        let timer = null;
        const waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        onceWaiters.push(waiter);
        if (timeoutMs !== undefined)
          timer = setTimeout(() => {
            const i = onceWaiters.indexOf(waiter);
            if (i >= 0) onceWaiters.splice(i, 1);
            reject(new Error('renderOnce timed out'));
          }, timeoutMs);
        onceTimers.add(() => clearTimeout(timer));
      });
    },
    setTargetFps(fps) {
      targetFps = fps;
    },
    setTime(ms) {
      sceneTime = ms;
      requestRender('time');
    },
    time: () => sceneTime,
  };

  // --- Draw ------------------------------------------------------------------

  /** @type {Map<string, {kind: string, spec: object, items: Map<string, object>, columns: object|null, show: boolean, ready: Function[]}>} */
  const sets = new Map();
  const atlases = new Map();

  function makeSet(kind, spec) {
    if (!spec?.id) throw new TypeError('A draw set needs an id');
    if (sets.has(spec.id))
      throw new Error(`Draw set ${spec.id} already exists`);
    const record = {
      kind,
      spec: { ...spec },
      items: new Map(),
      show: spec.show ?? true,
      readyListeners: [],
    };
    sets.set(spec.id, record);
    log('draw', kind, [spec]);
    const ready = (ids) => {
      if (kind !== 'models') return;
      for (const id of ids) deliver(record.readyListeners, id);
    };
    const handle = {
      id: spec.id,
      set(items) {
        record.items.clear();
        for (const item of items)
          record.items.set(String(item.id), { ...item });
        requestRender('draw');
        ready(items.map((item) => String(item.id)));
      },
      upsert(items) {
        for (const item of items)
          record.items.set(String(item.id), { ...item });
        requestRender('draw');
        ready(items.map((item) => String(item.id)));
      },
      remove(ids) {
        for (const id of ids) record.items.delete(String(id));
        requestRender('draw');
      },
      clear() {
        record.items.clear();
        requestRender('draw');
      },
      setOptions(patch) {
        Object.assign(record.spec, patch);
        if ('show' in patch) record.show = patch.show;
        requestRender('draw');
      },
      size: () => record.items.size,
      get show() {
        return record.show;
      },
      set show(value) {
        record.show = Boolean(value);
        requestRender('draw');
      },
      on(event, cb) {
        if (event !== 'ready') return () => {};
        const entry = { cb, live: true };
        record.readyListeners.push(entry);
        return () => {
          entry.live = false;
        };
      },
      dispose() {
        // A newer set under the same id is not this handle's to remove.
        if (sets.get(spec.id) === record) sets.delete(spec.id);
        requestRender('draw');
      },
    };
    if (capabilities.has('columns'))
      // Columns become rows like any other, so remove, size and picks see them.
      handle.setColumns = (columns) => {
        const next = new Map();
        columns.ids.forEach((id, i) => {
          const key = String(id);
          const row = { ...(record.items.get(key) ?? { id: key }) };
          const p = columns.positions;
          if (p) row.pos = vec(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
          if (columns.courses) row.course = columns.courses[i];
          if (columns.shown) row.show = columns.shown[i] !== 0;
          if (columns.scales) row.scale = columns.scales[i];
          if (columns.alphas) row.alpha = columns.alphas[i];
          if (columns.colors)
            row.color = [0, 1, 2, 3].map(
              (k) => columns.colors[i * 4 + k] / 255,
            );
          if (columns.meta) row.meta = columns.meta[i];
          next.set(key, row);
        });
        record.items = next;
        requestRender('draw');
      };
    return handle;
  }

  function simpleHandle(kind, spec) {
    const record = {
      kind,
      spec: { ...spec },
      items: new Map(),
      show: true,
      readyListeners: [],
    };
    sets.set(spec.id, record);
    log('draw', kind, [spec]);
    requestRender('draw');
    const handle = {
      get show() {
        return record.show;
      },
      set show(value) {
        record.show = Boolean(value);
        requestRender('draw');
      },
      dispose() {
        // A newer set under the same id is not this handle's to remove.
        if (sets.get(spec.id) === record) sets.delete(spec.id);
        requestRender('draw');
      },
    };
    return handle;
  }

  const clampListeners = [];
  const draw = {
    icons: (spec) => makeSet('icons', spec),
    points: (spec) => makeSet('points', spec),
    lines: (spec) => makeSet('lines', spec),
    shapes: (spec) => makeSet('shapes', spec),
    atlas(id, images) {
      atlases.set(id, { ...images });
      log('draw', 'atlas', [id]);
    },
    // The stub drapes wherever it is asked to: it never falls back.
    clampState: () => 'draped',
    on(event, cb) {
      if (event !== 'clampState') return () => {};
      const entry = { cb, live: true };
      clampListeners.push(entry);
      return () => {
        entry.live = false;
        const i = clampListeners.indexOf(entry);
        if (i >= 0) clampListeners.splice(i, 1);
      };
    },
  };
  if (capabilities.has('models'))
    draw.models = (spec) => makeSet('models', spec);
  if (capabilities.has('quads')) draw.quads = (spec) => makeSet('quads', spec);
  if (capabilities.has('meshes'))
    draw.meshes = (spec) => makeSet('meshes', spec);
  if (capabilities.has('agents'))
    draw.agents = (spec) => makeSet('agents', spec);
  /** Parsed orbit elements, by line pair; cleared on destroy. */
  const satrecs = new Map();
  if (capabilities.has('orbits'))
    draw.orbits = (spec) => makeSet('orbits', spec);
  if (capabilities.has('fields'))
    draw.field = (spec) => {
      const handle = simpleHandle('field', spec);
      handle.update = (patch) => {
        Object.assign(sets.get(spec.id).spec, patch);
        requestRender('draw');
      };
      return handle;
    };
  if (capabilities.has('celestial'))
    draw.celestial = (spec) => simpleHandle('celestial', spec);

  // --- Query -----------------------------------------------------------------

  function eye() {
    return camera.eye();
  }

  function project(position) {
    const e = eye();
    const v = sub(position, e.position);
    const depth = dot(v, e.direction);
    if (depth <= 0) return null;
    const right = e.right;
    const tanPhi = Math.tan(e.fovy * 0.5);
    const tanTheta = e.aspectRatio * tanPhi;
    const x = dot(v, right) / (depth * tanTheta);
    const y = dot(v, e.up) / (depth * tanPhi);
    return {
      x: ((x + 1) / 2) * viewport.width,
      y: ((1 - y) / 2) * viewport.height,
    };
  }

  function pickRay(x, y) {
    const e = eye();
    const tanPhi = Math.tan(e.fovy * 0.5);
    const tanTheta = e.aspectRatio * tanPhi;
    const nx = (2 / viewport.width) * x - 1;
    const ny = (2 / viewport.height) * (viewport.height - y) - 1;
    const near = e.near;
    const target = add(
      add(
        add(e.position, scale(e.direction, near)),
        scale(e.right, nx * near * tanTheta),
      ),
      scale(e.up, ny * near * tanPhi),
    );
    return {
      origin: e.position,
      direction: normalize(sub(target, e.position)),
    };
  }

  /** Nearest hit of a ray on the ellipsoid. */
  function rayEllipsoid(ray) {
    const r = WGS84.oneOverRadii;
    const q = vec(ray.origin.x * r.x, ray.origin.y * r.y, ray.origin.z * r.z);
    const w = vec(
      ray.direction.x * r.x,
      ray.direction.y * r.y,
      ray.direction.z * r.z,
    );
    const a = dot(w, w);
    const b = 2 * dot(q, w);
    const c = dot(q, q) - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t0 = (-b - sq) / (2 * a);
    const t1 = (-b + sq) / (2 * a);
    const t = t0 >= 0 ? t0 : t1 >= 0 ? t1 : null;
    if (t === null) return null;
    return add(ray.origin, scale(ray.direction, t));
  }

  function isOccluded(position) {
    const e = eye();
    const r = WGS84.oneOverRadii;
    const cv = vec(e.position.x * r.x, e.position.y * r.y, e.position.z * r.z);
    const vh = dot(cv, cv) - 1;
    const t = vec(position.x * r.x, position.y * r.y, position.z * r.z);
    const vt = sub(t, cv);
    const vtDotVc = -dot(vt, cv);
    if (vh < 0) return vtDotVc > 0;
    return vtDotVc > vh && (vtDotVc * vtDotVc) / dot(vt, vt) > vh;
  }

  let scriptedPicks = null;
  const heightCache = new Map();
  let heightSource = null;
  const cacheKey = (p, against = 'surface') =>
    `${against}:${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;

  /** The time a set's motion segments are evaluated at. */
  function motionTime(set) {
    const clockSpec = set.spec.motionClock;
    return clockSpec?.kind === 'scene'
      ? sceneTime
      : wallTime() - (clockSpec?.delayMs ?? 0);
  }

  function itemPosition(set, item, aheadMs = 0) {
    if (set.kind === 'orbits')
      return item.tle
        ? orbitPosition(satrecs, item.tle, motionTime(set) + aheadMs)
        : null;
    if (!item.pos) return null;
    const base = toEcef(item.pos);
    if (
      set.kind === 'icons' &&
      item.motion &&
      capabilities.has('motionSegments')
    )
      return motionPosition(item.motion, base, motionTime(set) + aheadMs);
    return base;
  }

  /** Where a drawn item is now (or `aheadMs` from now), or null. */
  function drawnPosition(ref, aheadMs = 0) {
    const set = sets.get(ref.set);
    const item = set?.items.get(String(ref.id));
    return set && item ? itemPosition(set, item, aheadMs) : null;
  }

  function hitsAt(x, y, win = {}) {
    if (scriptedPicks) return scriptedPicks(x, y, win) ?? [];
    const halfW = (win.width ?? 3) / 2;
    const halfH = (win.height ?? 3) / 2;
    const hits = [];
    for (const [setId, set] of sets) {
      if (!set.show || set.spec.pickable === false) continue;
      if (
        set.kind !== 'icons' &&
        set.kind !== 'points' &&
        set.kind !== 'models' &&
        set.kind !== 'orbits'
      )
        continue;
      for (const item of set.items.values()) {
        if (item.show === false || item.pickable === false) continue;
        const p = itemPosition(set, item);
        if (!p || isOccluded(p)) continue;
        if (item.displayRange) {
          const distance = magnitude(sub(p, eye().position));
          const [nearM, farM] = item.displayRange;
          if (distance < nearM || distance >= farM) continue;
        }
        const s = project(p);
        if (!s) continue;
        const pixel = item.pixelSize ?? item.marker?.pixelSize ?? 10;
        const size = item.pickProxy?.size ??
          item.size ??
          item.marker?.size ?? [pixel, pixel];
        if (
          Math.abs(s.x - x) <= size[0] / 2 + halfW &&
          Math.abs(s.y - y) <= size[1] / 2 + halfH
        )
          hits.push({
            set: setId,
            id: item.id,
            meta: item.meta,
            ...(item.lodGroup !== undefined ? { lodGroup: item.lodGroup } : {}),
            surface: false,
            position: p,
            depth: magnitude(sub(p, eye().position)),
          });
      }
    }
    hits.sort((a, b) => a.depth - b.depth);
    for (const hit of hits) delete hit.depth;
    return hits;
  }

  function surfaceHit(x, y) {
    const position = rayEllipsoid(pickRay(x, y));
    return position
      ? { set: '', id: '', meta: undefined, surface: true, position }
      : null;
  }

  /**
   * The geodetic box of the ellipsoid under the screen's border, or null
   * when any of the border looks past the globe. A pole in view widens it to
   * that pole and every longitude.
   */
  function viewRectangle() {
    return computeViewRectangle(camera.port.pose(), viewport, (x, y) =>
      rayEllipsoid(pickRay(x, y)),
    );
  }

  function lookupHeight(point, against) {
    const key = cacheKey(point, against);
    if (heightCache.has(key)) return heightCache.get(key);
    if (heightSource) return heightSource(point, against);
    return null;
  }

  const query = {
    pick(x, y, win) {
      return hitsAt(x, y, win)[0] ?? surfaceHit(x, y);
    },
    drillPick(x, y, opts = {}) {
      const hits = hitsAt(x, y, opts);
      return opts.limit === undefined ? hits : hits.slice(0, opts.limit);
    },
    pickPosition(x, y) {
      if (!capabilities.has('pickPosition')) return null;
      return rayEllipsoid(pickRay(x, y));
    },
    pickEllipsoid: (x, y) => rayEllipsoid(pickRay(x, y)),
    pickGlobe: (ray) => rayEllipsoid(ray),
    pickRay,
    project,
    projectMany(source, out) {
      for (let i = 0, j = 0; i + 2 < source.length; i += 3, j += 2) {
        const s = project(vec(source[i], source[i + 1], source[i + 2]));
        out[j] = s ? s.x : NaN;
        out[j + 1] = s ? s.y : NaN;
      }
    },
    isOccluded,
    sampleHeightNow(point, opts = {}) {
      if (!capabilities.has('sampleHeight')) return null;
      const key = cacheKey(point, opts.against);
      return heightCache.has(key) ? heightCache.get(key) : null;
    },
    sampleHeightNowMany(points, out, opts = {}) {
      for (let i = 0; i < out.length; i++) {
        const height = query.sampleHeightNow(
          { lon: points[i * 2], lat: points[i * 2 + 1] },
          opts,
        );
        out[i] = height ?? NaN;
      }
    },
    async sampleHeight(points, opts = {}) {
      if (!capabilities.has('sampleHeight')) return points.map(() => null);
      return points.map((point) => {
        const height = lookupHeight(point, opts.against);
        if (height === null || height === undefined) return null;
        heightCache.set(cacheKey(point, opts.against), height);
        const lod =
          opts.mostDetailed && capabilities.has('finestHeights')
            ? 'finest'
            : 'visible';
        return { height, confidence: 1, source: 'terrain', lod };
      });
    },
    async clampToSurface(positions, opts = {}) {
      const points = positions.map((p) => {
        const c = toCartographicRadians(p);
        return { lon: toDegrees(c.lon), lat: toDegrees(c.lat) };
      });
      const samples = await query.sampleHeight(points, opts);
      return samples.map((sample, i) =>
        sample ? toEcef({ ...points[i], height: sample.height }) : null,
      );
    },
    async rayCast(ray) {
      if (!capabilities.has('rayCast')) return null;
      return rayEllipsoid(ray);
    },
  };

  // --- Input -----------------------------------------------------------------

  const pointerListeners = [];
  let currentLease = null;
  const cameraHolds = new Map();
  const behaviourHolds = { select: 0, dblclickFollow: 0 };

  function makeBehaviour(name) {
    return {
      get enabled() {
        return behaviourHolds[name] === 0;
      },
      suppress() {
        behaviourHolds[name] += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          behaviourHolds[name] -= 1;
        };
      },
    };
  }

  const leaseOf = (entry) =>
    typeof entry.lease === 'function' ? entry.lease() : entry.lease;

  const input = {
    on(type, cb, opts = {}) {
      const entry = { type, cb, lease: opts.lease ?? null, live: true };
      pointerListeners.push(entry);
      return () => {
        entry.live = false;
        const i = pointerListeners.indexOf(entry);
        if (i >= 0) pointerListeners.splice(i, 1);
      };
    },
    claimPointer(owner) {
      if (currentLease) currentLease.release();
      let released = false;
      const lease = {
        owner: String(owner),
        get current() {
          return !released && currentLease === lease;
        },
        release() {
          if (released) return;
          released = true;
          if (currentLease === lease) currentLease = null;
        },
      };
      currentLease = lease;
      return lease;
    },
    isPointerFree: () => currentLease === null,
    suspendCameraControls(reason) {
      return camera.port.controls.suspend(String(reason));
    },
    behaviours: {
      select: makeBehaviour('select'),
      dblclickFollow: makeBehaviour('dblclickFollow'),
    },
    ctrlWheelZoom: false,
  };

  function dispatchPointer(type, x, y, extra = {}) {
    const free = currentLease === null;
    let picked;
    const ev = {
      type,
      position: { x, y },
      button: extra.button ?? 0,
      modifiers: {
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
        ...(extra.modifiers ?? {}),
      },
      timestamp: clock,
      pointerType: extra.pointerType ?? 'mouse',
      ...(extra.endPosition ? { endPosition: extra.endPosition } : {}),
      ...(extra.delta !== undefined ? { delta: extra.delta } : {}),
    };
    if (type === 'click' || type === 'dblclick') {
      ev.gesture = extra.gesture ?? { travelPx: 0, durationMs: 120 };
      const hits = () => (picked ??= hitsAt(x, y));
      ev.pick = () => hits()[0] ?? surfaceHit(x, y);
      ev.drill = (opts = {}) =>
        opts.limit === undefined ? hits().slice() : hits().slice(0, opts.limit);
      ev.ground = () => rayEllipsoid(pickRay(x, y));
    }
    const ambientAlways = type === 'move' || type === 'up';
    for (const entry of pointerListeners.slice()) {
      if (!entry.live || entry.type !== type) continue;
      if (entry.lease) {
        const lease = leaseOf(entry);
        if (!lease?.current) continue;
      } else if (!free && !ambientAlways) continue;
      try {
        entry.cb(ev);
      } catch (error) {
        report(error);
      }
    }
    requestRender('input');
  }

  // --- Globe -----------------------------------------------------------------

  const imageryLayers = [];
  let split = 0.5;
  let imageryHost = 'globe';
  const hostListeners = [];
  const progressListeners = [];
  const settled = { base: true, tiles: true, terrain: true, imagery: true };
  let sky = {
    atmosphere: true,
    stars: true,
    milkyWay: 0.5,
    sun: true,
    moon: true,
    fog: true,
    lighting: false,
    ...(options.sky ?? {}),
  };
  let photorealStatus = { route: 'none' };

  function addImagery(spec, index) {
    const listeners = { frameReady: [], tileError: [] };
    const layer = {
      spec: { ...spec },
      alpha: 1,
      show: true,
      split: 'none',
      drapeOn: 'active',
      on(event, cb) {
        listeners[event]?.push(cb);
        return () => {
          const list = listeners[event] ?? [];
          const i = list.indexOf(cb);
          if (i >= 0) list.splice(i, 1);
        };
      },
      raise() {
        const i = imageryLayers.indexOf(layer);
        if (i >= 0 && i < imageryLayers.length - 1) {
          imageryLayers.splice(i, 1);
          imageryLayers.splice(i + 1, 0, layer);
        }
        requestRender('imagery');
      },
      lower() {
        const i = imageryLayers.indexOf(layer);
        if (i > 0) {
          imageryLayers.splice(i, 1);
          imageryLayers.splice(i - 1, 0, layer);
        }
        requestRender('imagery');
      },
      remove() {
        const i = imageryLayers.indexOf(layer);
        if (i >= 0) imageryLayers.splice(i, 1);
        requestRender('imagery');
      },
    };
    if (capabilities.has('imageryFrames')) {
      let frames = [];
      layer.setFrames = (list) => {
        frames = list.slice();
      };
      layer.setFrameTime = (ms) => {
        const nearest = frames.reduce(
          (best, f) =>
            !best || Math.abs(f.time - ms) < Math.abs(best.time - ms)
              ? f
              : best,
          null,
        );
        if (nearest) deliver(listeners.frameReady, nearest.time);
      };
    }
    if (index === undefined) imageryLayers.push(layer);
    else imageryLayers.splice(index, 0, layer);
    log('globe', 'imagery.add', [spec, index]);
    requestRender('imagery');
    return layer;
  }

  const globe = {
    async setBase(base) {
      log('globe', 'setBase', [base]);
      for (const layer of imageryLayers.splice(0)) void layer;
      if (base.photoreal !== undefined)
        await globe.setPhotoreal(base.photoreal);
      const layers = (base.imagery ?? []).map((spec) => addImagery(spec));
      return { photoreal: photorealStatus, imagery: layers, settled: true };
    },
    async setPhotoreal(spec) {
      log('globe', 'setPhotoreal', [spec]);
      photorealStatus =
        spec && capabilities.has('photoreal')
          ? { route: 'google' }
          : { route: 'none' };
      const next = photorealStatus.route === 'none' ? 'globe' : 'tiles';
      if (next !== imageryHost) {
        imageryHost = next;
        deliver(hostListeners, next);
      }
      requestRender('base');
      return photorealStatus;
    },
    async setTerrain(spec) {
      log('globe', 'setTerrain', [spec]);
      requestRender('base');
    },
    setGlobeVisible(visible) {
      log('globe', 'setGlobeVisible', [visible]);
      requestRender('base');
    },
    imagery: {
      add: addImagery,
      list: () => imageryLayers.slice(),
      host: () => imageryHost,
      onHostChange(cb) {
        hostListeners.push(cb);
        return () => {
          const i = hostListeners.indexOf(cb);
          if (i >= 0) hostListeners.splice(i, 1);
        };
      },
    },
    sky: {
      get: () => ({ ...sky }),
      set(patch) {
        sky = { ...sky, ...patch };
        requestRender('sky');
      },
    },
    isSettled: (kind) => settled[kind] ?? true,
    on(event, cb) {
      if (event !== 'progress') return () => {};
      progressListeners.push(cb);
      return () => {
        const i = progressListeners.indexOf(cb);
        if (i >= 0) progressListeners.splice(i, 1);
      };
    },
  };
  if (capabilities.has('surfaceShading'))
    globe.setSurfaceShading = (shading) => {
      log('globe', 'setSurfaceShading', [shading]);
      requestRender('base');
    };
  if (capabilities.has('splitSwipe')) {
    globe.imagery.getSplit = () => split;
    globe.imagery.setSplit = (x01) => {
      split = Math.min(1, Math.max(0, x01));
      requestRender('imagery');
    };
  }

  // --- Effects, credits, quality ---------------------------------------------

  const effectState = {
    style: null,
    params: {},
    intensity: {},
    bloom: null,
    sharpen: null,
    modulation: null,
  };
  const effectListeners = [];
  const STYLES = Object.freeze([
    {
      id: 'retro',
      params: [{ key: 'grain', min: 0, max: 1, default: 0.5 }],
      animated: true,
    },
    { id: 'thermal', params: [], animated: false },
  ]);
  function effectsChanged() {
    const d = effects.diagnostics();
    deliver(effectListeners, d);
    requestRender('effects');
  }
  const effects = {
    styles: () =>
      capabilities.has('styles') ? STYLES.map((s) => ({ ...s })) : [],
    setStyle(id, params) {
      effectState.style = id;
      if (params) effectState.params[id] = { ...params };
      effectsChanged();
    },
    setStyleIntensity(id, value) {
      effectState.intensity[id] = value;
      effectsChanged();
    },
    setStyleParams(id, params) {
      effectState.params[id] = { ...(effectState.params[id] ?? {}), ...params };
      effectsChanged();
    },
    bloom(settings) {
      effectState.bloom = capabilities.has('bloom') ? { ...settings } : null;
      effectsChanged();
    },
    sharpen(settings) {
      effectState.sharpen = capabilities.has('sharpen')
        ? { ...settings }
        : null;
      effectsChanged();
    },
    diagnostics: () => ({
      style: effectState.style,
      passes: [
        ...(effectState.style ? [`style:${effectState.style}`] : []),
        ...(effectState.bloom?.enabled ? ['bloom'] : []),
        ...(effectState.sharpen?.enabled ? ['sharpen'] : []),
        ...(effectState.modulation ? ['modulation'] : []),
      ],
    }),
    on(event, cb) {
      if (event !== 'change') return () => {};
      effectListeners.push(cb);
      return () => {
        const i = effectListeners.indexOf(cb);
        if (i >= 0) effectListeners.splice(i, 1);
      };
    },
  };
  if (capabilities.has('screenModulation'))
    effects.screenModulation = (sector) => {
      effectState.modulation = sector ? { ...sector } : null;
      effectsChanged();
    };

  const creditList = [];
  const creditListeners = [];
  const creditsChanged = () => {
    const list = creditList.map((c) => ({ ...c }));
    deliver(creditListeners, list);
  };
  const credits = {
    addStatic(credit) {
      const entry = { ...credit };
      creditList.push(entry);
      creditsChanged();
      return () => {
        const i = creditList.indexOf(entry);
        if (i < 0) return;
        creditList.splice(i, 1);
        creditsChanged();
      };
    },
    list: () => creditList.map((c) => ({ ...c })),
    on(event, cb) {
      if (event !== 'change') return () => {};
      creditListeners.push(cb);
      return () => {
        const i = creditListeners.indexOf(cb);
        if (i >= 0) creditListeners.splice(i, 1);
      };
    },
  };

  const qualitySettings = Object.fromEntries(
    KNOBS.map((k) => [k.key, k.default]),
  );
  const device = () => ({
    backend: 'webgl2',
    maxTextureSize: 16384,
    msaaSamples: [0, 2, 4, 8],
    gpuTimer: capabilities.has('gpuTiming'),
  });
  const quality = {
    knobs: () => KNOBS.map((k) => ({ ...k })),
    get: () => ({ ...qualitySettings }),
    set(patch) {
      const ignored = [];
      for (const [key, value] of Object.entries(patch)) {
        if (key in qualitySettings) qualitySettings[key] = value;
        else ignored.push(key);
      }
      requestRender('quality');
      return ignored;
    },
    device,
    probe: () => ({
      device: device(),
      browser: {
        devicePixelRatio: 1,
        screen: { width: viewport.width, height: viewport.height },
        touchOnly: false,
      },
      knobs: quality.knobs(),
    }),
    signals: {
      gpuTiming: capabilities.has('gpuTiming') ? 'frame' : 'none',
      on(event, cb) {
        const entry = { cb, live: true };
        if (event === 'frame') signalListeners.push(entry);
        return () => {
          entry.live = false;
          const i = signalListeners.indexOf(entry);
          if (i >= 0) signalListeners.splice(i, 1);
        };
      },
    },
  };
  if (capabilities.has('benchmark'))
    quality.benchmark = async ({ durationMs }) => ({
      frames: Math.round(durationMs / FRAME_MS),
      cpuMs: { median: 0, p95: 0 },
    });

  // --- Renderer --------------------------------------------------------------

  const canvas = /** @type {HTMLCanvasElement} */ (
    /** @type {unknown} */ ({
      width: viewport.width,
      height: viewport.height,
      clientWidth: viewport.width,
      clientHeight: viewport.height,
    })
  );

  const renderer = {
    id: 'stub',
    contractVersion: CONTRACT_VERSION,
    capabilities,
    canvas,
    frame,
    globe,
    draw,
    camera: camera.port,
    query,
    input,
    effects,
    credits,
    quality,
    async capture(opts = {}) {
      return new Blob([], { type: `image/${opts.type ?? 'png'}` });
    },
    readPixels(opts = {}) {
      const width = Math.round(
        (opts.crop?.width ?? viewport.width) * (opts.scale ?? 1),
      );
      const height = Math.round(
        (opts.crop?.height ?? viewport.height) * (opts.scale ?? 1),
      );
      return /** @type {ImageData} */ (
        /** @type {unknown} */ ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        })
      );
    },
    async whenSettled() {
      const blockers = Object.keys(settled).filter((kind) => !settled[kind]);
      return { state: blockers.length ? 'timeout' : 'settled', blockers };
    },
    resize() {
      requestRender('resize');
    },
    releaseUnused() {
      log('renderer', 'releaseUnused', []);
    },
    on(event, cb) {
      const list = rendererListeners[event];
      if (!list) return () => {};
      // Each subscription is its own entry, so one callback subscribed
      // again during delivery waits for the next event like any other.
      const entry = { cb, live: true };
      list.push(entry);
      return () => {
        entry.live = false;
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
      };
    },
    destroy() {
      // A flight in progress ends cancelled and gives back its input hold.
      camera.endFlight();
      destroyed = true;
      for (const clear of onceTimers) clear();
      onceTimers.clear();
      sets.clear();
      satrecs.clear();
    },
    testing: {
      /** Run one frame of the loop; true when it drew. */
      tick,
      /** Run frames until `ms` of the clock has passed. */
      advance(ms) {
        // By frame count: a suspended or destroyed loop does not move the clock.
        const frames = Math.floor(ms / FRAME_MS + 1e-9);
        let drew = 0;
        for (let i = 0; i < frames; i++) if (tick()) drew += 1;
        return drew;
      },
      /** Run frames until a condition holds, at most `maxFrames`. */
      until(condition, maxFrames = 10000) {
        for (let i = 0; i < maxFrames; i++) {
          if (condition()) return i;
          tick();
        }
        throw new Error('condition not met');
      },
      now: () => clock,
      /** Wall time, epoch ms: what a set's `live` motion clock reads before its delay. */
      wallTime,
      /** The steps of the last frame, in order. */
      lastSteps: () => stepLog.slice(),
      /** A pointer event at `(x, y)`. */
      pointer: dispatchPointer,
      /** Answer picks from a function instead of the drawn items. */
      scriptPicks(fn) {
        scriptedPicks = fn;
      },
      /** Heights: a function answering async samples, and cached values. */
      setHeights(fn) {
        heightSource = fn;
      },
      /** A cached height, against `against` (default `'surface'`). */
      cacheHeight(point, height, against) {
        heightCache.set(cacheKey(point, against), height);
      },
      setSettled(kind, value) {
        settled[kind] = value;
      },
      setViewport(size) {
        Object.assign(viewport, size);
        canvas.width = viewport.width;
        canvas.height = viewport.height;
      },
      /** What a set holds. */
      setRecord: (id) => sets.get(id) ?? null,
      sets: () => [...sets.keys()],
      calls,
      effects: () => ({ ...effectState }),
      emitError: (error) => report(error),
    },
  };
  return renderer;
}

/**
 * @typedef {object} StubTesting
 * @property {() => boolean} tick
 * @property {(ms: number) => number} advance
 * @property {(condition: () => boolean, maxFrames?: number) => number} until
 * @property {() => number} now
 * @property {() => string[]} lastSteps
 * @property {(type: string, x: number, y: number, extra?: object) => void} pointer
 * @property {(fn: ((x: number, y: number, win: object) => object[])|null) => void} scriptPicks
 * @property {(fn: ((point: object, against?: string) => number|null)|null) => void} setHeights
 * @property {(point: object, height: number) => void} cacheHeight
 * @property {(kind: string, value: boolean) => void} setSettled
 * @property {(size: {width?: number, height?: number}) => void} setViewport
 * @property {(id: string) => object|null} setRecord
 * @property {() => string[]} sets
 * @property {Array<{port: string, member: string, args: unknown[]}>} calls
 * @property {() => object} effects
 * @property {(error: Error) => void} emitError
 */
