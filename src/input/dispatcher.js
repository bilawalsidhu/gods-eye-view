/**
 * @module input/dispatcher
 * @description The one place the application's layers and tools take
 * pointer input over the globe: the scene's input port
 * (src/render/cesium/input.js), a click picked once and handed to every
 * subscriber, and the camera-input and stock-click holds tools take. Each
 * layer family moves onto the renderer's own `input` port as it is ported;
 * until then it subscribes here, with the events and shapes it always had.
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
 * Camera input is suspended by the scene's counted holds
 * (src/render/cesium/cameraInput.js), which own the controller's
 * `enableInputs`, so a camera flight that ends cannot re-enable input under
 * a drag or the cockpit.
 *
 * A dispatcher is made per scene on first use ({@link inputFor}) and lives
 * until {@link InputDispatcher.destroy}; the application scene owns it.
 */
import * as Cesium from 'cesium';
import { isLeaseCurrent, isPointerFree } from '../data/inputOwnership.js';
import { acquireCameraInput } from '../render/cesium/cameraInput.js';
import { cesiumInputOf, createCesiumInput } from '../render/cesium/input.js';
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

/** The handler event types the scene's input port binds, for test doubles. */
export const HANDLER_EVENT_TYPES = Cesium.ScreenSpaceEventType;

/** A drill is run at least this deep and sliced, so callers asking for
 *  different depths on one click share one pass. */
const DRILL_DEPTH = 16;

const POINTER_TYPES = ['down', 'move', 'up', 'click', 'dblclick'];

/**
 * The events Cesium's unmodified left-button actions raised, which is all
 * the dispatcher's subscribers have ever seen: the port also has the other
 * buttons and the modified presses.
 */
const unmodified = ({ modifiers: m }) => !m.shift && !m.ctrl && !m.alt;
const unmodifiedLeft = (ev) => ev.button === 0 && unmodified(ev);

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
 * @property {(name: 'select'|'dblclickFollow') => boolean} stockEnabled
 *   Whether the viewer's stock select or follow runs now: it does unless a
 *   hold is out (or the viewer has none).
 * @property {() => number} subscriberCount Live click and pointer
 *   subscriptions, for leak checks.
 * @property {() => void} destroy
 */

/**
 * The scene's dispatcher, made on first use.
 * @param {object} viewer A Cesium viewer (or a test double with `scene`).
 * @param {{createHandler?: (canvas: object) => object, now?: () => number, document?: object|null}} [options]
 *   For the input port it makes when the scene has none (tests pass a fake
 *   handler); used only by the call that makes it.
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

function createDispatcher(viewer, { createHandler, now, document } = {}) {
  const scene = viewer.scene;
  // The renderer's port when the application made one; a viewer of the
  // caller's own gets one for as long as this dispatcher lives.
  const shared = cesiumInputOf(scene);
  const cesiumInput =
    shared ??
    createCesiumInput(viewer, {
      report: (error) => console.error('Pointer input failed', error),
      // The viewer is its owner's: its stock actions stay on its handler.
      takeStock: false,
      ...(createHandler ? { createHandler } : {}),
      ...(now ? { now } : {}),
      ...(document !== undefined ? { document } : {}),
    });
  const { port } = cesiumInput;
  const cameraInput = acquireCameraInput(scene);
  /** @type {Array<{fn: Function}>} */
  const clickSubscribers = [];
  /** @type {Record<string, Array<{fn: Function, lease: object|null}>>} */
  const pointerSubscribers = Object.fromEntries(
    POINTER_TYPES.map((type) => [type, []]),
  );
  const stockHolds = new Set();
  let destroyed = false;

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

  const cartesian = (p) => new Cesium.Cartesian2(p.x, p.y);
  // Each type is one port listener; the pointer's owner is read once per
  // event, before any subscriber runs.
  const offPort = [
    port.on('down', (ev) => {
      if (!unmodifiedLeft(ev)) return;
      run(pointerSubscribers.down, isPointerFree(), {
        position: cartesian(ev.position),
      });
    }),
    port.on('move', (ev) => {
      if (!unmodified(ev)) return;
      run(pointerSubscribers.move, true, {
        startPosition: cartesian(ev.position),
        endPosition: cartesian(ev.endPosition ?? ev.position),
      });
    }),
    port.on('up', (ev) => {
      if (!unmodifiedLeft(ev)) return;
      run(pointerSubscribers.up, true, { position: cartesian(ev.position) });
    }),
    port.on('click', (ev) => {
      if (!unmodifiedLeft(ev)) return;
      const free = isPointerFree();
      const event = createClickEvent(
        viewer,
        { position: cartesian(ev.position) },
        ev.gesture ?? { travelPx: 0, durationMs: 0 },
      );
      run(pointerSubscribers.click, free, event);
      if (free) run(clickSubscribers, true, event);
    }),
    port.on('dblclick', (ev) => {
      if (!unmodifiedLeft(ev)) return;
      run(pointerSubscribers.dblclick, isPointerFree(), {
        position: cartesian(ev.position),
      });
    }),
  ];

  const subscribe = (list, entry) => {
    if (destroyed) return () => {};
    list.push(entry);
    return () => {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    };
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
      return cameraInput.suspend(reason);
    },

    suppressStockClicks() {
      if (destroyed) return () => {};
      // Cesium's own select and double-click-track never see the pointer
      // lease; the port runs them, and holds them off here.
      const releases = [
        port.behaviours.select.suppress(),
        port.behaviours.dblclickFollow.suppress(),
      ];
      const hold = () => {
        if (!stockHolds.delete(hold)) return;
        for (const release of releases) release();
      };
      stockHolds.add(hold);
      return hold;
    },

    stockEnabled: (name) => port.behaviours[name]?.enabled ?? false,

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
      for (const off of offPort) off();
      for (const hold of [...stockHolds]) hold();
      cameraInput.release();
      if (!shared) cesiumInput.dispose();
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
