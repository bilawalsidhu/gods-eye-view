/**
 * @module input/dispatcher
 * @description The one place the application's layers and tools take
 * pointer input over the globe: the renderer's input port
 * (src/render/contract/input.d.ts, `findInput`), a click picked once through
 * the renderer's query port and handed to every subscriber, and the
 * camera-input and stock-click holds tools take. Each layer family moves
 * onto the renderer's own `input` port as it is ported; until then it
 * subscribes here, with the events and shapes it always had.
 *
 * Layers used to bind a handler each and pick the same click again, so one
 * click with the usual layers on cost about 25 picks (each one redraws the
 * scene for the pick buffer). Now the dispatcher picks lazily on first read
 * and every subscriber reads the same {@link ClickEvent}; what a layer does
 * with a click that is not its own stays the layer's decision.
 *
 * Who gets the pointer: while a tool holds it (src/data/inputOwnership.js)
 * the port holds a lease for it (`bridgePointer`), so the port is not free,
 * but that lease takes no press: each event is decided here when it arrives.
 * - Ambient subscribers ({@link InputDispatcher.onClick}, and `onPointer`
 *   without a lease) run only while no tool holds the pointer. The check is
 *   made once per event, before any subscriber runs, so a tool that releases
 *   its lease while handling a click does not let that same click through
 *   to ambient selection. Ambient `move` and `up` are the exceptions: hover
 *   sees every move, so it can drop its cursor or card when a tool takes the
 *   pointer, and a release always reaches whoever began the press, so a drag
 *   started while the pointer was free still ends (and gives its camera hold
 *   back).
 * - Tool subscribers pass their lease and run only while it is current.
 * - A claim made on the port by anyone else takes the presses it grabs; the
 *   rest reach the subscribers here as above.
 *
 * Camera input is suspended through the input port's counted holds
 * (`suspendCameraControls`), so a camera flight that ends cannot re-enable
 * input under a drag or the cockpit.
 *
 * Positions are plain `{x, y}` CSS pixels. What the renderer's picks cannot
 * name, something still drawn outside the draw port, comes from the
 * renderer adapter's own picks of the click (`nativeClickOf`), which also
 * hangs them on the click as `native` for code still bound to them.
 *
 * A dispatcher is made per scene object on first use ({@link inputFor}) and
 * lives until {@link InputDispatcher.destroy}; the application scene owns
 * it.
 */
import {
  bridgePointer,
  isLeaseCurrent,
  pointerOwner,
} from '../data/inputOwnership.js';
import {
  findPickOwner,
  pickContact,
  resolvePickId,
} from '../data/pickRegistry.js';
import { isPickedWorldPosition } from '../data/scenePick.js';
import {
  canvasOf,
  findInput,
  findQuery,
  nativeClickOf,
  releaseUnboundInput,
} from '../render/rendererOf.js';
import { sensorPickPosition } from './sensorPick.js';

// A tool takes the pointer with a lease before it subscribes with one.
export {
  claimPointer,
  isLeaseCurrent,
  isPointerFree,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';

/**
 * The world position under a screen point: the rendered surface where the
 * depth buffer has it, else the ellipsoid; null over the sky.
 *
 * @param {object} viewer The scene object.
 * @param {{x: number, y: number}} screenPosition
 * @returns {{x: number, y: number, z: number}|null} ECEF metres.
 */
export function pickGroundPosition(viewer, screenPosition) {
  return groundAt(findQuery(viewer), screenPosition);
}

/** `pickGroundPosition` through a query port. */
function groundAt(query, { x, y }) {
  if (!query) return null;
  let position = null;
  try {
    position = query.pickPosition(x, y);
  } catch {
    position = null;
  }
  if (!isPickedWorldPosition(position)) {
    try {
      position = query.pickEllipsoid(x, y);
    } catch {
      position = null;
    }
  }
  return isPickedWorldPosition(position) ? position : null;
}

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

/** @type {WeakMap<object, InputDispatcher>} scene object -> dispatcher */
const dispatchers = new WeakMap();

const xy = (p) => ({ x: p.x, y: p.y });

/**
 * A draw-set item's hit, or, from what the adapter's own pick found
 * (`foreign`), a hit with no set for something drawn outside the draw port
 * or the hit of a draw-set item the renderer's sets do not hold; null for
 * the map itself or nothing.
 */
function topHitOf(hit, foreign) {
  if (hit && !hit.surface) return hit;
  const other = foreign();
  if (!other) return null;
  return other.set ? other : { set: '', id: other.id, surface: false };
}

/** Whether `hit` is a trail line (src/data/trailRenderer.js). */
function isTrailHit(hit) {
  return Boolean(hit?.set) && findPickOwner(hit.id) === 'trails';
}

/**
 * The first item drawn under a click that is not a trail. A trail is drawn
 * up to the thing it follows, its line over that thing's icon: a click
 * there is on the thing. Over nothing else, the trail stays the hit, so a
 * click on a trail is still never one on empty ground.
 * @param {Hit[]} hits Nearest first.
 * @returns {Hit|null}
 */
function pastTrails(hits) {
  return hits.find((hit) => hit && !hit.surface && !isTrailHit(hit)) ?? null;
}

/**
 * @typedef {object} ClickGesture
 * @property {number} travelPx Pointer travel during the press, summed per
 *   segment (an orbit nudge that comes back is not a zero-distance click).
 * @property {number} durationMs Press time.
 */

/**
 * @typedef {import('../render/contract/query').Hit} Hit
 */

/**
 * One left click, picked at most once per kind of query. Every getter and
 * method is memoized, so subscribers share the passes. Hits are the
 * contract's `Hit`; one with `set: ''` is something drawn outside the draw
 * port, named by the renderer adapter (its id null when it has none).
 * @typedef {object} ClickEvent
 * @property {{x: number, y: number}} screenPosition Where the user clicked.
 * @property {{x: number, y: number}} position Where that lands in the pick buffer
 *   (corrected for sensor styles; see sensorPick.js).
 * @property {ClickGesture} gesture
 * @property {Hit|null} topHit What is on top under the click: a draw-set
 *   item, or something drawn outside the draw port; null for the map itself
 *   (the globe, tiles) or nothing.
 * @property {Hit|null} drawHit `topHit` when it is an item of a renderer draw
 *   set; null for anything else. What layers on the draw port read a click
 *   by.
 * @property {Hit|null} hit `topHit`, or on a coarse pointer the first
 *   registered contact under the map (`pickContact`).
 * @property {string|null} id The hit's canonical pick id.
 * @property {string|null} ownerId The layer that registered the hit.
 * @property {object|undefined} meta The hit's own metadata, when it has any.
 * @property {boolean} surface Whether the hit is the map itself, or nothing.
 * @property {(width: number, height: number) => {id: string|null, drawHit: Hit|null, surface: boolean}} windowHit
 *   A pick with a wider window, read as `id`, `drawHit` and `surface` are.
 * @property {(limit?: number, width?: number, height?: number) => Hit[]} drill
 *   The draw-set items under the click, nearest first, at most `limit`
 *   (`query.drillPick`).
 * @property {() => {x: number, y: number, z: number}|null} ground The world
 *   position under the click: rendered surface, else ellipsoid; null over
 *   the sky.
 * @property {import('../render/rendererOf.js').NativeClick['native']|undefined} native
 *   The renderer adapter's own picks of the click (`pick`, `pickWindow`,
 *   `drill`), for code still bound to the engine's pick objects; undefined
 *   when the adapter has none.
 * @property {unknown} pick `native.pick`, for code still bound to the
 *   engine's pick objects that reads it here.
 * @property {boolean} overlay Whether a painted overlay target took the
 *   click ({@link InputDispatcher.onOverlayClick}). Its hits then name only
 *   that target: something drawn outside the draw port, with no id. A
 *   target the world overlay paints (a Space Missions label) is also the
 *   card on top for every handler (`clickCard` in src/data/pickRegistry.js),
 *   so nothing under it acts.
 * @property {(width: number, height: number) => unknown} pickWindow
 *   `native.pickWindow`, the same.
 */

/**
 * @typedef {object} InputDispatcher
 * @property {(fn: (event: ClickEvent) => void) => () => void} onClick
 *   Ambient click subscription. Returns its unsubscribe.
 * @property {(fn: (event: ClickEvent) => boolean) => () => void} onOverlayClick
 *   Hit-test a painted overlay before ambient clicks. Return true after
 *   handling its topmost target: the geometry beneath it is not picked, and
 *   the click subscribers hear the click as one on that target (`overlay`
 *   true, `topHit` a hit with no set and no id, nothing drilled).
 * @property {(type: 'down'|'move'|'up'|'click'|'dblclick', fn: Function, options?: {lease?: object|(() => object|null)}) => () => void} onPointer
 *   Raw pointer subscription: `click` gets the {@link ClickEvent}, the others
 *   `{position}` (`move`: `{startPosition, endPosition, pickPosition}`, its
 *   `pickPosition` its `endPosition` corrected for sensor styles as a
 *   click's `position` is). With a lease, runs only while that lease is current;
 *   without one, only while the pointer is free (`move` and `up` always run).
 * @property {(reason: string) => () => void} suspendCamera Hold camera input
 *   off; returns this hold's release.
 * @property {() => () => void} suppressStockClicks Take the renderer's stock
 *   select and double-click follow off; returns this hold's release.
 * @property {(name: 'select'|'dblclickFollow') => boolean} stockEnabled
 *   Whether the renderer's stock select or follow runs now: it does unless a
 *   hold is out (or the renderer has none).
 * @property {() => number} subscriberCount Live click and pointer
 *   subscriptions, for leak checks.
 * @property {() => void} destroy
 */

/**
 * What is under canvas CSS pixel `x, y` now, as a click's `topHit` would
 * see it (a hit on the follow's helper is a hit on its target), for a reader
 * that is not handed a click (point-and-ask). Null when nothing but the map
 * is there, or the pick fails.
 * @param {object} viewer The scene object.
 * @param {number} x
 * @param {number} y
 * @returns {Hit|null}
 */
export function pickAt(viewer, x, y) {
  try {
    if (!viewer || viewer.isDestroyed?.()) return null;
    const query = findQuery(viewer);
    if (!query) return null;
    const position = { x, y };
    return topHitOf(
      query.pick(x, y),
      () => nativeClickOf(viewer, position)?.foreign() ?? null,
    );
  } catch {
    return null;
  }
}

/**
 * The scene object's dispatcher, made on first use.
 * @param {object} viewer The scene object (a Cesium viewer, or a test
 *   double).
 * @param {{createHandler?: (canvas: object) => object, now?: () => number,
 *   document?: object|null, query?: import('../render/contract/query').QueryPort}} [options]
 *   For a dispatcher over a viewer with no renderer bound: the input port's
 *   (`findInput`) when this call builds it, and the query port its clicks
 *   pick through (tests pass doubles). Used only by the call that makes the
 *   dispatcher.
 * @returns {InputDispatcher}
 */
export function inputFor(viewer, options = {}) {
  let dispatcher = dispatchers.get(viewer);
  if (!dispatcher) {
    dispatcher = createDispatcher(viewer, options);
    dispatchers.set(viewer, dispatcher);
  }
  return dispatcher;
}

function createDispatcher(viewer, { query: givenQuery, ...portOptions } = {}) {
  const port = findInput(viewer, portOptions);
  if (!port)
    throw new Error(
      viewer?.isDestroyed?.()
        ? 'This scene has been destroyed'
        : 'This scene has no renderer to take input with: bind one, or load ' +
            "the Cesium adapter's factories (the ./render/cesium/unbound export) " +
            'for a viewer with no renderer bound',
    );
  const queryOf = () => givenQuery ?? findQuery(viewer);
  /** @type {Array<{fn: Function}>} */
  const clickSubscribers = [];
  const overlayClicks = new Set();
  /** @type {Record<string, Array<{fn: Function, lease: object|null}>>} */
  const pointerSubscribers = Object.fromEntries(
    POINTER_TYPES.map((type) => [type, []]),
  );
  const stockHolds = new Set();
  const cameraHolds = new Set();
  let destroyed = false;

  // The port holds a lease while a tool here holds the pointer.
  const bridge = bridgePointer(port);

  /** Tool subscribers whose lease is current, and ambient ones if `free`. */
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

  // Whether ambient subscribers hear a press, read once as it arrives. A
  // claim on the port that is not this bridge's has already taken the
  // presses it grabs; what reaches here is free unless a tool here holds it.
  const free = () => pointerOwner() === null;

  // Each type is one port listener.
  const deliver = {
    down: (ev) => {
      if (!unmodifiedLeft(ev)) return;
      run(pointerSubscribers.down, free(), { position: xy(ev.position) });
    },
    move: (ev) => {
      if (!unmodified(ev)) return;
      const endPosition = xy(ev.endPosition ?? ev.position);
      let pickPosition;
      run(pointerSubscribers.move, true, {
        startPosition: xy(ev.position),
        endPosition,
        // Where the pointer lands in the pick buffer, as a click's
        // `position` is (corrected for sensor styles); made on first read.
        get pickPosition() {
          pickPosition ??= sensorPickPosition(
            viewer,
            endPosition,
            canvasOf(viewer),
          );
          return pickPosition;
        },
      });
    },
    up: (ev) => {
      if (!unmodifiedLeft(ev)) return;
      run(pointerSubscribers.up, true, { position: xy(ev.position) });
    },
    click: (ev) => {
      if (!unmodifiedLeft(ev)) return;
      const ambient = free();
      const { event, cover } = createClickEvent(
        viewer,
        queryOf,
        xy(ev.position),
        ev.gesture ?? { travelPx: 0, durationMs: 0 },
      );
      if (ambient) {
        for (const handle of [...overlayClicks]) {
          try {
            // A handled overlay target hides the geometry beneath it; every
            // subscriber still hears the click, as a click on that target.
            if (handle(event) === true) {
              cover();
              break;
            }
          } catch (error) {
            console.error('Pointer input handler failed', error);
          }
        }
      }
      run(pointerSubscribers.click, ambient, event);
      if (ambient) run(clickSubscribers, true, event);
    },
    dblclick: (ev) => {
      if (!unmodifiedLeft(ev)) return;
      run(pointerSubscribers.dblclick, free(), { position: xy(ev.position) });
    },
  };
  const offPort = POINTER_TYPES.map((type) => port.on(type, deliver[type]));

  const subscribe = (list, entry) => {
    if (destroyed) return () => {};
    list.push(entry);
    return () => {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    };
  };

  const self = {
    onClick(fn) {
      return subscribe(clickSubscribers, { fn, lease: null });
    },

    onOverlayClick(fn) {
      if (destroyed) return () => {};
      overlayClicks.add(fn);
      return () => overlayClicks.delete(fn);
    },

    onPointer(type, fn, { lease = null } = {}) {
      const list = pointerSubscribers[type];
      if (!list) throw new TypeError(`Unknown pointer event: ${type}`);
      return subscribe(list, { fn, lease });
    },

    suspendCamera(reason) {
      if (destroyed) return () => {};
      const release = port.suspendCameraControls(reason);
      const hold = () => {
        if (!cameraHolds.delete(hold)) return;
        release();
      };
      cameraHolds.add(hold);
      return hold;
    },

    suppressStockClicks() {
      if (destroyed) return () => {};
      // The renderer's own select and double-click follow never see the
      // pointer lease; the port runs them, and holds them off here.
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
        clickSubscribers.length + overlayClicks.size,
      );
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (dispatchers.get(viewer) === self) dispatchers.delete(viewer);
      clickSubscribers.length = 0;
      overlayClicks.clear();
      for (const type of POINTER_TYPES) pointerSubscribers[type].length = 0;
      for (const off of offPort) off();
      bridge.off();
      for (const hold of [...stockHolds]) hold();
      for (const hold of [...cameraHolds]) hold();
      // A port built for this viewer goes with its dispatcher; a
      // renderer's own stays.
      releaseUnboundInput(viewer, port);
    },
  };
  return self;
}

/** What a click handled by a painted overlay target hits: that target,
 *  drawn outside the draw port and named by no pick id. */
const OVERLAY_HIT = Object.freeze({ set: '', id: null, surface: false });

/** A drill is run at least this deep and sliced, so callers asking for
 *  different depths on one click share one pass. */
const DRILL_DEPTH = 16;

/**
 * @param {object} viewer
 * @param {() => import('../render/contract/query').QueryPort|null} queryOf
 * @param {{x: number, y: number}} at Where the click is, CSS pixels.
 * @param {ClickGesture} gesture
 * @returns {{event: ClickEvent, cover: () => void}} The click, and how a
 *   handled overlay target hides the geometry beneath it from the click.
 */
function createClickEvent(viewer, queryOf, at, gesture) {
  const position = sensorPickPosition(viewer, at, canvasOf(viewer));
  const { x, y } = position;
  const memo = new Map();
  const once = (key, compute) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  const native = () => once('native', () => nativeClickOf(viewer, position));
  const query = () => once('query', queryOf);
  /** The renderer's pick, with a window or not; null without a query port. */
  const pick = (window) => {
    const q = query();
    return q ? (q.pick(x, y, window) ?? null) : null;
  };
  /** @type {Map<string, {limit: number, hits: Hit[]}>} */
  const drills = new Map();
  let covered = false;
  const cover = () => {
    covered = true;
    memo.clear();
    drills.clear();
    memo.set('top', OVERLAY_HIT);
    memo.set('hit', OVERLAY_HIT);
    memo.set('id', null);
    memo.set('ownerId', null);
    memo.set('native', null);
  };

  const event = {
    screenPosition: at,
    position,
    gesture,
    get overlay() {
      return covered;
    },
    get topHit() {
      return once('top', () => {
        const hit = pick();
        // The adapter's own pick of this click is the renderer's pass, held
        // now: read later, it would be another, of a scene drawn since.
        void native()?.native.pick;
        const top = topHitOf(hit, () => native()?.foreign() ?? null);
        return isTrailHit(top) ? (pastTrails(this.drill()) ?? top) : top;
      });
    },
    get drawHit() {
      const hit = this.topHit;
      return hit?.set ? hit : null;
    },
    get hit() {
      return once('hit', () => {
        const q = query();
        if (!q) return this.topHit;
        return pickContact(q, position, {
          picked: this.topHit,
          // Everything drawn there, as the adapter sees it, so a contact
          // search stops at what is drawn over a contact outside the draw
          // port and finds a contact drawn there; the draw-set items alone
          // without one.
          drill: (limit, width, height) => {
            const click = native();
            return click
              ? click.drillHits(limit, width, height)
              : this.drill(limit, width, height);
          },
        });
      });
    },
    get id() {
      return once('id', () => resolvePickId(this.hit));
    },
    get ownerId() {
      return once('ownerId', () => findPickOwner(this.id));
    },
    get meta() {
      return this.hit?.meta;
    },
    get surface() {
      return !this.hit;
    },
    windowHit(width, height) {
      if (covered) return { id: null, drawHit: null, surface: false };
      return once(`windowHit:${width}x${height}`, () => {
        const picked = pick({ width, height });
        void native()?.native.pickWindow(width, height);
        const hit = topHitOf(
          picked,
          () => native()?.foreign(width, height) ?? null,
        );
        return {
          id: resolvePickId(hit),
          drawHit: hit?.set ? hit : null,
          surface: !hit,
        };
      });
    },
    drill(limit = DRILL_DEPTH, width, height) {
      const key = `${width}x${height}`;
      const done = drills.get(key);
      // A deeper pass already made holds these. (One that came back short
      // may not hold every hit: it drops what is not a draw-set item.)
      if (done && limit <= done.limit) return done.hits.slice(0, limit);
      const q = covered ? null : query();
      if (!q) return [];
      // Only the default window is shared between layers; round that one up.
      const depth =
        width === undefined && height === undefined
          ? Math.max(limit, DRILL_DEPTH)
          : limit;
      const hits = q.drillPick(x, y, {
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        limit: depth,
      });
      drills.set(key, { limit: depth, hits });
      return hits.slice(0, limit);
    },
    ground() {
      return once('ground', () => groundAt(query(), position));
    },
    get native() {
      // After the renderer's pick, whose pass the adapter's reuses.
      void this.topHit;
      return native()?.native;
    },
    get pick() {
      // After the renderer's pick, whose pass the adapter's reuses.
      void this.topHit;
      return native()?.native.pick;
    },
    pickWindow(width, height) {
      void this.windowHit(width, height);
      return native()?.native.pickWindow(width, height);
    },
  };
  return { event, cover };
}
