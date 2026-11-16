/**
 * @module render/stub
 * @description A renderer that draws nothing: every port of the contract in
 * memory, with exact camera poses, a scripted clock, picks against what was
 * drawn (or a scripted table), scripted heights, and a log of calls.
 *
 * Tests across the repository use it in place of a real renderer, and the
 * conformance suite runs against it, so the stub is itself checked against the contract.
 * Nothing runs on its own: `testing.tick()` and `testing.advance()` drive the
 * loop on a virtual clock, one frame at a time, in the contract's order.
 */
import { horizonFrom } from '../../geo/horizon.js';
import { alongLength } from '../../geo/polyline.js';
import { clusterScreenPoints } from '../../geo/screenCluster.js';
import { createInputRouter } from '../input/router.js';
import { cssColor } from '../color.js';
import {
  recedeFactors,
  recedeFrame,
  recedeParams,
  recededAlpha,
} from '../recession.js';
import { CLEAR_WEATHER, mergeWeather } from '../weather.js';
import { CAPABILITIES, CONTRACT_VERSION } from '../contract/index.js';
import { createStubCamera } from './camera.js';
import { motionPosition } from '../motion/iconMotion.js';
import { computeViewRectangle } from './viewRectangle.js';
import { loadVectorStyle } from '../vectorBase/index.js';
import {
  add,
  dot,
  magnitude,
  normalize,
  rayEllipsoid,
  scale,
  sub,
  toCartographicRadians,
  toDegrees,
  toEcef,
  vec,
} from './math.js';

const FRAME_MS = 1000 / 60;

/**
 * Model urls under this scheme fail to load (`loadFailed`), so tests can
 * see a failure; the stub loads nothing, and every other url is a model.
 */
export const STUB_FAILING_MODEL_SCHEME = 'stub-fail:';

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

/** A distance curve's value at `distance`: held past each end. */
function nearFarValue(curve, distance) {
  if (distance <= curve.near) return curve.nearValue;
  if (distance >= curve.far) return curve.farValue;
  const t = (distance - curve.near) / (curve.far - curve.near);
  return curve.nearValue + (curve.farValue - curve.nearValue) * t;
}

function uncaught(error) {
  if (typeof globalThis.reportError === 'function')
    globalThis.reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}

/** Size the stub's viewport and its canvas to `size` (CSS pixels). */
function sizeCanvas(canvas, viewport, size) {
  Object.assign(viewport, size);
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  // A page's canvas measures itself; a stand-in reports the viewport.
  if (!canvas.ownerDocument) {
    canvas.clientWidth = viewport.width;
    canvas.clientHeight = viewport.height;
  }
}

/**
 * The stub's canvas: in a page (`container` given), a real canvas filling
 * the container, which the viewport follows; otherwise a stand-in that
 * takes event listeners and measures as the viewport does.
 */
function createCanvas(container, viewport) {
  const document = container?.ownerDocument;
  if (document) {
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    if (container.clientWidth > 0 && container.clientHeight > 0)
      Object.assign(viewport, {
        width: container.clientWidth,
        height: container.clientHeight,
      });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    return canvas;
  }
  const canvas = /** @type {HTMLCanvasElement} */ (
    /** @type {unknown} */ (
      Object.assign(new EventTarget(), {
        width: viewport.width,
        height: viewport.height,
        clientWidth: viewport.width,
        clientHeight: viewport.height,
        style: {},
        getBoundingClientRect: () => ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          width: viewport.width,
          height: viewport.height,
          right: viewport.width,
          bottom: viewport.height,
        }),
      })
    )
  );
  return canvas;
}

/**
 * @param {object} [options]
 * @param {Iterable<import('../contract/common').Capability>} [options.capabilities] Default: all.
 * @param {HTMLElement} [options.container] In a page: the element the stub's
 *   canvas fills, as a plugin's `CreateOptions.container`. Elsewhere, an
 *   object that says a size (`clientWidth`, `clientHeight`): `resize`
 *   follows it.
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
  // The frame under way while its `preUpdate` listeners run.
  let updating = null;
  const onceWaiters = [];
  const destroyedError = () => new Error('renderer destroyed');
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
    thresholds: capabilities.has('cameraChangeThreshold'),
    framing: capabilities.has('keepEarthFramed'),
  });
  camera.setViewRectangle(viewRectangle);
  if (capabilities.has('followFrame'))
    camera.port.followFrame = camera.eyeFrame;
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
    updating = t;
    try {
      runPhase('preUpdate', t);
    } finally {
      updating = null;
    }
    step('moveDetection');
    camera.steps.stepMoveDetection();
    if (!rendering) return false;
    const requested = pendingReasons.length > 0;
    pendingReasons.length = 0;
    step('preRender');
    runPhase('preRender', t);
    step('render');
    for (const set of sets.values()) clusterPass(set);
    rendered += 1;
    // A frame each timed layer was asked to show is now drawn.
    for (const [layer, flush] of [...frameFlushes])
      if (frameFlushes.get(layer) === flush) flush();
    // The imagery added since the last frame is drawn: loaded.
    if (imageryLoading > 0) {
      imageryLoading = 0;
      announceProgress();
    }
    step('postRender');
    runPhase('postRender', t);
    for (const waiter of onceWaiters.splice(0)) waiter();
    const signals = {
      cpuMs: 0,
      ...(capabilities.has('gpuTiming') ? { gpuMs: 0 } : {}),
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
    renderNow({ ifDue = false } = {}) {
      if (!ifDue) requestRender('renderNow');
      tick();
    },
    renderOnce({ timeoutMs } = {}) {
      if (destroyed) return Promise.reject(destroyedError());
      requestRender('renderOnce');
      return new Promise((resolve, reject) => {
        let timer = null;
        // Called with an error when the renderer is destroyed first.
        const waiter = (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
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
      const changed = ms !== sceneTime;
      sceneTime = ms;
      for (const show of [...sceneFrameLayers.values()]) show(ms);
      // In `preUpdate` the frame under way draws at it.
      if (updating) updating.time = ms;
      else if (changed) requestRender('time');
    },
    time: () => sceneTime,
  };

  // --- Draw ------------------------------------------------------------------

  /** @type {Map<string, {kind: string, spec: object, items: Map<string, object>, columns: object|null, show: boolean, ready: Function[]}>} */
  const sets = new Map();
  const atlases = new Map();

  let setSeq = 0;
  function makeSet(kind, spec) {
    if (!spec?.id) throw new TypeError('A draw set needs an id');
    if (sets.has(spec.id))
      throw new Error(`Draw set ${spec.id} already exists`);
    const record = {
      kind,
      spec: { ...spec },
      // When it was made: of sets of one `drawOrder`, the earlier is on top.
      seq: (setSeq += 1),
      items: new Map(),
      show: spec.show ?? true,
      readyListeners: [],
      loadFailedListeners: [],
    };
    sets.set(spec.id, record);
    log('draw', kind, [spec]);
    const gone = () => destroyed || sets.get(spec.id) !== record;
    // A model is ready once per load: when it is new or its url changes,
    // not when it is moved or restyled. One under the failing scheme fails
    // its load instead, unless it came with its bytes (`gltf`).
    // Each load is told once: a listener that starts another load of the
    // same item (or removes it) supersedes the one queued here.
    const loadTokens = new Map();
    const loads = (items) =>
      kind === 'models'
        ? items
            .filter(
              (item) => record.items.get(String(item.id))?.url !== item.url,
            )
            .map((item) => {
              const token = {};
              loadTokens.set(String(item.id), token);
              return [String(item.id), token];
            })
        : [];
    const ready = (loading) => {
      for (const [id, token] of loading) {
        if (loadTokens.get(id) !== token || !record.items.has(id)) continue;
        loadTokens.delete(id);
        const item = record.items.get(id);
        const url = String(item.url ?? '');
        // A model given its bytes is drawn from them: its url is not fetched.
        if (!item.gltf && url.startsWith(STUB_FAILING_MODEL_SCHEME))
          deliver(record.loadFailedListeners, id, `${url} does not load`);
        else deliver(record.readyListeners, id);
      }
    };
    const handle = {
      id: spec.id,
      set(items) {
        const loading = loads(items);
        record.items.clear();
        for (const item of items)
          record.items.set(String(item.id), { ...item });
        requestRender('draw');
        ready(loading);
      },
      upsert(items) {
        const loading = loads(items);
        for (const item of items)
          record.items.set(String(item.id), { ...item });
        requestRender('draw');
        ready(loading);
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
        const list =
          event === 'ready'
            ? record.readyListeners
            : event === 'loadFailed'
              ? record.loadFailedListeners
              : null;
        if (!list) return () => {};
        const entry = { cb, live: true };
        list.push(entry);
        return () => {
          entry.live = false;
        };
      },
      dispose() {
        // A newer set under the same id is not this handle's to remove.
        if (sets.get(spec.id) === record) sets.delete(spec.id);
        // Its listeners hear nothing more, even mid-delivery.
        for (const entry of record.readyListeners) entry.live = false;
        for (const entry of record.loadFailedListeners) entry.live = false;
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
    // A clustered set clusters again in the next frame drawn after a change.
    record.version = 0;
    for (const name of [
      'set',
      'upsert',
      'remove',
      'clear',
      'setOptions',
      'setColumns',
    ]) {
      const call = handle[name];
      if (!call) continue;
      handle[name] = (...args) => {
        // Disposed, or its renderer destroyed, it does nothing.
        if (gone()) return;
        record.version += 1;
        return call(...args);
      };
    }
    const { set: showSet } = Object.getOwnPropertyDescriptor(handle, 'show');
    Object.defineProperty(handle, 'show', {
      get: () => record.show,
      set(value) {
        if (!gone()) showSet.call(handle, value);
      },
      enumerable: true,
    });
    return handle;
  }

  /**
   * `cluster`: a clustered icon set's clusters as the last drawn frame made
   * them (`ClusterSpec`), made again where the camera moved or the set
   * changed since; null for a set that does not cluster.
   */
  function clusterPass(set) {
    if (
      set.kind !== 'icons' ||
      !set.spec.cluster ||
      !capabilities.has('cluster')
    ) {
      set.clusters = null;
      return;
    }
    const e = eye();
    const key = [
      set.version,
      e.position.x,
      e.position.y,
      e.position.z,
      e.direction.x,
      e.direction.y,
      e.direction.z,
      viewport.width,
      viewport.height,
    ].join(',');
    if (set.clusterKey === key) return;
    set.clusterKey = key;
    const points = [];
    for (const item of set.items.values()) {
      if (item.show === false) continue;
      const position = itemPosition(set, item);
      if (!position || isOccluded(position)) continue;
      const screen = project(position);
      if (!screen) continue;
      const [w = 0, h = 0] = item.size ?? [];
      points.push({
        id: item.id,
        position,
        screen,
        pixelSize: Math.max(w, h) * (item.scale ?? 1),
      });
    }
    const result = clusterScreenPoints({
      points,
      pixelRange: set.spec.cluster.pixelRange,
      minimumClusterSize: set.spec.cluster.minimumSize,
      viewHeight: viewport.height,
      eyeHeight: toCartographicRadians(e.position).height,
      previous: set.clusters?.state ?? null,
      project,
      isOccluded,
    });
    // Each cluster's icon is asked for, as a renderer drawing it would.
    for (const cluster of result.clusters)
      set.spec.cluster.icon?.(cluster.ids.length);
    set.clusters = {
      ...result,
      members: new Set(result.clusters.flatMap((c) => c.ids)),
    };
  }

  function simpleHandle(kind, spec) {
    const record = {
      kind,
      spec: { ...spec },
      // When it was made: of sets of one `drawOrder`, the earlier is on top.
      seq: (setSeq += 1),
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
  if (capabilities.has('fields'))
    draw.field = (spec) => {
      const handle = simpleHandle('field', spec);
      const record = sets.get(spec.id);
      // 'drawn': once the next render after the spec or an update has drawn
      // it, while it shows.
      const drawnListeners = [];
      let owed = true;
      const key = { field: spec.id };
      frameFlushes.set(key, () => {
        if (!owed || !record.show || sets.get(spec.id) !== record) return;
        owed = false;
        deliver(drawnListeners);
      });
      const dispose = handle.dispose;
      handle.dispose = () => {
        frameFlushes.delete(key);
        for (const entry of drawnListeners) entry.live = false;
        drawnListeners.length = 0;
        dispose();
      };
      handle.update = (patch) => {
        Object.assign(record.spec, patch);
        owed = true;
        requestRender('draw');
      };
      handle.on = (event, cb) => {
        if (event !== 'drawn') return () => {};
        const entry = { cb, live: true };
        drawnListeners.push(entry);
        return () => {
          entry.live = false;
          const i = drawnListeners.indexOf(entry);
          if (i >= 0) drawnListeners.splice(i, 1);
        };
      };
      return handle;
    };

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

  function isOccluded(position) {
    return !horizonFrom(eye().position).isPointVisible(position);
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
    if (!item.pos) return null;
    const base = toEcef(item.pos);
    const p =
      set.kind === 'icons' && item.motion && capabilities.has('motionSegments')
        ? motionPosition(item.motion, base, motionTime(set) + aheadMs)
        : base;
    // The stub's ground is the ellipsoid: a clamped icon stands on it, one
    // relative to it where it is.
    if (set.kind !== 'icons' || item.height !== 'clampGround' || !p) return p;
    const c = toCartographicRadians(p);
    return c
      ? toEcef({ lon: toDegrees(c.lon), lat: toDegrees(c.lat), height: 0 })
      : p;
  }

  /**
   * The shown models as the stub draws them: a square as wide as a pick
   * takes (at most `maxPixelSize`, at least `minPixelSize`), far
   * ones first, in white shading blended with the tint by `colorBlend`,
   * over black at the tint's alpha times the model's emphasis (its `focus`,
   * composed with the haze in a set that recedes).
   */
  function modelSquares() {
    const squares = [];
    const eyeHeight = toCartographicRadians(eye().position).height;
    for (const set of sets.values()) {
      if (set.kind !== 'models' || !set.show) continue;
      const recede = recedeParams(set.spec.recede);
      const frame = recede ? recedeFrame(eyeHeight, recede) : null;
      for (const item of set.items.values()) {
        if (item.show === false) continue;
        const p = itemPosition(set, item);
        if (!p || isOccluded(p)) continue;
        const distance = magnitude(sub(p, eye().position));
        if (item.displayRange) {
          const [nearM, farM] = item.displayRange;
          if (distance < nearM || distance >= farM) continue;
        }
        const s = project(p);
        if (!s) continue;
        // The pixel floor wins over the cap, as Cesium's does.
        let side = 10;
        if (item.maxPixelSize > 0) side = Math.min(side, item.maxPixelSize);
        side = Math.max(side, item.minPixelSize ?? 0);
        const focus = Number.isFinite(item.focus)
          ? Math.min(1, Math.max(0, item.focus))
          : 1;
        const emphasis = recede
          ? recededAlpha(
              focus,
              recedeFactors(distance, frame, recede).alpha,
              recede,
            )
          : focus;
        squares.push({
          x: s.x,
          y: s.y,
          half: side / 2,
          distance,
          rgba: modelColor(item, emphasis),
        });
      }
    }
    return squares.sort((a, b) => b.distance - a.distance);
  }

  /**
   * A model's colour: white shading, the tint blended in by `colorBlend`,
   * over black at the tint's alpha times `emphasis`.
   */
  function modelColor(item, emphasis = 1) {
    const shaded = [1, 1, 1];
    const tint =
      item.tint === undefined || item.tint === null
        ? null
        : typeof item.tint === 'string'
          ? cssColor(item.tint)
          : item.tint;
    let rgb = shaded;
    if (tint) {
      const mode = item.colorBlend?.mode ?? 'highlight';
      const amount =
        mode === 'replace'
          ? 1
          : mode === 'mix'
            ? (item.colorBlend.amount ?? 0.5)
            : null;
      rgb = shaded.map((c, i) =>
        amount === null ? c * tint[i] : c + (tint[i] - c) * amount,
      );
    }
    const alpha = (tint ? (tint[3] ?? 1) : 1) * emphasis;
    return [...rgb.map((c) => Math.round(c * alpha * 255)), 255];
  }

  /** Where a drawn item is now (or `aheadMs` from now), or null. */
  function drawnPosition(ref, aheadMs = 0) {
    const set = sets.get(ref.set);
    const item = set?.items.get(String(ref.id));
    return set && item ? itemPosition(set, item, aheadMs) : null;
  }

  /**
   * Whether `lon`, `lat` (degrees) is in a rectangle geometry, turned by its
   * `rotation` about its centre in longitude and latitude.
   */
  function inRectangle({ rect, rotation = 0 }, lon, lat) {
    // A rectangle across the antimeridian runs east past 180°.
    const span = rect.east - rect.west;
    const width = span >= 360 ? 360 : ((span % 360) + 360) % 360;
    const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
    const dLon = wrap(lon - (rect.west + width / 2));
    const dLat = lat - (rect.south + rect.north) / 2;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return (
      Math.abs(cos * dLon + sin * dLat) <= width / 2 &&
      Math.abs(-sin * dLon + cos * dLat) <= (rect.north - rect.south) / 2
    );
  }

  /**
   * Whether `lon`, `lat` (degrees) is in an ellipse geometry, measured in
   * the plane tangent at its centre.
   */
  function inEllipse(g, lon, lat) {
    const centre = toCartographicRadians(toEcef(g.center));
    const metresPerRadian = 6378137;
    const east =
      ((lon * Math.PI) / 180 - centre.lon) *
      metresPerRadian *
      Math.cos(centre.lat);
    const north = ((lat * Math.PI) / 180 - centre.lat) * metresPerRadian;
    // The semi-major axis is turned counter-clockwise from north.
    const turn = g.rotation ?? 0;
    const along = north * Math.cos(turn) - east * Math.sin(turn);
    const across = north * Math.sin(turn) + east * Math.cos(turn);
    return (along / g.semiMajor) ** 2 + (across / g.semiMinor) ** 2 <= 1;
  }

  /**
   * A draped rectangle's or ellipse's outline as a closed ring of positions
   * on the ellipsoid (the rectangle turned as `inRectangle` turns it), or
   * null for other geometries.
   */
  function outlineRing(g) {
    const points = [];
    if (g?.kind === 'rectangle') {
      const { rect, rotation = 0 } = g;
      const span = rect.east - rect.west;
      const width = span >= 360 ? 360 : ((span % 360) + 360) % 360;
      const cLon = rect.west + width / 2;
      const cLat = (rect.south + rect.north) / 2;
      const hw = width / 2;
      const hh = (rect.north - rect.south) / 2;
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      for (const [u, v] of [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
        [-hw, -hh],
      ])
        points.push({
          lon: cLon + cos * u - sin * v,
          lat: cLat + sin * u + cos * v,
          height: 0,
        });
      return points;
    }
    if (g?.kind === 'ellipse') {
      const centre = toCartographicRadians(toEcef(g.center));
      const metresPerRadian = 6378137;
      const turn = g.rotation ?? 0;
      for (let i = 0; i <= 64; i++) {
        const theta = (i / 64) * Math.PI * 2;
        const along = g.semiMajor * Math.cos(theta);
        const across = g.semiMinor * Math.sin(theta);
        // The inverse of `inEllipse`'s turn.
        const north = along * Math.cos(turn) + across * Math.sin(turn);
        const east = -along * Math.sin(turn) + across * Math.cos(turn);
        points.push({
          lon: toDegrees(
            centre.lon + east / (metresPerRadian * Math.cos(centre.lat)),
          ),
          lat: toDegrees(centre.lat + north / metresPerRadian),
          height: 0,
        });
      }
      return points;
    }
    return null;
  }

  /**
   * Where a wall's face is under the pixel `(x, y)` (within the pick
   * window, so one seen edge-on is still picked): the middle of the panel
   * it is on, or null. A clamped wall stands on the stub's surface (height
   * 0); its tops are its positions' heights (or `maximumHeights`).
   */
  function wallHit(item, x, y, halfW, halfH) {
    const { positions, minimumHeights, maximumHeights } = item.geometry;
    const corner = (i, top) =>
      toEcef({
        lon: positions[i].lon,
        lat: positions[i].lat,
        height: top
          ? (maximumHeights?.[i] ?? positions[i].height ?? 0)
          : (minimumHeights?.[i] ?? 0),
      });
    for (let i = 0; i + 1 < (positions?.length ?? 0); i++) {
      const quad = [
        corner(i, false),
        corner(i + 1, false),
        corner(i + 1, true),
        corner(i, true),
      ];
      if (quad.every(isOccluded)) continue;
      const screen = quad.map(project);
      if (screen.some((p) => !p)) continue;
      if (!inScreenQuad(screen, x, y, Math.max(halfW, halfH))) continue;
      return scale(
        quad.reduce((sum, p) => add(sum, p), vec(0, 0, 0)),
        1 / 4,
      );
    }
    return null;
  }

  /** Whether `(x, y)` is in a screen quad, or within `slack` of its edges. */
  function inScreenQuad(quad, x, y, slack) {
    let inside = false;
    for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
      const a = quad[i];
      const b = quad[j];
      if (
        a.y > y !== b.y > y &&
        x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const span = dx * dx + dy * dy;
      const t =
        span > 0
          ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / span))
          : 0;
      if (Math.hypot(a.x + dx * t - x, a.y + dy * t - y) <= slack) return true;
    }
    return inside;
  }

  /**
   * The pickable items under a pixel, nearest first. With a `depth`, only
   * the nearest `depth` things drawn there are looked through, unpickable
   * ones included (as a bounded `drillPick` does).
   */
  function hitsAt(x, y, win = {}, depth = undefined) {
    if (scriptedPicks) return scriptedPicks(x, y, win) ?? [];
    const halfW = (win.width ?? 3) / 2;
    const halfH = (win.height ?? 3) / 2;
    const hits = [];
    for (const [setId, set] of sets) {
      if (!set.show) continue;
      // Drawn but never picked: it still takes up a place under the pointer.
      const setBlocked = set.spec.pickable === false;
      const blockedItem = (item) => setBlocked || item.pickable === false;
      if (set.kind === 'lines') {
        for (const item of set.items.values()) {
          if (item.show === false) continue;
          // Lines in the sky's frame are not picked where they are drawn.
          if (item.frame === 'inertial') continue;
          const p = lineHit(item, x, y, Math.max(halfW, halfH));
          if (p)
            hits.push({
              set: setId,
              id: item.id,
              meta: item.meta,
              surface: false,
              position: p,
              depth: magnitude(sub(p, eye().position)),
              blocked: blockedItem(item),
            });
        }
        continue;
      }
      if (set.kind === 'shapes') {
        // Draped rectangles and ellipses are picked where they cover the
        // ellipsoid (rectangles turned as the default renderer turns them)
        // and along their draped outline; walls where their face is; other
        // shapes are not picked.
        const ground = rayEllipsoid(pickRay(x, y));
        const at = ground && toCartographicRadians(ground);
        const lon = at && toDegrees(at.lon);
        const lat = at && toDegrees(at.lat);
        for (const item of set.items.values()) {
          if (item.show === false) continue;
          const g = item.geometry;
          const hit = (position) =>
            hits.push({
              set: setId,
              id: item.id,
              meta: item.meta,
              surface: false,
              position,
              depth: magnitude(sub(position, eye().position)),
              blocked: blockedItem(item),
            });
          const ring =
            item.outline && item.height === 'clampGround'
              ? outlineRing(g)
              : null;
          const onRing =
            ring &&
            lineHit(
              { positions: ring, widthPx: item.outlineWidth ?? 1 },
              x,
              y,
              Math.max(halfW, halfH),
            );
          if (onRing) {
            hit(onRing);
            continue;
          }
          if (g?.kind === 'wall') {
            const onWall = item.fill && wallHit(item, x, y, halfW, halfH);
            if (onWall) hit(onWall);
            continue;
          }
          if (!at || !item.fill || item.outlineOnly) continue;
          const covers =
            item.height === 'clampGround' &&
            ((g?.kind === 'rectangle' && inRectangle(g, lon, lat)) ||
              (g?.kind === 'ellipse' && inEllipse(g, lon, lat)));
          if (covers) hit(ground);
        }
        continue;
      }
      if (
        set.kind !== 'icons' &&
        set.kind !== 'points' &&
        set.kind !== 'models'
      )
        continue;
      const clustered = set.kind === 'icons' ? set.clusters : null;
      // A cluster is picked as its members, seed first, at its position.
      for (const cluster of clustered?.clusters ?? []) {
        const seed = set.items.get(cluster.ids[0]);
        const s = project(cluster.position);
        if (!seed || !s) continue;
        const [w = 0, h = 0] = seed.size ?? [];
        const k = seed.scale ?? 1;
        if (
          Math.abs(s.x - x) > (w * k) / 2 + halfW ||
          Math.abs(s.y - y) > (h * k) / 2 + halfH
        )
          continue;
        const depth = magnitude(sub(cluster.position, eye().position));
        for (const id of cluster.ids) {
          const item = set.items.get(id);
          if (!item) continue;
          hits.push({
            set: setId,
            id,
            meta: item.meta,
            surface: false,
            position: { ...cluster.position },
            depth,
            blocked: blockedItem(item),
            over: (seed.disableDepthTest ?? 0) > depth,
            order: set.spec.drawOrder ?? 0,
            seq: set.seq,
          });
        }
      }
      for (const item of set.items.values()) {
        if (item.show === false) continue;
        if (clustered?.members.has(item.id)) continue;
        const p = itemPosition(set, item);
        if (!p || isOccluded(p)) continue;
        const distance = magnitude(sub(p, eye().position));
        if (item.displayRange) {
          const [nearM, farM] = item.displayRange;
          if (distance < nearM || distance >= farM) continue;
        }
        // Faded out entirely, it is not drawn.
        if (
          item.fadeByDistance &&
          nearFarValue(item.fadeByDistance, distance) <= 0
        )
          continue;
        const s = project(p);
        if (!s) continue;
        const pixel = item.pixelSize ?? 10;
        const size = item.pickProxy?.size ?? item.size ?? [pixel, pixel];
        const scale = item.scaleByDistance
          ? nearFarValue(item.scaleByDistance, distance)
          : 1;
        // Scaled to nothing, it is not drawn.
        if (scale <= 0) continue;
        // An icon's centre: its anchor edge on the position (as drawn, not
        // as a proxy), then its pixel offset (y down).
        let cx = s.x;
        let cy = s.y;
        let dx = x - cx;
        let dy = y - cy;
        if (set.kind === 'icons') {
          const lift = { bottom: 1, top: -1 }[item.anchor] ?? 0;
          // Its offset shrinks with it when it says so.
          const offsetScale = item.offsetScalesByDistance ? scale : 1;
          cx += (item.pixelOffset?.x ?? 0) * offsetScale;
          cy +=
            (item.pixelOffset?.y ?? 0) * offsetScale -
            (lift * (item.size?.[1] ?? 0) * scale) / 2;
          dx = x - cx;
          dy = y - cy;
          // Turned counter-clockwise on screen (its up along the axis
          // as projected there, then by its rotation): the pick turned back.
          let turn =
            item.rotationMode === 'screen' || item.rotationMode === 'axis'
              ? (item.rotation ?? 0)
              : 0;
          const axis = item.rotationMode === 'axis' ? item.alignedAxis : null;
          if (
            axis &&
            magnitude(vec(axis.x ?? 0, axis.y ?? 0, axis.z ?? 0)) > 0
          ) {
            const tip = project(
              add(p, normalize(vec(axis.x ?? 0, axis.y ?? 0, axis.z ?? 0))),
            );
            if (tip && (tip.x !== s.x || tip.y !== s.y))
              turn += Math.atan2(-(tip.x - s.x), -(tip.y - s.y));
          }
          if (turn !== 0) {
            const c = Math.cos(turn);
            const n = Math.sin(turn);
            [dx, dy] = [dx * c - dy * n, dx * n + dy * c];
          }
        }
        if (
          Math.abs(dx) <= (size[0] * scale) / 2 + halfW &&
          Math.abs(dy) <= (size[1] * scale) / 2 + halfH
        )
          hits.push({
            set: setId,
            id: item.id,
            meta: item.meta,
            surface: false,
            position: p,
            depth: distance,
            blocked: blockedItem(item),
            // Drawn over depth here: stacked by its set's draw order.
            over: (item.disableDepthTest ?? 0) > distance,
            order: set.spec.drawOrder ?? 0,
            seq: set.seq,
          });
      }
    }
    // What skips the depth test is on top, the highest draw order first and
    // of one order the set made first (as the default renderer stacks
    // opaque ones); the rest nearest first.
    hits.sort(
      (a, b) =>
        (b.over === true) - (a.over === true) ||
        (a.over ? b.order - a.order || a.seq - b.seq : 0) ||
        a.depth - b.depth,
    );
    const looked = depth === undefined ? hits : hits.slice(0, depth);
    const out = looked.filter((hit) => !hit.blocked);
    for (const hit of out) {
      delete hit.depth;
      delete hit.blocked;
      delete hit.over;
      delete hit.order;
      delete hit.seq;
    }
    return out;
  }

  /**
   * A line's positions as ECEF, cut at its `revealFraction` of length (as
   * drawn straight between its positions).
   */
  function revealedLine(item) {
    const flat = item.positions instanceof Float64Array;
    const n = flat ? item.positions.length / 3 : item.positions.length;
    const points = [];
    for (let i = 0; i < n; i++)
      points.push(
        flat
          ? vec(
              item.positions[i * 3],
              item.positions[i * 3 + 1],
              item.positions[i * 3 + 2],
            )
          : toEcef(item.positions[i]),
      );
    const fraction = item.revealFraction;
    if (fraction === undefined || fraction >= 1) return points;
    const at = alongLength(points, fraction);
    if (!at) return [];
    const { index, t } = at;
    return [
      ...points.slice(0, index + 1),
      add(points[index], scale(sub(points[index + 1], points[index]), t)),
    ];
  }

  /**
   * Where a line is under the pixel `(x, y)`: the nearest point of a
   * drawn segment within half its width (and `slack`) of it, or null.
   */
  function lineHit(item, x, y, slack) {
    const points = revealedLine(item);
    const reach = (item.widthPx ?? 1) / 2 + slack;
    let best = null;
    let bestDistance = Infinity;
    for (let i = 0; i + 1 < points.length; i++) {
      if (item.segmentShow?.[i] === false) continue;
      const a = points[i];
      const b = points[i + 1];
      if (isOccluded(a) && isOccluded(b)) continue;
      const sa = project(a);
      const sb = project(b);
      if (!sa || !sb) continue;
      const dx = sb.x - sa.x;
      const dy = sb.y - sa.y;
      const span = dx * dx + dy * dy;
      const t =
        span > 0
          ? Math.max(0, Math.min(1, ((x - sa.x) * dx + (y - sa.y) * dy) / span))
          : 0;
      const distance = Math.hypot(sa.x + dx * t - x, sa.y + dy * t - y);
      if (distance <= reach && distance < bestDistance) {
        bestDistance = distance;
        best = add(a, scale(sub(b, a), t));
      }
    }
    return best;
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
      if (opts.limit === undefined) return hitsAt(x, y, opts);
      return hitsAt(x, y, opts, Math.max(opts.limit, 16)).slice(0, opts.limit);
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
  // The stub's only surface is the ellipsoid: a point is hidden behind its
  // horizon, answered at once.
  if (capabilities.has('occlusionTest'))
    query.occlusionTest = () => {
      let now = 0;
      return {
        mode: 'sync',
        maxPerFrame: Number.POSITIVE_INFINITY,
        beginFrame(t) {
          now = t;
        },
        add(point, position) {
          point.pending = false;
          point.answered = true;
          if (isOccluded(position)) point.lastHiddenAt = now;
          return true;
        },
        endFrame() {},
        reset() {},
        destroy() {},
      };
    };

  // --- Input -----------------------------------------------------------------

  const router = createInputRouter({
    report,
    suspendCamera: (reason) => camera.port.controls.suspend(reason),
  });
  const input = router.port;

  function dispatchPointer(type, x, y, extra = {}) {
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
        opts.limit === undefined ? hits().slice() : query.drillPick(x, y, opts);
      ev.ground = () => rayEllipsoid(pickRay(x, y));
    }
    router.dispatch(ev);
    requestRender('input');
  }

  // --- Globe -----------------------------------------------------------------

  const imageryLayers = [];
  let split = 0.5;
  /** Layers whose frames follow scene time, each with its show-a-time function. */
  const sceneFrameLayers = new Map();
  /** Each timed layer's announcement of the frame it drew, run after a render. */
  const frameFlushes = new Map();
  const progressListeners = [];
  /** Imagery added since the last drawn frame: loading until it is drawn. */
  let imageryLoading = 0;
  function announceProgress() {
    deliver(progressListeners, {
      tilesPending: 0,
      imageryPending: imageryLoading,
      terrainPending: 0,
    });
  }
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
  let globeVisible = true;

  function addImagery(spec, index) {
    if (
      !capabilities.has('imageHooks') &&
      (spec.tileTransform || spec.admit || spec.kind === 'canvas')
    )
      throw new TypeError(
        'tileTransform, admit and canvas imagery need imageHooks',
      );
    const listeners = { frameReady: [], tileError: [] };
    const layer = {
      spec: { ...spec },
      alpha: 1,
      show: true,
      split: 'none',
      drapeOn: 'all',
      lit: true,
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
        sceneFrameLayers.delete(layer);
        frameFlushes.delete(layer);
        requestRender('imagery');
      },
    };
    if (capabilities.has('imageryFrames')) {
      let source = null;
      let clockKind = 'scene';
      /** The time the source shows for `ms`: the nearest frame, or within the videos. */
      const shownTime = (ms) => {
        if (source?.kind === 'video') {
          let best = null;
          let bestOff = Infinity;
          for (const seg of source.segments) {
            const t = Math.min(seg.end, Math.max(seg.start, ms));
            if (Math.abs(t - ms) < bestOff) {
              best = t;
              bestOff = Math.abs(t - ms);
            }
          }
          return best;
        }
        const frames = source?.frames ?? [];
        let best = null;
        for (const f of frames)
          if (!best || Math.abs(f.time - ms) < Math.abs(best.time - ms))
            best = f;
        return best ? best.time : null;
      };
      // The stub has every frame at once, so the frame asked for is drawn
      // by the next render; it is said once per change of the drawn frame.
      let wanted = null;
      let drawnTime = null;
      const show = (ms) => {
        wanted = shownTime(ms);
        requestRender('imagery');
      };
      frameFlushes.set(layer, () => {
        if (wanted === null || wanted === drawnTime) return;
        drawnTime = wanted;
        deliver(listeners.frameReady, drawnTime);
      });
      layer.setFrames = (next, opts = {}) => {
        source =
          next.kind === 'video'
            ? { kind: 'video', segments: next.segments.map((s) => ({ ...s })) }
            : { kind: 'frames', frames: next.frames.slice() };
        wanted = null;
        drawnTime = null;
        clockKind = opts.clock ?? 'scene';
        if (clockKind === 'scene') {
          sceneFrameLayers.set(layer, show);
          show(sceneTime);
        } else sceneFrameLayers.delete(layer);
        requestRender('imagery');
      };
      layer.setFrameTime = (ms) => {
        // On the scene clock the frame port's time decides.
        if (clockKind !== 'own') return;
        show(ms);
        requestRender('imagery');
      };
    }
    if (index === undefined) imageryLayers.push(layer);
    else imageryLayers.splice(index, 0, layer);
    log('globe', 'imagery.add', [spec, index]);
    requestRender('imagery');
    imageryLoading += 1;
    announceProgress();
    return layer;
  }

  // `surfaceIdentity`: bumped by whatever changes what heights answer against.
  let surfaceVersion = 0;
  let terrainKey = 'null';
  // The last `setBase` wins; its style load in flight, if any.
  let baseGen = 0;
  /** The `setBase` call whose base is drawn now (a failed one changes none). */
  let drawnGen = 0;
  let baseLoad = null;
  const globe = {
    async setBase(base) {
      log('globe', 'setBase', [base]);
      if (base.vector && !capabilities.has('vectorBase'))
        throw new TypeError('This renderer draws no vector base');
      const gen = ++baseGen;
      baseLoad?.abort();
      baseLoad = null;
      const current = () => gen === baseGen && !destroyed;
      // Superseded (or destroyed) before its base changes: nothing changes.
      const superseded = () => ({
        photoreal: photorealStatus,
        imagery: [],
        settled: false,
      });
      if (destroyed) return superseded();
      // The style is loaded, as a renderer drawing it loads it, so one that
      // fails changes nothing; the stub paints none of it.
      if (base.vector) {
        const load = new AbortController();
        baseLoad = load;
        try {
          await loadVectorStyle(base.vector.styleUrl, undefined, {
            signal: load.signal,
          });
        } catch (error) {
          if (!current()) return superseded();
          throw error;
        } finally {
          if (baseLoad === load) baseLoad = null;
        }
        if (!current()) return superseded();
      }
      drawnGen = gen;
      for (const layer of imageryLayers.slice()) layer.remove();
      // The imagery is added before anything is awaited, so a later call,
      // which removes it, always finds it.
      const layers = (base.imagery ?? []).map((spec) => addImagery(spec));
      if (base.photoreal !== undefined)
        await globe.setPhotoreal(base.photoreal);
      // Settled when its base is still the one drawn: a later call changes
      // the base only once its style loads, and one whose style fails never
      // does (see the contract's setBase).
      return {
        photoreal: photorealStatus,
        imagery: layers,
        settled: gen === drawnGen && !destroyed,
      };
    },
    async setPhotoreal(spec) {
      log('globe', 'setPhotoreal', [spec]);
      const route = photorealStatus.route;
      photorealStatus =
        spec && capabilities.has('photoreal')
          ? { route: 'google' }
          : { route: 'none' };
      if (photorealStatus.route !== route || spec) surfaceVersion += 1;
      requestRender('base');
      return photorealStatus;
    },
    async setTerrain(spec) {
      log('globe', 'setTerrain', [spec]);
      // The stub keeps no terrain: a spec unlike the last is a new surface.
      const key = JSON.stringify(spec ?? null);
      if (key !== terrainKey) surfaceVersion += 1;
      terrainKey = key;
      requestRender('base');
    },
    setGlobeVisible(visible) {
      log('globe', 'setGlobeVisible', [visible]);
      if (globeVisible !== Boolean(visible)) surfaceVersion += 1;
      globeVisible = Boolean(visible);
      requestRender('base');
    },
    imagery: {
      add: addImagery,
      list: () => imageryLayers.slice(),
    },
    sky: {
      get: () => ({ ...sky }),
      set(patch) {
        sky = { ...sky, ...patch };
        requestRender('sky');
      },
    },
    isSettled(kind) {
      if (kind !== 'surface') return settled[kind] ?? true;
      if (!capabilities.has('surfaceIdentity')) return settled.base;
      // Heights answer from the globe, else the tiles; neither drawn, none.
      if (!globeVisible && photorealStatus.route === 'none') return false;
      return settled.surface ?? settled[globeVisible ? 'terrain' : 'tiles'];
    },
    on(event, cb) {
      if (event !== 'progress') return () => {};
      progressListeners.push(cb);
      return () => {
        const i = progressListeners.indexOf(cb);
        if (i >= 0) progressListeners.splice(i, 1);
      };
    },
  };
  if (capabilities.has('weather')) {
    let weather = CLEAR_WEATHER;
    globe.weather = {
      get: () => mergeWeather(weather),
      set(patch) {
        weather = mergeWeather(weather, patch);
        requestRender('weather');
      },
    };
  }
  if (capabilities.has('globeVisibility'))
    globe.isGlobeVisible = () => globeVisible;
  if (capabilities.has('surfaceIdentity'))
    globe.surfaceVersion = () => surfaceVersion;
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
  /** The styles a setStyle replaced, drawing until their intensity is 0. */
  const fading = new Set();
  const styleIntensity = (id) => effectState.intensity[id] ?? 1;
  const styleDraws = (id) =>
    (id === effectState.style || fading.has(id)) && styleIntensity(id) > 0;
  /** Styles the app defined, by id. */
  const defined = new Map();
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
      capabilities.has('styles')
        ? [
            ...STYLES.filter((s) => !defined.has(s.id)),
            ...defined.values(),
          ].map(({ id, params, animated }) => ({
            id,
            params: params.map((p) => ({ ...p })),
            animated,
          }))
        : [],
    defineStyle(definition) {
      // The stub runs GLSL only, as the default renderer does.
      if (
        !capabilities.has('styles') ||
        typeof definition?.shader?.glsl !== 'string'
      )
        return null;
      const entry = {
        id: String(definition.id),
        params: (definition.params ?? []).map((p) => ({ ...p })),
        animated: Boolean(definition.animated),
      };
      defined.set(entry.id, entry);
      effectsChanged();
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        if (defined.get(entry.id) !== entry) return;
        defined.delete(entry.id);
        fading.delete(entry.id);
        if (effectState.style === entry.id) effectState.style = null;
        effectsChanged();
      };
    },
    setStyle(id, params) {
      if (id !== effectState.style) {
        if (effectState.style !== null && styleIntensity(effectState.style) > 0)
          fading.add(effectState.style);
        fading.delete(id);
      }
      effectState.style = id;
      if (params) effectState.params[id] = { ...params };
      effectsChanged();
    },
    setStyleIntensity(id, value) {
      effectState.intensity[id] = value;
      if (!(value > 0)) fading.delete(id);
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
        ...effects
          .styles()
          .filter((s) => styleDraws(s.id))
          .map((s) => `style:${s.id}`),
        ...(effectState.bloom?.enabled ? ['bloom'] : []),
        ...(effectState.sharpen?.enabled ? ['sharpen'] : []),
        ...(effectState.modulation ? ['screenModulation'] : []),
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

  // --- Renderer --------------------------------------------------------------

  const canvas = createCanvas(options.container, viewport);

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
      if (destroyed) throw destroyedError();
      return new Blob([], { type: `image/${opts.type ?? 'png'}` });
    },
    readPixels(opts = {}) {
      const crop = opts.crop ?? {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      };
      const k = opts.scale ?? 1;
      const width = Math.round(crop.width * k);
      const height = Math.round(crop.height * k);
      const data = new Uint8ClampedArray(width * height * 4);
      // Models are the only things the stub draws into pixels.
      for (const square of modelSquares()) {
        for (let row = 0; row < height; row++) {
          const y = crop.y + (row + 0.5) / k;
          if (Math.abs(y - square.y) > square.half) continue;
          for (let col = 0; col < width; col++) {
            const x = crop.x + (col + 0.5) / k;
            if (Math.abs(x - square.x) > square.half) continue;
            data.set(square.rgba, (row * width + col) * 4);
          }
        }
      }
      return /** @type {ImageData} */ (
        /** @type {unknown} */ ({ width, height, data })
      );
    },
    async whenSettled() {
      const blockers = Object.keys(settled).filter((kind) => !settled[kind]);
      return { state: blockers.length ? 'timeout' : 'settled', blockers };
    },
    resize() {
      // In a page, the stub's canvas follows its container's size.
      const container = options.container;
      if (container?.clientWidth > 0 && container?.clientHeight > 0)
        sizeCanvas(canvas, viewport, {
          width: container.clientWidth,
          height: container.clientHeight,
        });
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
      baseGen += 1;
      baseLoad?.abort();
      baseLoad = null;
      if (options.container) canvas.remove?.();
      for (const clear of onceTimers) clear();
      onceTimers.clear();
      for (const waiter of onceWaiters.splice(0)) waiter(destroyedError());
      sets.clear();
      sceneFrameLayers.clear();
      frameFlushes.clear();
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
        sizeCanvas(canvas, viewport, size);
      },
      /**
       * Where a drawn item is drawn now (or `aheadMs` from now), ECEF, or
       * null: what the stub's own camera follows for a target's `item`, for
       * a camera of someone else's driving the stub (the `camera.followItem`
       * conformance check).
       */
      drawnPosition: (ref, aheadMs = 0) => drawnPosition(ref, aheadMs),
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
 * @property {(ref: {set: string, id: string|number}, aheadMs?: number) => {x: number, y: number, z: number}|null} drawnPosition
 * @property {(id: string) => object|null} setRecord
 * @property {() => string[]} sets
 * @property {Array<{port: string, member: string, args: unknown[]}>} calls
 * @property {() => object} effects
 * @property {(error: Error) => void} emitError
 */

/**
 * The stub as a renderer plugin (`RendererPlugin`), for running the whole
 * application on it: each renderer it makes fills the container it is given
 * with a canvas, as the Cesium plugin's does. Nothing runs on its own: the caller
 * drives the loop (`testing.tick()`), each frame or as a test needs.
 * @param {Parameters<typeof createStubRenderer>[0]} [options] For each
 *   renderer it makes (`capabilities`, `viewport`, `time`...).
 * @param {(renderer: ReturnType<typeof createStubRenderer>) => void} [onCreate]
 *   Hears each renderer it makes.
 * @returns {import('../contract/renderer').RendererPlugin}
 */
export function createStubRendererPlugin(options = {}, onCreate) {
  return Object.freeze({
    id: 'stub',
    async create({ container, signal }) {
      signal?.throwIfAborted();
      const renderer = createStubRenderer({ ...options, container });
      onCreate?.(renderer);
      return renderer;
    },
  });
}
