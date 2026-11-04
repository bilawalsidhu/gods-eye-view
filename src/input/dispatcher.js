/**
 * @module input/dispatcher
 * @description The one place pointer input over the globe comes in: a single
 * `ScreenSpaceEventHandler` per scene, a click picked once and handed to
 * every subscriber, and the camera-input and stock-click holds tools take.
 *
 * Layers used to bind a handler each and pick the same click again, so one
 * click with the usual layers on cost about 25 `scene.pick` passes (each one
 * redraws the scene for the pick buffer). Now the dispatcher picks lazily on
 * first read and every subscriber reads the same {@link ClickEvent}; what a
 * layer does with a click that is not its own stays the layer's decision.
 *
 * Who gets the pointer:
 * - Ambient subscribers ({@link InputDispatcher.onClick}, and `onPointer`
 *   without a lease) run only while no tool holds the pointer
 *   (src/data/inputOwnership.js). The check is made once per event, before
 *   any subscriber runs, so a tool that releases its lease while handling a
 *   click does not let that same click through to ambient selection. Ambient
 *   `move` and `up` are the exceptions: hover sees every move, so it can drop
 *   its cursor or card when a tool takes the pointer, and a release always
 *   reaches whoever began the press, so a drag started while the pointer was
 *   free still ends (and gives its camera hold back).
 * - Tool subscribers pass their lease and run only while it is current.
 *
 * Camera input is suspended by holds, not by a flag: every suspender gets its
 * own release, and input comes back when the last one releases. The
 * dispatcher owns the controller's `enableInputs`: what others write to it
 * (Cesium's own camera flights turn it off and back on) is kept, and it reads
 * true only while that is true and no hold is out, so a flight that ends can
 * no longer re-enable input under a drag or the cockpit.
 *
 * A dispatcher is made per scene on first use ({@link inputFor}) and lives
 * until {@link InputDispatcher.destroy}; the application scene owns it.
 */
import * as Cesium from 'cesium';
import { isLeaseCurrent, isPointerFree } from '../data/inputOwnership.js';
import {
  findPickOwner,
  pickContact,
  resolvePickId,
} from '../data/pickRegistry.js';
import { isSurfacePick, pickGroundPosition } from '../data/scenePick.js';
import { sensorPickPosition } from './sensorPick.js';

// A tool takes the pointer with a lease before it subscribes with one.
export {
  claimPointer,
  isLeaseCurrent,
  isPointerFree,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';

/** A drill is run at least this deep and sliced, so callers asking for
 *  different depths on one click share one pass. */
const DRILL_DEPTH = 16;

const POINTER_TYPES = ['down', 'move', 'up', 'click', 'dblclick'];

/** A tool that re-arms takes a new lease each time: it may pass a getter. */
const leaseOf = (entry) =>
  typeof entry.lease === 'function' ? entry.lease() : entry.lease;

/** @type {WeakMap<object, InputDispatcher>} scene -> dispatcher */
const dispatchers = new WeakMap();

/**
 * @typedef {object} ClickGesture
 * @property {number} travelPx Pointer travel during the press, summed per
 *   segment (an orbit nudge that comes back is not a zero-distance click).
 * @property {number} durationMs Press time.
 */

/**
 * One left click, picked at most once per kind of query. Every getter and
 * method is memoized, so subscribers share the passes.
 * @typedef {object} ClickEvent
 * @property {{x: number, y: number}} screenPosition Where the user clicked.
 * @property {Cesium.Cartesian2} position Where that lands in the pick buffer
 *   (corrected for sensor styles; see sensorPick.js).
 * @property {ClickGesture} gesture
 * @property {object|undefined} pick `scene.pick` at `position`.
 * @property {object|undefined} hit `pick`, or on a coarse pointer the first
 *   registered contact under a surface pick (`pickContact`).
 * @property {string|null} id The hit's canonical pick id.
 * @property {string|null} ownerId The layer that registered the hit.
 * @property {object|undefined} meta The hit's own metadata, when its pick
 *   carries any (icon-set rows do).
 * @property {boolean} surface Whether the hit is the map itself.
 * @property {(width: number, height: number) => object|undefined} pickWindow
 *   `scene.pick` with a wider window.
 * @property {(limit?: number, width?: number, height?: number) => object[]} drill
 *   `scene.drillPick`, at most `limit` hits.
 * @property {() => Cesium.Cartesian3|null} ground The world position under
 *   the click: rendered surface, else ellipsoid; null over the sky.
 */

/**
 * @typedef {object} InputDispatcher
 * @property {(fn: (event: ClickEvent) => void) => () => void} onClick
 *   Ambient click subscription. Returns its unsubscribe.
 * @property {(type: 'down'|'move'|'up'|'click'|'dblclick', fn: Function, options?: {lease?: object|(() => object|null)}) => () => void} onPointer
 *   Raw pointer subscription: `click` gets the {@link ClickEvent}, the others
 *   Cesium's event. With a lease, runs only while that lease is current;
 *   without one, only while the pointer is free (`move` and `up` always run).
 * @property {(reason: string) => () => void} suspendCamera Hold camera input
 *   off; returns this hold's release.
 * @property {() => () => void} suppressStockClicks Take the viewer's stock
 *   select and double-click-track actions off; returns this hold's release.
 * @property {() => number} subscriberCount Live click and pointer
 *   subscriptions, for leak checks.
 * @property {() => void} destroy
 */

/**
 * The scene's dispatcher, made on first use.
 * @param {object} viewer A Cesium viewer (or a test double with `scene`).
 * @param {{createHandler?: (canvas: object) => object, eventTypes?: object, now?: () => number}} [options]
 *   Used only by the call that makes it.
 * @returns {InputDispatcher}
 */
export function inputFor(viewer, options = {}) {
  const scene = viewer.scene;
  let dispatcher = dispatchers.get(scene);
  if (!dispatcher) {
    dispatcher = createDispatcher(viewer, options);
    dispatchers.set(scene, dispatcher);
  }
  return dispatcher;
}

/**
 * Take over the controller's `enableInputs`: what others write to it is kept
 * (through an accessor already there, if any), and it reads true only while
 * that is true and no hold is out.
 * @param {object|undefined} controller
 * @param {Set<object>} holds
 * @returns {() => void} Gives the controller its own property back.
 */
function ownCameraInput(controller, holds) {
  if (!controller) return () => {};
  const own = Object.getOwnPropertyDescriptor(controller, 'enableInputs');
  if (own && !own.configurable) {
    console.warn('Camera input holds are unavailable: enableInputs is fixed');
    return () => {};
  }
  // A class may define it on its prototype; the hold shadows that for a while.
  let original = own;
  for (let proto = Object.getPrototypeOf(controller); !original && proto;) {
    original = Object.getOwnPropertyDescriptor(proto, 'enableInputs');
    proto = Object.getPrototypeOf(proto);
  }
  original ??= { value: true, writable: true, enumerable: true };
  let written = Boolean(original.get ? true : original.value);
  const read = () =>
    original.get ? Boolean(original.get.call(controller)) : written;
  Object.defineProperty(controller, 'enableInputs', {
    configurable: true,
    enumerable: original.enumerable ?? true,
    get: () => read() && holds.size === 0,
    set: (value) => {
      written = Boolean(value);
      original.set?.call(controller, value);
    },
  });
  return () => {
    delete controller.enableInputs;
    if (own?.get || own?.set)
      Object.defineProperty(controller, 'enableInputs', own);
    else if (own || !(original.get || original.set))
      controller.enableInputs = written;
  };
}

function createDispatcher(
  viewer,
  {
    createHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
    eventTypes = Cesium.ScreenSpaceEventType,
    now = () => performance.now(),
  },
) {
  const scene = viewer.scene;
  const cameraHolds = new Set();
  // Before the handler, so a controller that cannot be owned leaks nothing.
  const releaseCameraInput = ownCameraInput(
    scene.screenSpaceCameraController,
    cameraHolds,
  );
  const handler = createHandler(scene.canvas);
  /** @type {Array<{fn: Function}>} */
  const clickSubscribers = [];
  /** @type {Record<string, Array<{fn: Function, lease: object|null}>>} */
  const pointerSubscribers = Object.fromEntries(
    POINTER_TYPES.map((type) => [type, []]),
  );
  const stockHolds = new Set();
  let stockSaved = null;
  let destroyed = false;

  let pressActive = false;
  let pressStartedAt = 0;
  let previousPosition = null;
  let travelPx = 0;
  let completedGesture = null;

  const appendTravel = (position) => {
    if (
      !pressActive ||
      !Number.isFinite(position?.x) ||
      !Number.isFinite(position?.y)
    )
      return;
    if (previousPosition) {
      travelPx += Math.hypot(
        position.x - previousPosition.x,
        position.y - previousPosition.y,
      );
    }
    previousPosition = { x: position.x, y: position.y };
  };

  const finishPress = (position) => {
    if (!pressActive) return;
    appendTravel(position);
    completedGesture = {
      travelPx,
      durationMs: Math.max(0, now() - pressStartedAt),
    };
    pressActive = false;
    previousPosition = null;
  };

  const run = (list, free, arg) => {
    for (const entry of [...list]) {
      if (entry.lease ? !isLeaseCurrent(leaseOf(entry)) : !free) continue;
      try {
        entry.fn(arg);
      } catch (error) {
        console.error('Pointer input handler failed', error);
      }
    }
  };

  handler.setInputAction((event) => {
    pressActive = true;
    pressStartedAt = now();
    previousPosition = null;
    travelPx = 0;
    completedGesture = null;
    appendTravel(event?.position);
    run(pointerSubscribers.down, isPointerFree(), event);
  }, eventTypes.LEFT_DOWN);

  handler.setInputAction((event) => {
    appendTravel(event?.endPosition ?? event?.position);
    run(pointerSubscribers.move, true, event);
  }, eventTypes.MOUSE_MOVE);

  handler.setInputAction((event) => {
    finishPress(event?.position);
    run(pointerSubscribers.up, true, event);
  }, eventTypes.LEFT_UP);

  handler.setInputAction((click) => {
    if (pressActive) finishPress(click?.position);
    const gesture = completedGesture || { travelPx: 0, durationMs: 0 };
    completedGesture = null;
    const free = isPointerFree();
    const event = createClickEvent(viewer, click, gesture);
    run(pointerSubscribers.click, free, event);
    if (free) run(clickSubscribers, true, event);
  }, eventTypes.LEFT_CLICK);

  handler.setInputAction((event) => {
    run(pointerSubscribers.dblclick, isPointerFree(), event);
  }, eventTypes.LEFT_DOUBLE_CLICK);

  const subscribe = (list, entry) => {
    if (destroyed) return () => {};
    list.push(entry);
    return () => {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    };
  };

  const stockHandler = () => viewer.screenSpaceEventHandler;
  const stockTypes = () => [
    eventTypes.LEFT_CLICK,
    eventTypes.LEFT_DOUBLE_CLICK,
  ];

  const restoreStock = () => {
    const stock = stockHandler();
    if (stockSaved && stock && !stock.isDestroyed?.()) {
      for (const [type, action] of stockSaved) {
        if (action) stock.setInputAction(action, type);
      }
    }
    stockSaved = null;
  };

  return {
    onClick(fn) {
      return subscribe(clickSubscribers, { fn, lease: null });
    },

    onPointer(type, fn, { lease = null } = {}) {
      const list = pointerSubscribers[type];
      if (!list) throw new TypeError(`Unknown pointer event: ${type}`);
      return subscribe(list, { fn, lease });
    },

    suspendCamera(reason) {
      if (destroyed) return () => {};
      const hold = { reason };
      cameraHolds.add(hold);
      return () => {
        cameraHolds.delete(hold);
      };
    },

    suppressStockClicks() {
      if (destroyed) return () => {};
      const hold = {};
      if (stockHolds.size === 0) {
        const stock = stockHandler();
        if (stock) {
          // Cesium's own select and double-click-track run on the viewer's
          // handler and never see the pointer lease.
          stockSaved = stockTypes().map((type) => [
            type,
            stock.getInputAction(type),
          ]);
          for (const type of stockTypes()) stock.removeInputAction(type);
        }
      }
      stockHolds.add(hold);
      return () => {
        if (!stockHolds.delete(hold) || stockHolds.size > 0) return;
        restoreStock();
      };
    },

    subscriberCount() {
      return POINTER_TYPES.reduce(
        (sum, type) => sum + pointerSubscribers[type].length,
        clickSubscribers.length,
      );
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      dispatchers.delete(scene);
      clickSubscribers.length = 0;
      for (const type of POINTER_TYPES) pointerSubscribers[type].length = 0;
      cameraHolds.clear();
      releaseCameraInput();
      if (stockHolds.size) {
        stockHolds.clear();
        restoreStock();
      }
      if (!handler.isDestroyed?.()) handler.destroy?.();
    },
  };
}

/**
 * @param {object} viewer
 * @param {{position: {x: number, y: number}}} click
 * @param {ClickGesture} gesture
 * @returns {ClickEvent}
 */
function createClickEvent(viewer, click, gesture) {
  const scene = viewer.scene;
  const position = sensorPickPosition(scene, click.position);
  const memo = new Map();
  const once = (key, compute) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  /** @type {Map<string, {limit: number, hits: object[]}>} */
  const drills = new Map();

  return {
    screenPosition: click.position,
    position,
    gesture,
    get pick() {
      return once('pick', () => scene.pick(position));
    },
    get hit() {
      return once('hit', () =>
        pickContact(scene, position, {
          picked: this.pick,
          drill: (limit, width, height) => this.drill(limit, width, height),
        }),
      );
    },
    get id() {
      return once('id', () => resolvePickId(this.hit));
    },
    get ownerId() {
      return once('ownerId', () => findPickOwner(this.id));
    },
    get meta() {
      const hit = this.hit;
      return hit?.id?.meta ?? hit?.meta;
    },
    get surface() {
      return isSurfacePick(this.hit);
    },
    pickWindow(width, height) {
      return once(`window:${width}x${height}`, () =>
        scene.pick(position, width, height),
      );
    },
    drill(limit = DRILL_DEPTH, width, height) {
      const key = `${width}x${height}`;
      const done = drills.get(key);
      // A pass that came back short already holds every hit there is.
      if (done && (limit <= done.limit || done.hits.length < done.limit))
        return done.hits.slice(0, limit);
      if (typeof scene.drillPick !== 'function') return [];
      // Only the default window is shared between layers; round that one up.
      const depth =
        width === undefined && height === undefined
          ? Math.max(limit, DRILL_DEPTH)
          : limit;
      const hits = scene.drillPick(position, depth, width, height) || [];
      drills.set(key, { limit: depth, hits });
      return hits.slice(0, limit);
    },
    ground() {
      return once('ground', () => pickGroundPosition(viewer, position));
    },
  };
}
