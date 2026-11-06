/**
 * @module render/cesium/input
 * @description The Cesium renderer's input port
 * (`src/render/contract/input.d.ts`): one `ScreenSpaceEventHandler` over the
 * canvas turns Cesium's pointer events into the contract's, and the shared
 * router (`src/render/input/router.js`) decides who hears each.
 *
 * - Presses, releases, clicks and moves come from the handler, for every
 *   button and with any one modifier held (Cesium raises an action only for
 *   the modifier it was bound with). The DOM event under each one, seen
 *   first on the document, gives the full modifiers and the pointer type.
 * - Wheel comes from the canvas's own `wheel` event, which this never
 *   cancels: the page keeps its Ctrl+wheel zoom unless `ctrlWheelZoom` is
 *   on. Pinch comes from the handler's two-finger events.
 * - A click is picked lazily and once, through the query port, and shared
 *   by every subscriber.
 * - The viewer's stock select (left click) and follow (double-click) are
 *   taken off its handler and run from here, ahead of the subscribers as
 *   they ran on it, only for a press that goes to them (no lease took it)
 *   and while the behaviour is not suppressed. A widget without them reports them
 *   disabled.
 * - Camera input is held off through the scene's shared holds
 *   (`cameraInput.js`).
 */
import * as Cesium from 'cesium';
import { createInputRouter } from '../input/router.js';
import { acquireCameraInput } from './cameraInput.js';
import { installTrackpadPinchZoom } from './ctrlWheelZoom.js';

const T = Cesium.ScreenSpaceEventType;
const MODIFIERS = [
  undefined,
  Cesium.KeyboardEventModifier.SHIFT,
  Cesium.KeyboardEventModifier.CTRL,
  Cesium.KeyboardEventModifier.ALT,
];
const BUTTONS = ['LEFT', 'MIDDLE', 'RIGHT'];
/** The stock behaviours, by the handler action they are. */
const STOCK = { select: T.LEFT_CLICK, dblclickFollow: T.LEFT_DOUBLE_CLICK };
/** The DOM events Cesium's handler reads, in either input model. */
const DOM_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mousemove',
  'mouseup',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'dblclick',
];
/** A wheel notch scrolls 100 px in Chrome, which it counts as three lines. */
const PX_PER_LINE = 100 / 3;
/** A drill is run at least this deep and sliced, so asks share one pass. */
const DRILL_DEPTH = 16;
const NO_MODIFIERS = Object.freeze({
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
});
const POINTER_TYPES = new Set(['mouse', 'touch', 'pen']);
/** The one modifier Cesium raised an action for, when no DOM event says. */
const CESIUM_MODIFIER = {
  [Cesium.KeyboardEventModifier.SHIFT]: { shift: true },
  [Cesium.KeyboardEventModifier.CTRL]: { ctrl: true },
  [Cesium.KeyboardEventModifier.ALT]: { alt: true },
};

const xy = (p) => ({ x: p.x, y: p.y });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const modifiersOf = (dom) =>
  dom
    ? {
        shift: Boolean(dom.shiftKey),
        ctrl: Boolean(dom.ctrlKey),
        alt: Boolean(dom.altKey),
        meta: Boolean(dom.metaKey),
      }
    : { ...NO_MODIFIERS };

/** A DOM event's pointer type; a `dblclick`, which has none, takes `otherwise`. */
function pointerTypeOf(dom, otherwise = 'mouse') {
  if (POINTER_TYPES.has(dom?.pointerType)) return dom.pointerType;
  if (dom?.type?.startsWith('touch')) return 'touch';
  if (dom?.type?.startsWith('mouse')) return 'mouse';
  return otherwise;
}

/**
 * @param {object} widget A Cesium `CesiumWidget` or `Viewer`.
 * @param {object} options
 * @param {object} options.query The renderer's query port: clicks pick
 *   through it.
 * @param {(error: unknown) => void} options.report Where a listener's or a
 *   `grab`'s error goes.
 * @param {(canvas: object) => object} [options.createHandler]
 * @param {() => number} [options.now] Event time, ms.
 * @param {object} [options.document] Where the DOM events are watched.
 * @param {typeof installTrackpadPinchZoom} [options.ctrlWheelZoom]
 * @returns {{port: object, feed: Function, listenerCount: () => number, dispose: () => void}}
 *   `feed(type, x, y, extra)` delivers one event as the handler would, for
 *   the conformance harness.
 */
export function createCesiumInput(
  widget,
  {
    query,
    report,
    createHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
    now = () => performance.now(),
    document: dom = globalThis.document,
    ctrlWheelZoom = installTrackpadPinchZoom,
  },
) {
  const scene = widget.scene;
  const canvas = scene.canvas;
  let disposed = false;

  // The viewer's stock actions, now this port's to run.
  const stockHandler = widget.screenSpaceEventHandler;
  const stock = {};
  for (const [name, type] of Object.entries(STOCK)) {
    const action = stockHandler?.getInputAction?.(type);
    if (!action) continue;
    stock[name] = action;
    stockHandler.removeInputAction(type);
  }

  const cameraInput = acquireCameraInput(scene);
  let uninstallCtrlWheel = null;
  const router = createInputRouter({
    report,
    suspendCamera: (reason) => cameraInput.suspend(reason),
    supported: {
      select: Boolean(stock.select),
      dblclickFollow: Boolean(stock.dblclickFollow),
    },
    onCtrlWheelZoom(on) {
      if (disposed) return;
      if (on && !uninstallCtrlWheel) uninstallCtrlWheel = ctrlWheelZoom(widget);
      else if (!on && uninstallCtrlWheel) {
        uninstallCtrlWheel();
        uninstallCtrlWheel = null;
      }
    },
  });
  const { behaviours } = router.port;

  // The DOM event the handler is answering, seen before it on the document,
  // for as long as it is being dispatched: an action Cesium raises later, on
  // a timer (a touch held for a right click), has none. The pointer type of
  // the last one stays for those.
  let lastDom = null;
  let lastPointerType = 'mouse';
  let clearing = false;
  // A task after this one: every event seen before it has been dispatched.
  const clear = () => {
    clearing = false;
    lastDom = null;
  };
  const record = (event) => {
    lastDom = event;
    lastPointerType = pointerTypeOf(event, lastPointerType);
    if (clearing) return;
    clearing = true;
    setTimeout(clear, 0);
  };
  for (const type of DOM_EVENTS)
    dom?.addEventListener?.(type, record, { capture: true, passive: true });

  /** Presses under way by button, for each click's gesture. */
  const pressing = new Map();
  /** Each button's last finished press, until its click reads it. */
  const finished = new Map();
  /** The button of the last event, when it was an up. */
  let lastUp = null;
  const heldButton = () => {
    for (const button of [0, 1, 2]) if (pressing.has(button)) return button;
    return 0;
  };

  function track(type, position, endPosition, button) {
    const at = now();
    if (type === 'down') {
      pressing.set(button, { start: at, last: position, travel: 0 });
      finished.delete(button);
    } else if (type === 'move') {
      for (const press of pressing.values()) {
        press.travel += distance(press.last, endPosition);
        press.last = endPosition;
      }
    } else if (type === 'up') {
      const press = pressing.get(button);
      if (!press) return;
      press.travel += distance(press.last, position);
      pressing.delete(button);
      finished.set(button, {
        travelPx: press.travel,
        durationMs: Math.max(0, at - press.start),
      });
    }
  }

  /** A click's lazy picks, each made at most once. */
  function withPicks(ev) {
    const { x, y } = ev.position;
    let hit;
    let picked = false;
    let ground;
    let grounded = false;
    /** @type {Map<string, {limit: number, hits: object[]}>} */
    const drills = new Map();
    ev.pick = () => {
      if (!picked) {
        picked = true;
        hit = query.pick(x, y) ?? null;
      }
      return hit;
    };
    ev.drill = (options = {}) => {
      const { limit, ...window } = options;
      const want = limit ?? Infinity;
      const key = `${window.width ?? ''}x${window.height ?? ''}:${window.purpose ?? ''}`;
      let pass = drills.get(key);
      // A pass that found fewer than it asked for found everything.
      if (!pass || (pass.hits.length >= pass.limit && want > pass.limit)) {
        const depth =
          want === Infinity ? Infinity : Math.max(want, DRILL_DEPTH);
        pass = {
          limit: depth,
          hits: query.drillPick(x, y, {
            ...window,
            ...(depth === Infinity ? {} : { limit: depth }),
          }),
        };
        drills.set(key, pass);
      }
      return want === Infinity ? pass.hits.slice() : pass.hits.slice(0, want);
    };
    ev.ground = () => {
      if (!grounded) {
        grounded = true;
        ground = query.pickPosition(x, y) ?? query.pickEllipsoid(x, y);
      }
      return ground;
    };
    return ev;
  }

  /**
   * One event into the router, shaped as the contract's.
   * @param {string} type
   * @param {{x: number, y: number}} position
   * @param {object} [extra] `button`, `endPosition`, `delta`, and, from the
   *   feed, `modifiers`, `pointerType` and `gesture`.
   * @param {object|null} [source] The DOM event under it.
   */
  function deliver(type, position, extra = {}, source = lastDom) {
    if (disposed) return;
    // Cesium ends every held button on any button's release, each with its
    // click: the others' presses end there, as they do for its camera, but
    // only the button released clicks.
    const released = source && /(?:pointer|mouse)up$/.test(source.type);
    if (type === 'click' && released && source.button !== extra.button) {
      finished.delete(extra.button);
      return;
    }
    const at = xy(position);
    const end = extra.endPosition ? xy(extra.endPosition) : undefined;
    const button = extra.button ?? heldButton();
    // A move with no end is where the pointer is now.
    track(type, at, end ?? at, button);
    const justUp = lastUp;
    lastUp = type === 'up' ? button : null;
    const ev = {
      type,
      position: at,
      button,
      modifiers: extra.modifiers
        ? { ...NO_MODIFIERS, ...extra.modifiers }
        : source
          ? modifiersOf(source)
          : { ...NO_MODIFIERS, ...CESIUM_MODIFIER[extra.modifier] },
      timestamp: now(),
      pointerType: extra.pointerType ?? pointerTypeOf(source, lastPointerType),
      ...(end ? { endPosition: end } : {}),
      ...(extra.delta !== undefined ? { delta: extra.delta } : {}),
    };
    if (type === 'click' || type === 'dblclick') {
      // A click ends the press whose up came straight before it; one
      // Cesium raises on a timer (a touch held) ends none.
      const press =
        type === 'click' && justUp === button
          ? finished.get(button)
          : undefined;
      finished.delete(button);
      ev.gesture = extra.gesture ?? press ?? { travelPx: 0, durationMs: 0 };
      withPicks(ev);
    }
    // The viewer's own select and follow run first, as they did on its
    // handler.
    router.dispatch(ev, (to) => runStock(ev, to));
  }

  /** The viewer's own select or follow, as it would have run. */
  function runStock(ev, to) {
    const name =
      ev.type === 'click'
        ? 'select'
        : ev.type === 'dblclick'
          ? 'dblclickFollow'
          : null;
    if (!name || !stock[name] || ev.button !== 0 || !to.ambient) return;
    // Cesium bound them with no modifier: a modified click never ran them.
    const { shift, ctrl, alt } = ev.modifiers;
    if (shift || ctrl || alt || !behaviours[name].enabled) return;
    try {
      stock[name]({
        position: new Cesium.Cartesian2(ev.position.x, ev.position.y),
      });
    } catch (error) {
      report(error);
    }
  }

  const handler = createHandler(canvas);
  const bind = (type, action) => {
    for (const modifier of MODIFIERS)
      handler.setInputAction(
        (event) => action(event, modifier),
        type,
        modifier,
      );
  };
  BUTTONS.forEach((name, button) => {
    bind(T[`${name}_DOWN`], (e, modifier) =>
      deliver('down', e.position, { button, modifier }),
    );
    bind(T[`${name}_UP`], (e, modifier) =>
      deliver('up', e.position, { button, modifier }),
    );
    bind(T[`${name}_CLICK`], (e, modifier) =>
      deliver('click', e.position, { button, modifier }),
    );
  });
  bind(T.LEFT_DOUBLE_CLICK, (e, modifier) =>
    deliver('dblclick', e.position, { button: 0, modifier }),
  );
  bind(T.MOUSE_MOVE, (e, modifier) =>
    deliver('move', e.startPosition, { endPosition: e.endPosition, modifier }),
  );
  // Pinch is at the two fingers' midpoint where it started; its delta is
  // the scale since the last event.
  let pinchAt = null;
  bind(T.PINCH_START, (e) => {
    pinchAt = {
      x: (e.position1.x + e.position2.x) / 2,
      y: (e.position1.y + e.position2.y) / 2,
    };
  });
  bind(T.PINCH_MOVE, (e) => {
    const from = e.distance.startPosition.y;
    const to = e.distance.endPosition.y;
    if (!(from > 0) || !(to > 0) || !pinchAt) return;
    deliver('pinch', pinchAt, { delta: to / from });
  });
  bind(T.PINCH_END, () => {
    pinchAt = null;
  });

  const onWheel = (event) => {
    const rect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const lines =
      event.deltaMode === 1
        ? event.deltaY
        : event.deltaMode === 2
          ? (event.deltaY * (canvas.clientHeight || 0)) / PX_PER_LINE
          : event.deltaY / PX_PER_LINE;
    deliver(
      'wheel',
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      { delta: lines },
      event,
    );
  };
  canvas?.addEventListener?.('wheel', onWheel, { passive: true });

  return {
    port: router.port,
    feed(type, x, y, extra = {}) {
      deliver(type, { x, y }, extra, null);
    },
    listenerCount: router.listenerCount,
    dispose() {
      if (disposed) return;
      disposed = true;
      router.dispose();
      canvas?.removeEventListener?.('wheel', onWheel, { passive: true });
      for (const type of DOM_EVENTS)
        dom?.removeEventListener?.(type, record, { capture: true });
      if (!handler.isDestroyed?.()) handler.destroy?.();
      uninstallCtrlWheel?.();
      uninstallCtrlWheel = null;
      cameraInput.release();
      if (stockHandler && !stockHandler.isDestroyed?.())
        for (const [name, type] of Object.entries(STOCK))
          if (stock[name] && !stockHandler.getInputAction(type))
            stockHandler.setInputAction(stock[name], type);
    },
  };
}
