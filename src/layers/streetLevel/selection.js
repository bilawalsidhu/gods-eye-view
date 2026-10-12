import * as Cesium from 'cesium';
import { STREET_LEVEL_LAYER_ID } from './policy.js';

/** Hover picks at most ~8 times a second (like the CCTV layer), never per frame. */
const HOVER_PICK_INTERVAL_MS = 120;

/** One click/hover handler for every provider's coverage and image cones. */
export function createSelection({ state, parts }) {
  const { picking, input } = state.services;

  function ownsPick(pickedId) {
    return parts.router.ownsPick(pickedId);
  }

  function onClick(click) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled) return;
    if (input?.isPointerFree && !input.isPointerFree()) return;
    const picked = viewer.scene.pick(click.position);
    const id = picking?.resolvePickId
      ? picking.resolvePickId(picked)
      : picked?.id;
    const route = parts.router.resolve(id);
    if (!route?.instance) return;
    const entry = state.providers.get(route.providerId);
    if (!entry?.on) return;
    route.instance.handlePick(route.id);
  }

  /**
   * Esc clears the selected sequence, but only once nothing closer to the
   * user wants it: an expanded viewer, an open panel or a text field.
   */
  function onKeyDown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // A text field keeps its Esc, rich-text editors (contenteditable) included.
    const target = event.target;
    if (
      target?.isContentEditable === true ||
      target?.closest?.(
        '.panel-collapsible, [role="dialog"], input, textarea, select',
      )
    )
      return;
    if (!parts.hasSelectedSequence()) return;
    event.preventDefault();
    parts.clearSequences();
  }

  let hoverQueued = false;
  let hoverCursor = false;
  let hoverPosition = null;
  let hoverLastPickAt = -Infinity;
  let hoverTimer = null;
  let pointerButtons = 0;
  let removeHoverWatchers = null;

  function setHoverCursor(canvas, hit) {
    if (hit && !hoverCursor) {
      canvas.style.cursor = 'pointer';
      hoverCursor = true;
    } else if (!hit && hoverCursor) {
      canvas.style.cursor = '';
      hoverCursor = false;
    }
  }

  function pickHover() {
    hoverQueued = false;
    const viewer = state.viewer;
    // Switched off (or torn down) since the frame was queued.
    if (!viewer || !state.enabled || !state.clickHandler) return;
    // A drag in progress: the pointer is the camera's.
    if (pointerButtons !== 0) return;
    const canvas = viewer.scene?.canvas;
    if (!canvas || viewer.isDestroyed?.()) return;
    hoverLastPickAt = Date.now();
    let hit = false;
    try {
      const picked = viewer.scene.pick(hoverPosition);
      const id = picking?.resolvePickId
        ? picking.resolvePickId(picked)
        : picked?.id;
      hit = ownsPick(id);
    } catch {
      hit = false;
    }
    setHoverCursor(canvas, hit);
  }

  /**
   * Pointer cursor over anything this layer owns. Throttled; a move inside
   * the interval is picked when it ends, so the cursor never sticks.
   */
  function onMove(movement) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled) return;
    hoverPosition = movement.endPosition;
    queueHoverPick();
  }

  /** Pick `hoverPosition` on a coming frame, within the throttle. */
  function queueHoverPick() {
    if (hoverQueued) return;
    hoverQueued = true;
    const wait = hoverLastPickAt + HOVER_PICK_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      requestAnimationFrame(pickHover);
      return;
    }
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      requestAnimationFrame(pickHover);
    }, wait);
  }

  /**
   * Track held buttons (a drag picks nothing) and re-pick when the camera
   * rests. Hover keeps running while it moves: a tracking camera never stops.
   */
  function watchHover(viewer) {
    const canvas = viewer.scene.canvas;
    const camera = viewer.camera;
    const onButtons = (event) => {
      pointerButtons = event.buttons ?? 0;
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup'])
      canvas.addEventListener?.(type, onButtons);
    const removeEnd = camera?.moveEnd?.addEventListener(() => {
      if (hoverPosition) queueHoverPick();
    });
    removeHoverWatchers = () => {
      for (const type of ['pointerdown', 'pointermove', 'pointerup'])
        canvas.removeEventListener?.(type, onButtons);
      removeEnd?.();
    };
  }

  function unwatchHover() {
    removeHoverWatchers?.();
    removeHoverWatchers = null;
    clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverQueued = false;
    hoverPosition = null;
    hoverLastPickAt = -Infinity;
    pointerButtons = 0;
  }

  function install(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state.clickHandler.setInputAction(
      onClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    state.clickHandler.setInputAction(
      onMove,
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );
    watchHover(viewer);
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(STREET_LEVEL_LAYER_ID, ownsPick);
  }

  function uninstall() {
    // Nothing to undo for a layer that was never enabled.
    if (!state.clickHandler) return;
    unwatchHover();
    if (hoverCursor && state.viewer?.scene?.canvas) {
      state.viewer.scene.canvas.style.cursor = '';
      hoverCursor = false;
    }
    if (state.clickHandler && !state.clickHandler.isDestroyed())
      state.clickHandler.destroy();
    state.clickHandler = null;
    document.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner?.(STREET_LEVEL_LAYER_ID);
  }

  return { install, uninstall, ownsPick };
}
