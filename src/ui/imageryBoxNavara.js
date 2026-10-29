import * as geo from '../geo/index.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';
import { validateBox } from '../layers/recentImagery/model.js';

/** Native DOM capture keeps a box drag out of Navara's camera controller. */
export function initNavaraImageryBoxTool({
  engine,
  onBox,
  onPreview,
  onCancel,
  onActive,
  onEscape,
  documentRef = globalThis.document,
}) {
  const canvas = engine.host.canvas;
  let active = false,
    destroyed = false,
    anchor = null,
    corner = null;
  let lease = null,
    thaw = null,
    pointerId = null;
  const box = () =>
    anchor && {
      west: Math.min(anchor.lon, corner.lon),
      east: Math.max(anchor.lon, corner.lon),
      south: Math.min(anchor.lat, corner.lat),
      north: Math.max(anchor.lat, corner.lat),
    };
  function point(event) {
    const rect = canvas.getBoundingClientRect(),
      at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const hit = engine.picker.pickPosition(at) || engine.picker.pickGlobe(at);
    const c = hit && geo.cartographic.fromCartesian(hit, geo.ellipsoid.WGS84);
    return c
      ? {
          lon: (c.longitude * 180) / Math.PI,
          lat: (c.latitude * 180) / Math.PI,
        }
      : null;
  }
  const consume = (event) => {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };
  function endDrag() {
    anchor = corner = null;
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
    const p = point(event);
    if (!p) {
      onCancel?.('sky', 'Press on the ground, not the sky');
      return;
    }
    anchor = corner = p;
    pointerId = event.pointerId;
    thaw = engine.input.suspendCameraInputs();
    canvas.setPointerCapture?.(pointerId);
    onPreview(box());
  }
  function move(event) {
    if (!anchor || event.pointerId !== pointerId) return;
    consume(event);
    corner = point(event) || corner;
    onPreview(box());
  }
  function up(event) {
    if (!anchor || event.pointerId !== pointerId) return;
    consume(event);
    corner = point(event) || corner;
    const selected = box(),
      result = validateBox(selected);
    if (result.reason === 'degenerate') result.message = 'Drag to size the box';
    stop();
    if (result.ok) onBox(result.box);
    else onCancel?.(result.reason, result.message, selected);
  }
  function key(event) {
    if (!active || event.key !== 'Escape') return;
    consume(event);
    if (onEscape?.() !== true) cancel('escape');
  }
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
  if (documentRef.defaultView)
    bindings.push([documentRef.defaultView, 'blur', () => cancel('blur')]);
  function stop() {
    if (!active) return;
    for (const [target, type, listener] of bindings)
      target.removeEventListener(type, listener, true);
    endDrag();
    releasePointer(lease);
    lease = null;
    active = false;
    documentRef.body?.classList.remove('gev-imagery-box');
    onActive?.(false);
  }
  function cancel(reason = 'cancel') {
    if (active) {
      stop();
      onCancel?.(reason);
    }
  }
  return {
    start() {
      if (destroyed) return false;
      if (active) return true;
      lease = claimPointer('recent-imagery-box');
      if (!lease) {
        onCancel?.(
          'pointer-busy',
          `${pointerOwner()} is using the pointer — close it first`,
        );
        return false;
      }
      active = true;
      for (const [target, type, listener] of bindings)
        target.addEventListener(type, listener, true);
      documentRef.body?.classList.add('gev-imagery-box');
      onActive?.(true);
      return true;
    },
    cancel,
    isActive: () => active,
    destroy() {
      if (destroyed) return;
      stop();
      destroyed = true;
    },
  };
}
