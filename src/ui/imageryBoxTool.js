/**
 * Box selection for the Recent Imagery layer: press on the world, drag, and
 * release to hand the layer a degrees box. Follows the draw tool's ownership
 * rules — the pointer is claimed for the session (a newer claim cancels it),
 * the viewer's own click actions are suppressed and given back, and
 * `destroy()` returns everything — and holds the camera only while a drag is
 * in progress.
 */
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import { inputFor as defaultInputFor } from '../input/dispatcher.js';
import { validateBox } from '../layers/recentImagery/model.js';
import { createImageryBoxPreview } from '../layers/recentImagery/rendering.js';
import { msg } from '../i18n/index.js';
import { canvasOf } from '../render/rendererOf.js';

/** The id this tool claims the pointer under. */
export const IMAGERY_BOX_POINTER_OWNER = 'recent-imagery-box';

/**
 * Wire the box tool.
 * @param {{ viewer: object, onBox: (box: object) => void, onCancel?: (reason: string, message?: string, box?: object) => void, onActive?: (active: boolean) => void, onEscape?: () => boolean, createPreview?: Function, inputFor?: Function, pickWorld?: Function, documentRef?: object }} deps
 *   `onEscape` runs before the tool cancels on Escape; returning `true` claims
 *   the key (it is still consumed) and leaves the tool armed.
 *   `createPreview(viewer, dragBox)` draws the box being dragged
 *   (`createImageryBoxPreview`).
 * @returns {{ start: () => boolean, cancel: (reason?: string) => void, isActive: () => boolean, destroy: () => Promise<void> } | null}
 */
export function initImageryBoxTool({
  viewer,
  onBox,
  onCancel,
  onActive,
  onEscape,
  createPreview = createImageryBoxPreview,
  inputFor = defaultInputFor,
  pickWorld = pickWorldFromScreen,
  documentRef = globalThis.document,
} = {}) {
  if (!viewer || typeof onBox !== 'function') return null;

  let active = false;
  let destroyed = false;
  /** Drag corners in degrees; `anchor` is null while no drag is live. */
  let anchor = null;
  let corner = null;
  let unbindScene = null;
  let lease = null;
  let releaseCamera = null;

  const dragBox = () =>
    anchor && {
      west: Math.min(anchor.lon, corner.lon),
      south: Math.min(anchor.lat, corner.lat),
      east: Math.max(anchor.lon, corner.lon),
      north: Math.max(anchor.lat, corner.lat),
    };

  const preview = createPreview(viewer, dragBox);
  const setPreview = (visible) => preview.setVisible(visible);
  const worldAt = (position) => {
    if (!position) return null;
    const canvas = canvasOf(viewer);
    const w = canvas?.clientWidth || canvas?.width || 1;
    const h = canvas?.clientHeight || canvas?.height || 1;
    const point = pickWorld(viewer, position.x / w, position.y / h);
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  };

  function freezeCamera() {
    releaseCamera ??= inputFor(viewer).suspendCamera('recent-imagery-box');
  }
  function thawCamera() {
    releaseCamera?.();
    releaseCamera = null;
  }

  function endDrag() {
    anchor = null;
    corner = null;
    thawCamera();
    setPreview(false);
  }

  const onDown = (event) => {
    if (!active || destroyed || anchor) return;
    const point = worldAt(event.position);
    if (!point) {
      onCancel?.('sky', msg('Press on the ground, not the sky'));
      return;
    }
    anchor = point;
    corner = point;
    freezeCamera();
    setPreview(true);
  };
  const onMove = (event) => {
    const point = anchor && !destroyed && worldAt(event.endPosition);
    if (!point) return;
    corner = point;
    preview.changed();
  };
  const onUp = (event) => {
    if (!anchor || destroyed) return;
    corner = worldAt(event.position) || corner;
    const box = dragBox();
    const result = validateBox(box);
    if (result.reason === 'degenerate')
      result.message = msg('Drag to size the box');
    endDrag();
    setActive(false);
    if (result.ok) onBox(result.box);
    else onCancel?.(result.reason, result.message, box);
  };
  // Escape is taken from a document capture listener, ahead of every other
  // handler, so the interceptor runs first: when it claims the key (the
  // panel exits a live comparison), the tool stays armed and the key still
  // goes no further; otherwise Escape cancels the session.
  const onKey = (event) => {
    if (!active || destroyed || event.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    if (onEscape?.() === true) return;
    cancel('escape');
  };

  function bindScene() {
    if (unbindScene) return;
    const input = inputFor(viewer);
    const held = { lease: () => lease };
    const offs = [
      input.onPointer('down', onDown, held),
      input.onPointer('move', onMove, held),
      input.onPointer('up', onUp, held),
      input.suppressStockClicks(),
    ];
    unbindScene = () => offs.forEach((off) => off());
    documentRef?.addEventListener?.('keydown', onKey, true);
    documentRef?.body?.classList?.add?.('gev-imagery-box');
  }

  function releaseScene() {
    unbindScene?.();
    unbindScene = null;
    documentRef?.removeEventListener?.('keydown', onKey, true);
    documentRef?.body?.classList?.remove?.('gev-imagery-box');
  }

  function setActive(next) {
    if (next === active) return active;
    if (next) {
      // The newest claim takes over: a tool holding the pointer is told and
      // turns itself off, and a newer one cancels this session as if the
      // person had.
      const claimed = claimPointer(IMAGERY_BOX_POINTER_OWNER, {
        onLost: () => {
          if (lease === claimed) cancel();
        },
      });
      if (!claimed) return active;
      lease = claimed;
      active = true;
      bindScene();
    } else {
      if (anchor) endDrag();
      releaseScene();
      releasePointer(lease);
      lease = null;
      active = false;
    }
    onActive?.(active);
    return active;
  }

  function cancel(reason = 'cancel') {
    if (!active || destroyed) return;
    setActive(false);
    onCancel?.(reason);
  }

  return {
    /** Begin a box session, taking the pointer from any tool holding it. */
    start() {
      return !destroyed && setActive(true);
    },
    cancel,
    isActive() {
      return active;
    },
    /** Returns everything; resolves once the preview is detached. */
    destroy() {
      if (destroyed) return preview.destroy();
      if (active) setActive(false);
      destroyed = true;
      releaseScene();
      releasePointer(lease);
      lease = null;
      thawCamera();
      return preview.destroy();
    },
  };
}
