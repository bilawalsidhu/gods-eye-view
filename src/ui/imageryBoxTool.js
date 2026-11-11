/**
 * Box selection for the Recent Imagery layer: press on the world, drag, and
 * release to hand the layer a degrees box. Follows the draw tool's ownership
 * rules — the pointer is claimed for the session and `destroy()` returns
 * everything — and freezes the camera only while a drag is in progress.
 *
 * The same on every engine: the tool takes the pointer events of the
 * engine's canvas in the capture phase, ahead of the engine's own handlers,
 * so a press that starts a box and the drag it makes reach neither the
 * camera nor any click (a layer's, or Cesium's stock select and track).
 * Moves outside a drag pass through. The layer draws the preview
 * (`onPreview`, a ground cell on engine.ground).
 */
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';
import { validateBox } from '../layers/recentImagery/model.js';
import { msg } from '../i18n/index.js';

/** The id this tool claims the pointer under. */
export const IMAGERY_BOX_POINTER_OWNER = 'recent-imagery-box';

/**
 * Wire the box tool.
 * @param {{ engine: import('../globe/contract.js').GlobeEngine,
 *   onBox: (box: object) => void, onPreview?: (box: object | null) => void,
 *   onCancel?: (reason: string, message?: string, box?: object) => void,
 *   onActive?: (active: boolean) => void, onEscape?: () => boolean,
 *   pickWorld?: Function, documentRef?: object }} deps
 *   `onPreview` gets the box being dragged, and null once the drag ends.
 *   `onEscape` runs before the tool cancels on Escape; returning `true`
 *   claims the key (it is still consumed) and leaves the tool armed.
 * @returns {{ start: () => boolean, cancel: (reason?: string) => void, isActive: () => boolean, destroy: () => void } | null}
 */
export function initImageryBoxTool({
  engine,
  onBox,
  onPreview = () => {},
  onCancel,
  onActive,
  onEscape,
  pickWorld = pickWorldFromScreen,
  documentRef = globalThis.document,
} = {}) {
  const canvas = engine?.host?.canvas;
  if (!canvas || typeof onBox !== 'function') return null;

  let active = false;
  let destroyed = false;
  /** Drag corners in degrees; `anchor` is null while no drag is live. */
  let anchor = null;
  let corner = null;
  let lease = null;
  let thaw = null;
  let pointerId = null;

  const dragBox = () =>
    anchor && {
      west: Math.min(anchor.lon, corner.lon),
      south: Math.min(anchor.lat, corner.lat),
      east: Math.max(anchor.lon, corner.lon),
      north: Math.max(anchor.lat, corner.lat),
    };
  const worldAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const { width, height } = engine.host.size();
    const point = pickWorld(
      engine,
      (event.clientX - rect.left) / (width || 1),
      (event.clientY - rect.top) / (height || 1),
    );
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  };
  const consume = (event) => {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };

  function endDrag() {
    anchor = null;
    corner = null;
    if (pointerId !== null && canvas.hasPointerCapture?.(pointerId))
      canvas.releasePointerCapture(pointerId);
    pointerId = null;
    thaw?.();
    thaw = null;
    onPreview(null);
  }

  function down(event) {
    if (
      !active ||
      anchor ||
      event.button !== 0 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    consume(event);
    const point = worldAt(event);
    if (!point) {
      onCancel?.('sky', msg('Press on the ground, not the sky'));
      return;
    }
    anchor = point;
    corner = point;
    pointerId = event.pointerId;
    // The engine counts suspensions: the camera inputs are back as they
    // were once the drag ends.
    thaw = engine.input.suspendCameraInputs();
    canvas.setPointerCapture?.(pointerId);
    onPreview(dragBox());
  }
  function move(event) {
    if (!anchor || event.pointerId !== pointerId) return;
    consume(event);
    corner = worldAt(event) || corner;
    onPreview(dragBox());
  }
  function up(event) {
    if (!anchor || event.pointerId !== pointerId) return;
    consume(event);
    corner = worldAt(event) || corner;
    const box = dragBox();
    const result = validateBox(box);
    if (result.reason === 'degenerate')
      result.message = msg('Drag to size the box');
    stop();
    if (result.ok) onBox(result.box);
    else onCancel?.(result.reason, result.message, box);
  }
  // Escape is taken from a document capture listener, ahead of every other
  // handler, so the interceptor runs first: when it claims the key (the
  // panel exits a live comparison), the tool stays armed and the key still
  // goes no further; otherwise Escape cancels the session.
  function key(event) {
    if (!active || event.key !== 'Escape') return;
    consume(event);
    if (onEscape?.() !== true) cancel('escape');
  }
  // A drag the browser takes away (a touch turned into a scroll, the window
  // losing focus) ends the session and gives the camera back.
  function pointerCancel(event) {
    if (anchor && event.pointerId === pointerId) cancel('pointer-cancel');
  }
  const bindings = [
    [canvas, 'pointerdown', down],
    [documentRef, 'pointermove', move],
    [documentRef, 'pointerup', up],
    [documentRef, 'pointercancel', pointerCancel],
    [documentRef, 'keydown', key],
  ];
  if (documentRef?.defaultView)
    bindings.push([documentRef.defaultView, 'blur', () => cancel('blur')]);

  function stop() {
    if (!active) return;
    for (const [target, type, listener] of bindings)
      target?.removeEventListener?.(type, listener, true);
    endDrag();
    releasePointer(lease);
    lease = null;
    active = false;
    documentRef?.body?.classList?.remove?.('gev-imagery-box');
    onActive?.(false);
  }

  function cancel(reason = 'cancel') {
    if (!active || destroyed) return;
    stop();
    onCancel?.(reason);
  }

  return {
    /** Begin a box session. False when the pointer is held elsewhere. */
    start() {
      if (destroyed) return false;
      if (active) return true;
      lease = claimPointer(IMAGERY_BOX_POINTER_OWNER);
      if (!lease) {
        onCancel?.(
          'pointer-busy',
          `${pointerOwner()} is using the pointer — close it first`,
        );
        return false;
      }
      active = true;
      for (const [target, type, listener] of bindings)
        target?.addEventListener?.(type, listener, true);
      documentRef?.body?.classList?.add?.('gev-imagery-box');
      onActive?.(true);
      return true;
    },
    cancel,
    isActive: () => active,
    /** Returns the pointer, the camera and every listener. */
    destroy() {
      if (destroyed) return;
      stop();
      destroyed = true;
    },
  };
}
