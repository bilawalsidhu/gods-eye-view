import { t } from '../i18n/index.js';
import { RESIZE_DIRECTIONS, resizeBox } from './boxResize.js';

/**
 * Position and size for the typed console's window.
 *
 * The console is a dialog rather than a rail panel, so it cannot use
 * `PanelPositionControls` - that owns lifting a panel OUT of a rail and
 * docking it back, which this has no rail to return to. The geometry lives in
 * `./boxResize.js` and the `.agent-resize-edge` / `.agent-resize-grip`
 * handles are styled by `agent-console.css`, because the app's own floating
 * panels and their shared resize styling were removed.
 *
 * Everything that decides a number is pure and exported, so the clamping is
 * testable without a browser; `attachConsoleBox` is the only part that touches
 * the DOM.
 */

/** Where the console's window geometry persists between sessions. */
const CONSOLE_BOX_STORAGE_KEY = 'godsEyeView.agent.console.box.v1';

/** Smallest window that still shows a transcript and the input row. */
const CONSOLE_MIN_SIZE = Object.freeze({ width: 320, height: 220 });

/**
 * Preferred size when nothing is remembered.
 *
 * The height is what lets the default placement clear BOTH the left rail's
 * chips above it and the map attribution below it on a 900px-tall viewport,
 * which is the shortest screen this is laid out for. A taller screen simply
 * leaves more space above.
 */
const CONSOLE_DEFAULT_SIZE = Object.freeze({ width: 480, height: 380 });

/** Gap kept between the window and the viewport edge. */
const VIEWPORT_MARGIN_PX = 6;

/** Default distance from the left edge. Matches the chip's own inset. */
const DEFAULT_LEFT_PX = 14;

/**
 * Space left below the window on first open.
 *
 * The bottom-left corner carries the map attribution, which is a licence
 * condition rather than decoration - covering it is not a layout choice we get
 * to make. This clears the credit line and the console's own chip beneath it.
 * It is only the first impression: the window is draggable, and wherever the
 * operator puts it is remembered instead.
 */
const DEFAULT_BOTTOM_CLEARANCE_PX = 136;

/** Pointer travel before a press on the header becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Double press on the header that forgets a moved window.
 *
 * Detected from pointerdown, not from `dblclick`: the drag's
 * `preventDefault()` suppresses the native double-click event, so a dblclick
 * listener here never fires. `PanelPositionControls` reaches the same
 * conclusion for the same reason.
 */
const DOUBLE_PRESS_MS = 400;
const DOUBLE_PRESS_SLOP_PX = 6;

/** Interactive header children whose own behaviour wins over a drag. */
const INTERACTIVE_SELECTOR =
  'input, select, option, textarea, button, a, [role="button"], .agent-console-selects';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Fit a window inside the viewport, keeping its size where it can and its
 * top-left corner reachable where it cannot.
 *
 * Size is clamped before position, so a window larger than the viewport
 * shrinks rather than hanging off the edge with its header out of reach.
 *
 * @param {{left:number, top:number, width:number, height:number}} box
 * @param {{viewportWidth:number, viewportHeight:number, minWidth?:number,
 *   minHeight?:number, margin?:number}} limits
 * @returns {{left:number, top:number, width:number, height:number}}
 */
function clampBox(
  box,
  {
    viewportWidth,
    viewportHeight,
    minWidth = CONSOLE_MIN_SIZE.width,
    minHeight = CONSOLE_MIN_SIZE.height,
    margin = VIEWPORT_MARGIN_PX,
    viewportLeft = 0,
    viewportTop = 0,
  },
) {
  // The visible area wins when a phone/keyboard is smaller than the usual
  // minimum. CSS permits the same contraction and scrolls compact controls.
  const maxWidth = Math.max(1, viewportWidth - 2 * margin);
  const maxHeight = Math.max(1, viewportHeight - 2 * margin);
  const width = clamp(
    Math.round(box.width),
    Math.min(minWidth, maxWidth),
    maxWidth,
  );
  const height = clamp(
    Math.round(box.height),
    Math.min(minHeight, maxHeight),
    maxHeight,
  );
  return {
    width,
    height,
    left: clamp(
      Math.round(box.left),
      viewportLeft + margin,
      Math.max(
        viewportLeft + margin,
        viewportLeft + viewportWidth - width - margin,
      ),
    ),
    top: clamp(
      Math.round(box.top),
      viewportTop + margin,
      Math.max(
        viewportTop + margin,
        viewportTop + viewportHeight - height - margin,
      ),
    ),
  };
}

/**
 * The window the console opens with when nothing is remembered: left side,
 * above the map attribution.
 *
 * @param {{viewportWidth:number, viewportHeight:number}} viewport
 * @returns {{left:number, top:number, width:number, height:number}}
 */
function defaultBox({ viewportWidth, viewportHeight }) {
  const width = Math.min(
    CONSOLE_DEFAULT_SIZE.width,
    viewportWidth - 2 * VIEWPORT_MARGIN_PX,
  );
  const height = Math.min(
    CONSOLE_DEFAULT_SIZE.height,
    viewportHeight - DEFAULT_BOTTOM_CLEARANCE_PX - 2 * VIEWPORT_MARGIN_PX,
  );
  return clampBox(
    {
      left: DEFAULT_LEFT_PX,
      top: viewportHeight - DEFAULT_BOTTOM_CLEARANCE_PX - height,
      width,
      height,
    },
    { viewportWidth, viewportHeight },
  );
}

/** Lift a launcher past intersecting controls without moving those controls. */
function clearLauncherObstacles(launcher, obstacles, gap = 8) {
  let bottom = launcher.bottom;
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const top = bottom - launcher.height;
    const collisions = obstacles.filter(
      (r) =>
        launcher.left < r.right + gap &&
        launcher.right > r.left - gap &&
        top < r.bottom + gap &&
        bottom > r.top - gap,
    );
    if (!collisions.length) break;
    bottom = Math.min(...collisions.map((r) => r.top - gap));
  }
  return bottom;
}

/** Whether a value is a complete, finite window record. */
function isBox(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['left', 'top', 'width', 'height'].every((key) =>
      Number.isFinite(value[key]),
    )
  );
}

/**
 * Read the remembered window.
 *
 * Storage can throw outright in privacy modes, so every access is guarded and
 * a failure degrades to "no preference" rather than breaking the console.
 *
 * @param {Storage} [storage]
 * @returns {{left:number, top:number, width:number, height:number}|null}
 */
function readStoredBox(storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    const raw = store?.getItem(CONSOLE_BOX_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isBox(parsed)
      ? {
          left: parsed.left,
          top: parsed.top,
          width: parsed.width,
          height: parsed.height,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Remember the window, best effort.
 *
 * @param {{left:number, top:number, width:number, height:number}|null} box Null forgets it.
 * @param {Storage} [storage]
 */
function writeStoredBox(box, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    if (box === null) {
      store?.removeItem(CONSOLE_BOX_STORAGE_KEY);
      return;
    }
    store?.setItem(CONSOLE_BOX_STORAGE_KEY, JSON.stringify(box));
  } catch {
    // A window position is never worth breaking the app over.
  }
}

/**
 * Whether a pointer event should start a drag rather than reach the control
 * it landed on.
 *
 * @param {PointerEvent} event
 * @returns {boolean}
 */
function startsDrag(event) {
  if (event.button !== 0) return false;
  return !event.target?.closest?.(INTERACTIVE_SELECTOR);
}

/**
 * Make the console's window draggable by its header and resizable from every
 * edge, remembering where it was left.
 *
 * @param {{
 *   dialog: HTMLElement,
 *   handle: HTMLElement,
 *   root?: Document,
 *   view?: Window,
 *   storage?: Storage,
 * }} options
 * @returns {{apply: () => void, reset: () => void, destroy: () => void}}
 */
function attachConsoleBox({
  chip,
  dialog,
  handle,
  root = dialog?.ownerDocument ?? globalThis.document,
  view = globalThis,
  storage,
}) {
  if (!dialog || !handle) {
    throw new TypeError('attachConsoleBox requires a dialog and a handle');
  }

  const listeners = [];
  const listen = (target, type, callback, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, callback, options);
    listeners.push(() => target.removeEventListener(type, callback, options));
  };

  const viewport = () => {
    const visual = view.visualViewport;
    const style = view.getComputedStyle?.(dialog);
    const inset = (side) =>
      Math.max(
        0,
        Number.parseFloat(style?.getPropertyValue(`--agent-safe-${side}`)) || 0,
      );
    const viewportLeft = (visual?.offsetLeft || 0) + inset('left');
    const viewportTop = (visual?.offsetTop || 0) + inset('top');
    const right =
      (visual?.offsetLeft || 0) +
      (visual?.width || view.innerWidth || 0) -
      inset('right');
    let bottom =
      (visual?.offsetTop || 0) +
      (visual?.height || view.innerHeight || 0) -
      inset('bottom');
    if (root.body?.classList.contains('mobile-shell')) {
      // Read the actual shell rather than copying #1429's media gate or sizes.
      // Leave the idle voice controls usable alongside the non-modal console.
      for (const selector of [
        '#mobile-tab-bar',
        '#gev-voice-button',
        '.gev-voice-provider-field',
        '.gev-voice-settings-button',
      ]) {
        const el = root.querySelector?.(selector);
        if (
          !el?.getClientRects?.().length ||
          view.getComputedStyle?.(el).display === 'none'
        )
          continue;
        const rect = el.getBoundingClientRect();
        if (rect.top > viewportTop && rect.top < bottom) bottom = rect.top;
      }
    }
    return {
      viewportLeft,
      viewportTop,
      viewportWidth: Math.max(1, right - viewportLeft),
      viewportHeight: Math.max(1, bottom - viewportTop),
    };
  };

  let box = null;
  // Keep the user's intended window separate from temporary keyboard/rotation
  // clamps, so dismissing the keyboard restores it without overwriting storage.
  let preferredBox = null;
  let gesture = null;

  function paint() {
    if (!box) return;
    dialog.style.left = `${box.left}px`;
    dialog.style.top = `${box.top}px`;
    dialog.style.width = `${box.width}px`;
    dialog.style.height = `${box.height}px`;
    // The stylesheet anchors the closed window to a corner with `inset`; an
    // explicit position has to clear the other two edges or both would apply.
    dialog.style.right = 'auto';
    dialog.style.bottom = 'auto';
    dialog.style.maxHeight = 'none';
    dialog.style.minWidth = '0';
    dialog.style.minHeight = '0';
    dialog.style.margin = '0';
  }

  function setBox(next, { persist = true } = {}) {
    preferredBox = { ...next };
    box = clampBox(next, viewport());
    paint();
    if (persist) writeStoredBox(box, storage);
  }

  /** Place the window: the remembered one, clamped, else the default. */
  function apply() {
    const remembered = readStoredBox(storage);
    setBox(remembered ?? defaultBox(viewport()), { persist: false });
  }

  /** Forget the remembered window and return to the default placement. */
  function reset() {
    writeStoredBox(null, storage);
    setBox(defaultBox(viewport()), { persist: false });
  }

  function endGesture() {
    if (!gesture) return;
    dialog.classList.remove('agent-console-dragging', 'agent-console-resizing');
    try {
      gesture.target?.releasePointerCapture?.(gesture.pointerId);
    } catch {
      // The pointer may already be gone; releasing it is best effort.
    }
    gesture = null;
    if (box) {
      preferredBox = { ...box };
      writeStoredBox(box, storage);
    }
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (
      !gesture.active &&
      Math.abs(dx) < DRAG_THRESHOLD_PX &&
      Math.abs(dy) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    if (!gesture.active) {
      gesture.active = true;
      dialog.classList.add(
        gesture.dir ? 'agent-console-resizing' : 'agent-console-dragging',
      );
    }
    event.preventDefault?.();
    const { viewportWidth, viewportHeight, viewportLeft, viewportTop } =
      viewport();
    const next = gesture.dir
      ? resizeBox(gesture.origin, gesture.dir, dx, dy, {
          minWidth: CONSOLE_MIN_SIZE.width,
          minHeight: CONSOLE_MIN_SIZE.height,
          viewportWidth: viewportLeft + viewportWidth,
          viewportHeight: viewportTop + viewportHeight,
          margin: VIEWPORT_MARGIN_PX,
        })
      : {
          ...gesture.origin,
          left: gesture.origin.left + dx,
          top: gesture.origin.top + dy,
        };
    setBox(next, { persist: false });
  }

  function beginGesture(event, dir) {
    if (!box) apply();
    gesture = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      dir,
      active: false,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...box },
    };
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    } catch {
      // Without capture the window-level listeners still track the gesture.
    }
  }

  let lastPress = null;

  listen(handle, 'pointerdown', (event) => {
    if (!startsDrag(event)) return;
    event.preventDefault?.();
    const now = event.timeStamp ?? Date.now();
    if (
      lastPress &&
      now - lastPress.time <= DOUBLE_PRESS_MS &&
      Math.abs(event.clientX - lastPress.x) <= DOUBLE_PRESS_SLOP_PX &&
      Math.abs(event.clientY - lastPress.y) <= DOUBLE_PRESS_SLOP_PX
    ) {
      // Second press in the same spot: forget the moved window, the same
      // gesture the app's other floating panels use to snap back.
      lastPress = null;
      reset();
      return;
    }
    lastPress = { time: now, x: event.clientX, y: event.clientY };
    beginGesture(event, null);
  });

  const handles = [];
  for (const dir of RESIZE_DIRECTIONS) {
    const grip = root.createElement('div');
    grip.className = dir === 'se' ? 'agent-resize-grip' : 'agent-resize-edge';
    grip.dataset.dir = dir;
    grip.setAttribute('aria-hidden', 'true');
    if (dir === 'se') grip.title = t('Drag to resize');
    dialog.appendChild(grip);
    handles.push(grip);
    listen(grip, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      beginGesture(event, dir);
    });
  }

  listen(view, 'pointermove', onPointerMove);
  listen(view, 'pointerup', endGesture);
  listen(view, 'pointercancel', endGesture);
  // A viewport that shrinks must not strand the window off-screen with its
  // header unreachable, so the clamp runs again rather than only on open.
  const placeLauncher = () => {
    if (!chip) return;
    chip.style.bottom = '';
    if (
      !root.body?.classList.contains('mobile-shell') ||
      !chip.getClientRects().length
    )
      return;
    const rect = chip.getBoundingClientRect();
    const obstacles = [
      '#gev-voice-button',
      '.gev-voice-provider-field',
      '.gev-voice-settings-button',
      '#cesium-credits .cesium-credit-logoContainer',
      '#cesium-credits .cesium-credit-textContainer',
      '#cesium-credits .cesium-credit-expand-link',
    ]
      .map((selector) => root.querySelector(selector))
      .filter(
        (el) =>
          el?.getClientRects().length &&
          view.getComputedStyle(el).display !== 'none',
      )
      .map((el) => el.getBoundingClientRect());
    const bottom = clearLauncherObstacles(rect, obstacles);
    if (bottom !== rect.bottom)
      chip.style.bottom = `${view.innerHeight - bottom}px`;
  };
  const refit = () => {
    placeLauncher();
    for (const el of root.querySelectorAll?.('#cesium-credits img') ?? [])
      resize?.observe(el);
    if (preferredBox) {
      box = clampBox(preferredBox, viewport());
      paint();
    }
  };
  listen(view, 'resize', refit);
  listen(view.visualViewport, 'resize', refit);
  listen(view.visualViewport, 'scroll', refit);
  const observer =
    root.body && view.MutationObserver
      ? new view.MutationObserver(refit)
      : null;
  observer?.observe(root.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  for (const el of [
    root.getElementById?.('command-dock'),
    root.getElementById?.('loading-screen'),
  ]) {
    if (el)
      observer?.observe(el, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    listen(el, 'transitionend', refit);
    listen(el, 'animationend', refit);
  }
  const credits = root.getElementById?.('cesium-credits');
  if (credits) observer?.observe(credits, { childList: true, subtree: true });
  // Startup owners may finish positioning the dock after mounting COMMAND.
  const firstFrame = view.requestAnimationFrame?.(refit);

  const resize =
    chip && view.ResizeObserver ? new view.ResizeObserver(refit) : null;
  for (const el of [
    chip,
    root.getElementById?.('command-dock'),
    root.querySelector?.('#cesium-credits'),
    root.querySelector?.('#gev-voice-button'),
    root.querySelector?.('.gev-voice-provider-field'),
    root.querySelector?.('.gev-voice-settings-button'),
  ]) {
    if (el) resize?.observe(el);
  }
  placeLauncher();

  return {
    apply,
    reset,
    refresh: refit,
    /** The current window, for tests and the pop-out. */
    get box() {
      return box ? { ...box } : null;
    },
    destroy() {
      endGesture();
      if (firstFrame != null) view.cancelAnimationFrame?.(firstFrame);
      observer?.disconnect();
      resize?.disconnect();
      if (chip) chip.style.bottom = '';
      for (const remove of listeners.splice(0)) remove();
      for (const grip of handles.splice(0)) grip.remove?.();
    },
  };
}

export {
  CONSOLE_BOX_STORAGE_KEY,
  DOUBLE_PRESS_MS,
  DOUBLE_PRESS_SLOP_PX,
  CONSOLE_DEFAULT_SIZE,
  CONSOLE_MIN_SIZE,
  DEFAULT_BOTTOM_CLEARANCE_PX,
  DRAG_THRESHOLD_PX,
  VIEWPORT_MARGIN_PX,
  attachConsoleBox,
  clampBox,
  clearLauncherObstacles,
  defaultBox,
  readStoredBox,
  startsDrag,
  writeStoredBox,
};
